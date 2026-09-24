import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSegmentClient, SegmentClient } from "../lib/segment-api.js";
import {
  loadPlansConfig,
  PlanConfig,
  resolvePlan,
  getPlanIdEnvVar,
} from "../lib/plans-config.js";
import { assertCleanTree, GitOpsError } from "../lib/git-ops.js";
import {
  isWriteMode,
  MCP_CONFIG_FILENAME,
  McpConfig,
  parseMcpConfig,
  resolveWriteModeSetting,
  WriteMode,
} from "../lib/mcp-config.js";
import { DEFAULT_BRANCH } from "../lib/mcp-config.js";
import type { ForgeClient } from "../lib/forge.js";
import { createGitHubForge } from "../lib/forge-github.js";
import type { ToolResultError } from "./tools/result.js";

export type { WriteMode } from "../lib/mcp-config.js";

export interface ServerContext {
  repoPath: string;
  env: Record<string, string | undefined>;
  plans: PlanConfig[];
  segmentApiKey?: string;
  planIdEnv: (planPath: string, env: "dev" | "prod") => string | undefined;
  resolvePlanOrThrow: (nameOrPath: string) => PlanConfig;
  segmentClient: () => SegmentClient;
  /** Parsed `.tracking-plans-mcp.json`, or undefined when the file is absent. */
  projectConfig?: McpConfig;
  /** Branch tp/… branches are based on and PRs target (`default_branch`, default "main"). */
  defaultBranch: string;
  /** Git-host client for PRs and workflow dispatch. Tests inject a fake. */
  forge: ForgeClient;
  defaultWriteMode: WriteMode;
  resolveWriteMode: (argMode?: string) => WriteMode;
  preflightWrite: (
    mode: WriteMode,
  ) => { blocked: false } | { blocked: true; error: ToolResultError };
}

function parseMode(raw: string | undefined, fallback: WriteMode): WriteMode {
  return isWriteMode(raw) ? raw : fallback;
}

/**
 * Reads and validates `.tracking-plans-mcp.json` from the repo root.
 * Returns undefined when absent; throws McpConfigError (code CONFIG) when invalid.
 */
export function loadProjectConfig(repoPath: string): McpConfig | undefined {
  const path = join(repoPath, MCP_CONFIG_FILENAME);
  if (!existsSync(path)) return undefined;
  return parseMcpConfig(readFileSync(path, "utf8"), path);
}

export interface ResolveContextOptions {
  /** Override the git-host client (tests). Defaults to the GitHub forge. */
  forge?: ForgeClient;
}

export function resolveContext(
  env: Record<string, string | undefined> = process.env,
  opts: ResolveContextOptions = {},
): ServerContext {
  const repoPath = resolve(env.REPO_PATH ?? process.cwd());
  const segmentApiKey = env.SEGMENT_PUBLIC_API_TOKEN;
  // Precedence: tool args (resolveWriteMode) > env > .tracking-plans-mcp.json > default.
  const projectConfig = loadProjectConfig(repoPath);
  const defaultWriteMode = resolveWriteModeSetting({ env, file: projectConfig }).mode;
  const defaultBranch = projectConfig?.default_branch ?? DEFAULT_BRANCH;
  const forge =
    opts.forge ?? createGitHubForge({ repoPath, token: env.GITHUB_TOKEN ?? env.GH_TOKEN });

  // Lazy-load plans so resolveContext can be called even when the config is
  // temporarily invalid (e.g. dirty working tree during preflight checks).
  let _plans: PlanConfig[] | undefined;
  const getPlans = (): PlanConfig[] => {
    if (!_plans) _plans = loadPlansConfig(repoPath);
    return _plans;
  };

  return {
    repoPath,
    env,
    get plans() { return getPlans(); },
    segmentApiKey,
    projectConfig,
    planIdEnv: (planPath, envKind) => {
      const plan = getPlans().find(
        (p) => p.path.toLowerCase() === planPath.toLowerCase(),
      );
      if (!plan) return undefined;
      return env[getPlanIdEnvVar(plan, envKind)];
    },
    resolvePlanOrThrow: (nameOrPath) => resolvePlan(getPlans(), nameOrPath),
    segmentClient: () => {
      if (!segmentApiKey) {
        throw new Error(
          "SEGMENT_PUBLIC_API_TOKEN is not set in the MCP server env",
        );
      }
      return createSegmentClient({ apiKey: segmentApiKey });
    },
    defaultBranch,
    forge,
    defaultWriteMode,
    resolveWriteMode: (argMode) => parseMode(argMode, defaultWriteMode),
    preflightWrite: (mode) => {
      if (mode === "files") return { blocked: false };
      try {
        assertCleanTree(repoPath);
        return { blocked: false };
      } catch (e) {
        if (e instanceof GitOpsError && e.code === "DIRTY_TREE") {
          return {
            blocked: true,
            error: {
              code: "DIRTY_TREE",
              message: e.message,
              details: e.details,
              remediation:
                "Stash or commit changes, or re-run with mode: 'files'.",
            },
          };
        }
        throw e;
      }
    },
  };
}
