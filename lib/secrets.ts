/**
 * Pure secrets helpers: response redaction and startup lint.
 *
 * No process.env access and no I/O here — callers pass env maps, file
 * contents and git status in.
 */

export const REDACTED = "[REDACTED]";

/** Env vars whose values are secrets and must never reach a client or log. */
export const SECRET_ENV_VARS = [
  "SEGMENT_PUBLIC_API_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
] as const;

/** Known secrets shorter than this are ignored to avoid shredding normal text. */
const MIN_KNOWN_SECRET_LENGTH = 8;

/**
 * Generic token shapes. Deliberately conservative: Segment plan IDs (`rs_...`),
 * event names and branch names must survive untouched.
 */
const TOKEN_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // Authorization header values. Keep the scheme so the output stays readable.
  { re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: `$1 ${REDACTED}` },
  // GitHub fine-grained PATs.
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  // GitHub classic PAT / OAuth / user-to-server / server-to-server / refresh.
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  // Segment Public API tokens.
  { re: /\bsgp_[A-Za-z0-9]{20,}/g, replace: REDACTED },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactString(s: string, known: string[]): string {
  let out = s;
  for (const secret of known) {
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  for (const { re, replace } of TOKEN_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/** Returns true if the string contains a known secret or a token-shaped value. */
export function containsSecret(s: string, knownSecrets: string[] = []): boolean {
  return redactString(s, normalizeKnown(knownSecrets)) !== s;
}

function normalizeKnown(knownSecrets: string[]): string[] {
  // Longest first so a secret that contains another is fully replaced.
  return [...new Set(knownSecrets)]
    .filter((k) => typeof k === "string" && k.length >= MIN_KNOWN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
}

/**
 * Deep-walks `value` and returns a copy with every known secret and every
 * token-shaped substring replaced by `[REDACTED]`. Object keys are redacted
 * too. Input is never mutated; cycles are preserved.
 */
export function redactSecrets<T>(value: T, knownSecrets: string[] = []): T {
  const known = normalizeKnown(knownSecrets);
  const seen = new WeakMap<object, unknown>();

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactString(v, known);
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return seen.get(v);
    // Mirror JSON.stringify: objects with toJSON (e.g. Date) serialize via it.
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function" && !Array.isArray(v)) {
      const out = walk(toJSON.call(v));
      seen.set(v, out);
      return out;
    }
    if (Array.isArray(v)) {
      const arr: unknown[] = [];
      seen.set(v, arr);
      for (const item of v) arr.push(walk(item));
      return arr;
    }
    if (v instanceof Error) {
      const copy = new Error(redactString(v.message, known));
      copy.name = v.name;
      seen.set(v, copy);
      return copy;
    }
    const out: Record<string, unknown> = {};
    seen.set(v, out);
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
      out[redactString(k, known)] = walk(inner);
    }
    return out;
  };

  return walk(value) as T;
}

/** Extracts the values of secret env vars that are set (non-empty). */
export function knownSecretsFromEnv(
  env: Record<string, string | undefined>,
): string[] {
  return SECRET_ENV_VARS.map((k) => env[k]).filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

// ---------------------------------------------------------------------------
// Startup lint
// ---------------------------------------------------------------------------

export type EnvFileGitStatus = "tracked" | "untracked" | "ignored" | "unknown";

export interface EnvFileInfo {
  /** Path relative to REPO_PATH, used only for display. */
  path: string;
  contents: string;
  gitStatus: EnvFileGitStatus;
}

export interface SecretsLintInput {
  /** `.env*` files found in REPO_PATH. */
  envFiles: EnvFileInfo[];
  /** Raw contents of `.tracking-plans-mcp.json`, if present. */
  mcpConfigRaw?: string;
  /** Actual secret values from the process env (see knownSecretsFromEnv). */
  knownSecrets: string[];
}

/** Returns the secret env var names assigned a non-empty value in a dotenv file. */
function secretKeysAssigned(contents: string): string[] {
  const found: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
    if ((SECRET_ENV_VARS as readonly string[]).includes(key) && value.length > 0) {
      found.push(key);
    }
  }
  return [...new Set(found)];
}

/**
 * Detects common secrets mistakes. Returns human-readable warnings that never
 * include secret values.
 */
export function lintSecrets(input: SecretsLintInput): string[] {
  const warnings: string[] = [];

  for (const f of input.envFiles) {
    const keys = secretKeysAssigned(f.contents);
    if (keys.length === 0) continue;
    const keyList = keys.join(", ");
    if (f.gitStatus === "tracked") {
      warnings.push(
        `${f.path} is tracked by git and sets ${keyList}. The token is committed to the repo: ` +
          `rotate it, run \`git rm --cached ${f.path}\`, and add it to .gitignore.`,
      );
    } else if (f.gitStatus === "untracked") {
      warnings.push(
        `${f.path} sets ${keyList} but is not covered by .gitignore. ` +
          `Add it to .gitignore so the token cannot be committed by accident.`,
      );
    }
  }

  if (input.mcpConfigRaw !== undefined && containsSecret(input.mcpConfigRaw, input.knownSecrets)) {
    warnings.push(
      `.tracking-plans-mcp.json appears to contain a token. This file is meant to be checked in: ` +
        `remove the token (pass it via the MCP client env instead) and rotate it if it was committed.`,
    );
  }

  return warnings;
}
