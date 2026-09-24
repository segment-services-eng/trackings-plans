/**
 * Startup secrets lint — I/O side. Collects `.env*` files and the project
 * config from REPO_PATH, classifies git status, and delegates the decision to
 * the pure `lintSecrets` in lib/secrets.ts. Run once at server start.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MCP_CONFIG_FILENAME } from "../lib/mcp-config.js";
import {
  EnvFileGitStatus,
  knownSecretsFromEnv,
  lintSecrets,
  SecretsLintInput,
} from "../lib/secrets.js";

const ENV_FILE_RE = /^\.env(\..+)?$/;
// Templates are expected to be committed and hold placeholders.
const TEMPLATE_RE = /\.(example|sample|template|dist)$/;

function gitStatusOf(repoPath: string, file: string): EnvFileGitStatus {
  const run = (args: string[]): boolean => {
    try {
      execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (!run(["rev-parse", "--is-inside-work-tree"])) return "unknown";
  if (run(["ls-files", "--error-unmatch", "--", file])) return "tracked";
  if (run(["check-ignore", "-q", "--", file])) return "ignored";
  return "untracked";
}

export function collectSecretsLintInput(
  repoPath: string,
  env: Record<string, string | undefined>,
): SecretsLintInput {
  let names: string[] = [];
  try {
    names = readdirSync(repoPath);
  } catch {
    names = [];
  }
  const envFiles = names
    .filter((n) => ENV_FILE_RE.test(n) && !TEMPLATE_RE.test(n))
    .filter((n) => {
      try {
        return statSync(join(repoPath, n)).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .map((n) => ({
      path: n,
      contents: readFileSync(join(repoPath, n), "utf8"),
      gitStatus: gitStatusOf(repoPath, n),
    }));

  const cfgPath = join(repoPath, MCP_CONFIG_FILENAME);
  const mcpConfigRaw = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : undefined;

  return { envFiles, mcpConfigRaw, knownSecrets: knownSecretsFromEnv(env) };
}

/** Returns warnings; never throws (a lint must not block startup). */
export function runStartupSecretsLint(
  repoPath: string,
  env: Record<string, string | undefined>,
): string[] {
  try {
    return lintSecrets(collectSecretsLintInput(repoPath, env));
  } catch (e) {
    return [`secrets lint skipped: ${(e as Error).message}`];
  }
}
