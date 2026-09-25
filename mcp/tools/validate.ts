import { z } from "zod";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerContext } from "../context.js";
import { err, ok, ToolResult } from "./result.js";
import { readPlanSnapshot } from "../../lib/plan-snapshot.js";
import { ruleToYaml, loadYamlRuleFile, YamlRule } from "../../lib/yaml-transform.js";
import { validateRule, validatePlan as libValidatePlan, Finding } from "../../lib/validate.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";

export const validateEventInput = z
  .object({ plan: z.string(), env: z.enum(["dev", "prod"]), key: z.string() })
  .strict();
export const validatePlanInput = z
  .object({ plan: z.string(), env: z.enum(["dev", "prod"]) })
  .strict();
export const lintRulesInput = z
  .object({
    plan: z.string(),
    env: z.enum(["dev", "prod"]),
    source: z.enum(["yaml", "snapshot"]).optional(),
  })
  .strict();

function resolvePlanOr<T>(
  ctx: ServerContext,
  nameOrPath: string,
): { plan: import("../../lib/plans-config.js").PlanConfig } | ToolResult<T> {
  try {
    return { plan: ctx.resolvePlanOrThrow(nameOrPath) };
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
}

export function readYamlRules(repoPath: string, planPath: string): YamlRule[] {
  const dir = join(repoPath, "tracking-rules", planPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => loadYamlRuleFile(join(dir, f)));
}

function rulesForEnv(
  repoPath: string,
  env: "dev" | "prod",
  planPath: string,
): { rules: YamlRule[]; source: "yaml" | "snapshot" } {
  if (env === "dev") {
    return { rules: readYamlRules(repoPath, planPath), source: "yaml" };
  }
  return {
    rules: readPlanSnapshot(repoPath, env, planPath).map(ruleToYaml),
    source: "snapshot",
  };
}

export async function validateEvent(
  ctx: ServerContext,
  args: z.infer<typeof validateEventInput>,
): Promise<ToolResult<{ source: "yaml" | "snapshot"; findings: Finding[] }>> {
  const resolved = resolvePlanOr<{ source: "yaml" | "snapshot"; findings: Finding[] }>(
    ctx,
    args.plan,
  );
  if ("ok" in resolved) return resolved;
  const { rules, source } = rulesForEnv(ctx.repoPath, args.env, resolved.plan.path);
  const match = rules.find((r) => r.key === args.key);
  if (!match) {
    return err(
      "NOT_FOUND",
      `Event "${args.key}" not found in ${resolved.plan.name} (${args.env})`,
    );
  }
  return ok({ source, findings: validateRule(match) });
}

export async function validatePlan(
  ctx: ServerContext,
  args: z.infer<typeof validatePlanInput>,
): Promise<
  ToolResult<{
    source: "yaml" | "snapshot";
    findings: Finding[];
    summary: { errors: number; warnings: number };
  }>
> {
  const resolved = resolvePlanOr<{
    source: "yaml" | "snapshot";
    findings: Finding[];
    summary: { errors: number; warnings: number };
  }>(ctx, args.plan);
  if ("ok" in resolved) return resolved;
  const { rules, source } = rulesForEnv(ctx.repoPath, args.env, resolved.plan.path);
  const findings = libValidatePlan(rules);
  const summary = {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
  };
  return ok({ source, findings, summary });
}

export async function lintRules(
  ctx: ServerContext,
  args: z.infer<typeof lintRulesInput>,
): Promise<ToolResult<{ findings: Finding[] }>> {
  const resolved = resolvePlanOr<{ findings: Finding[] }>(ctx, args.plan);
  if ("ok" in resolved) return resolved;
  const source = args.source ?? "snapshot";
  const yamlRules = readYamlRules(ctx.repoPath, resolved.plan.path);
  const snapshotRules = readPlanSnapshot(
    ctx.repoPath,
    args.env,
    resolved.plan.path,
  ).map(ruleToYaml);

  const base = source === "yaml" ? yamlRules : snapshotRules;
  const other = source === "yaml" ? snapshotRules : yamlRules;
  const findings: Finding[] = libValidatePlan(base);

  const otherKeys = new Set(other.map((r) => r.key));
  for (const r of base) {
    if (r.key && !otherKeys.has(r.key)) {
      findings.push({
        severity: "warning",
        code: "orphan_event",
        path: r.key,
        message: `"${r.key}" exists in ${source} but not in ${source === "yaml" ? "snapshot" : "yaml"}`,
      });
    }
  }
  return ok({ findings });
}
