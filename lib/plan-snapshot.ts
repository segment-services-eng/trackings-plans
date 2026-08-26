import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "./segment-api.js";

function planDir(
  repoPath: string,
  env: "dev" | "prod",
  planPath: string,
): string {
  return join(repoPath, "plans", env, planPath);
}

export function hasPlanSnapshot(
  repoPath: string,
  env: "dev" | "prod",
  planPath: string,
): boolean {
  const dir = planDir(repoPath, env, planPath);
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some(
    (f) => f.startsWith("current-rules") && f.endsWith(".json"),
  );
}

export function readPlanSnapshot(
  repoPath: string,
  env: "dev" | "prod",
  planPath: string,
): Rule[] {
  const dir = planDir(repoPath, env, planPath);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("current-rules") && f.endsWith(".json"))
    .sort();
  const rules: Rule[] = [];
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    const parsed = JSON.parse(raw) as { rules?: Rule[] };
    if (Array.isArray(parsed.rules)) rules.push(...parsed.rules);
  }
  return rules;
}
