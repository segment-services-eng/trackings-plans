/**
 * Pure parsing / merging for the project-level `.tracking-plans-mcp.json`.
 *
 * Precedence (highest wins):
 *   tool args > env vars > .tracking-plans-mcp.json
 *     > config/tracking-plans-config.json > built-in defaults
 *
 * This module never reads files or process.env; callers pass contents in.
 */
import { z } from "zod";
import { containsSecret } from "./secrets.js";

export const MCP_CONFIG_FILENAME = ".tracking-plans-mcp.json";

export const WRITE_MODES = ["files", "branch", "pr"] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

export const DEFAULT_WRITE_MODE: WriteMode = "branch";

export const mcpConfigSchema = z
  .object({
    $schema: z.string().optional(),
    write_mode: z
      .enum(WRITE_MODES, {
        // Custom message so a bad value is never echoed back (it could be a token).
        errorMap: () => ({ message: `must be one of ${WRITE_MODES.join(", ")}` }),
      })
      .optional(),
    default_branch: z
      .string()
      .regex(/^[A-Za-z0-9._\/-]+$/, "must be a valid branch name")
      .optional(),
    forge: z.enum(["github"]).optional(),
  })
  .strict();

export const DEFAULT_BRANCH = "main";

export type McpConfig = z.infer<typeof mcpConfigSchema>;

export class McpConfigError extends Error {
  readonly code = "CONFIG" as const;
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

const SECRET_KEY_RE = /token|secret|password|passwd|api_?key|plan_?id|credential/i;
const PLAN_ID_VALUE_RE = /^rs_[A-Za-z0-9]+$/;

/** Collects dotted paths to secret-looking keys or values. Never returns values. */
function findSecretPaths(v: unknown, path: string, out: string[]): void {
  if (typeof v === "string") {
    if (PLAN_ID_VALUE_RE.test(v) || containsSecret(v)) out.push(path || "(root)");
    return;
  }
  if (v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    v.forEach((item, i) => findSecretPaths(item, `${path}[${i}]`, out));
    return;
  }
  for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (SECRET_KEY_RE.test(k)) {
      out.push(p);
      continue;
    }
    findSecretPaths(inner, p, out);
  }
}

/**
 * Parses and validates the raw contents of `.tracking-plans-mcp.json`.
 * Throws McpConfigError (code CONFIG) with a message naming `sourcePath`.
 * Rejects secrets (tokens, plan IDs) without echoing their values.
 */
export function parseMcpConfig(raw: string, sourcePath: string): McpConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new McpConfigError(
      `Invalid ${MCP_CONFIG_FILENAME} at ${sourcePath}: not valid JSON (${(e as Error).message}).`,
    );
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new McpConfigError(
      `Invalid ${MCP_CONFIG_FILENAME} at ${sourcePath}: top level must be a JSON object.`,
    );
  }

  const secretPaths: string[] = [];
  findSecretPaths(data, "", secretPaths);
  if (secretPaths.length > 0) {
    throw new McpConfigError(
      `${MCP_CONFIG_FILENAME} at ${sourcePath} must not contain secrets ` +
        `(found at: ${secretPaths.join(", ")}). This file is meant to be checked in. ` +
        `Put SEGMENT_PUBLIC_API_TOKEN and *_SEGMENT_TRACKING_PLAN_ID_* in the MCP client env instead.`,
    );
  }

  const parsed = mcpConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const p = i.path.join(".") || "(root)";
      if (i.code === "unrecognized_keys") {
        return `unknown key(s) ${i.keys.join(", ")} (allowed: $schema, write_mode)`;
      }
      return `${p}: ${i.message}`;
    });
    throw new McpConfigError(
      `Invalid ${MCP_CONFIG_FILENAME} at ${sourcePath}: ${issues.join("; ")}.`,
    );
  }
  return parsed.data;
}

export function isWriteMode(v: unknown): v is WriteMode {
  return typeof v === "string" && (WRITE_MODES as readonly string[]).includes(v);
}

export type SettingSource = "env" | "file" | "default";

/**
 * Resolves the default write mode: env (MCP_WRITE_MODE) > file > built-in.
 * An invalid env value is ignored (falls through), matching M2 behavior.
 * Tool args are applied later, per call, on top of this.
 */
export function resolveWriteModeSetting(input: {
  env: Record<string, string | undefined>;
  file: McpConfig | undefined;
}): { mode: WriteMode; source: SettingSource } {
  const envMode = input.env.MCP_WRITE_MODE;
  if (isWriteMode(envMode)) return { mode: envMode, source: "env" };
  if (input.file?.write_mode) return { mode: input.file.write_mode, source: "file" };
  return { mode: DEFAULT_WRITE_MODE, source: "default" };
}
