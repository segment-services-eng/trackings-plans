import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PlanConfig {
  name: string;
  path: string;
  dev_secret: string;
  prod_secret: string;
}

export interface PlansConfigFile {
  plans: PlanConfig[];
}

export class PlanNotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
  constructor(nameOrPath: string, available: string[]) {
    super(
      `Plan "${nameOrPath}" not found. Available plans: ${available.join(", ")}`,
    );
  }
}

export function loadPlansConfig(repoPath: string): PlanConfig[] {
  const configPath = join(repoPath, "config", "tracking-plans-config.json");
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as PlansConfigFile;
  if (!parsed?.plans || !Array.isArray(parsed.plans)) {
    throw new Error(
      `Invalid tracking-plans-config.json at ${configPath}: missing "plans" array`,
    );
  }
  return parsed.plans;
}

export function resolvePlan(
  plans: PlanConfig[],
  nameOrPath: string,
): PlanConfig {
  const lower = nameOrPath.toLowerCase();
  const match = plans.find(
    (p) => p.name.toLowerCase() === lower || p.path.toLowerCase() === lower,
  );
  if (!match) {
    throw new PlanNotFoundError(
      nameOrPath,
      plans.map((p) => p.name),
    );
  }
  return match;
}

export function getPlanIdEnvVar(
  plan: PlanConfig,
  env: "dev" | "prod",
): string {
  return env === "dev" ? plan.dev_secret : plan.prod_secret;
}
