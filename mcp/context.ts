import { resolve } from "node:path";
import { createSegmentClient, SegmentClient } from "../lib/segment-api.js";
import {
  loadPlansConfig,
  PlanConfig,
  resolvePlan,
  getPlanIdEnvVar,
} from "../lib/plans-config.js";

export interface ServerContext {
  repoPath: string;
  env: Record<string, string | undefined>;
  plans: PlanConfig[];
  segmentApiKey?: string;
  planIdEnv: (planPath: string, env: "dev" | "prod") => string | undefined;
  resolvePlanOrThrow: (nameOrPath: string) => PlanConfig;
  segmentClient: () => SegmentClient;
}

export function resolveContext(
  env: Record<string, string | undefined> = process.env,
): ServerContext {
  const repoPath = resolve(env.REPO_PATH ?? process.cwd());
  const plans = loadPlansConfig(repoPath);
  const segmentApiKey = env.SEGMENT_PUBLIC_API_TOKEN;

  return {
    repoPath,
    env,
    plans,
    segmentApiKey,
    planIdEnv: (planPath, envKind) => {
      const plan = plans.find(
        (p) => p.path.toLowerCase() === planPath.toLowerCase(),
      );
      if (!plan) return undefined;
      return env[getPlanIdEnvVar(plan, envKind)];
    },
    resolvePlanOrThrow: (nameOrPath) => resolvePlan(plans, nameOrPath),
    segmentClient: () => {
      if (!segmentApiKey) {
        throw new Error(
          "SEGMENT_PUBLIC_API_TOKEN is not set in the MCP server env",
        );
      }
      return createSegmentClient({ apiKey: segmentApiKey });
    },
  };
}
