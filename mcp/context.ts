import { resolve } from "node:path";
import { createSegmentClient, SegmentClient } from "../lib/segment-api.js";
import {
  loadPlansConfig,
  PlanConfig,
  resolvePlan,
  getPlanIdEnvVar,
} from "../lib/plans-config.js";
import { assertCleanTree, GitOpsError } from "../lib/git-ops.js";
import type { ToolResultError } from "./tools/result.js";

export type WriteMode = "files" | "branch" | "pr";

export interface ServerContext {
  repoPath: string;
  env: Record<string, string | undefined>;
  plans: PlanConfig[];
  segmentApiKey?: string;
  planIdEnv: (planPath: string, env: "dev" | "prod") => string | undefined;
  resolvePlanOrThrow: (nameOrPath: string) => PlanConfig;
  segmentClient: () => SegmentClient;
  defaultWriteMode: WriteMode;
  resolveWriteMode: (argMode?: string) => WriteMode;
  preflightWrite: (
    mode: WriteMode,
  ) => { blocked: false } | { blocked: true; error: ToolResultError };
}

const WRITE_MODES: WriteMode[] = ["files", "branch", "pr"];

function parseMode(raw: string | undefined, fallback: WriteMode): WriteMode {
  if (raw && (WRITE_MODES as string[]).includes(raw)) return raw as WriteMode;
  return fallback;
}

export function resolveContext(
  env: Record<string, string | undefined> = process.env,
): ServerContext {
  const repoPath = resolve(env.REPO_PATH ?? process.cwd());
  const segmentApiKey = env.SEGMENT_PUBLIC_API_TOKEN;
  const defaultWriteMode: WriteMode = parseMode(env.MCP_WRITE_MODE, "branch");

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
