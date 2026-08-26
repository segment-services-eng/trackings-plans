import { z } from "zod";
import { execFileSync } from "node:child_process";
import type { ServerContext } from "../context.js";
import { readPlanSnapshot } from "../../lib/plan-snapshot.js";
import { ruleToYaml } from "../../lib/yaml-transform.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";
import { err, ok, ToolResult } from "./result.js";

export const listPlansInput = z.object({}).strict();
export const listEventsInput = z
  .object({
    plan: z.string(),
    env: z.enum(["dev", "prod"]),
    filter: z.string().optional(),
    missing_description: z.boolean().optional(),
    has_property: z.string().optional(),
  })
  .strict();
export const getEventInput = z
  .object({
    plan: z.string(),
    env: z.enum(["dev", "prod"]),
    key: z.string(),
  })
  .strict();

export async function listPlans(
  ctx: ServerContext,
  _args: z.infer<typeof listPlansInput>,
): Promise<ToolResult<{ plans: Array<{ name: string; path: string }> }>> {
  return ok({
    plans: ctx.plans.map((p) => ({ name: p.name, path: p.path })),
  });
}

export async function listEvents(
  ctx: ServerContext,
  args: z.infer<typeof listEventsInput>,
): Promise<
  ToolResult<{
    events: Array<{ key: string; description: string | null; property_count: number }>;
  }>
> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) {
      return err("NOT_FOUND", e.message);
    }
    throw e;
  }
  const rules = readPlanSnapshot(ctx.repoPath, args.env, plan.path);
  const filterRegex = args.filter ? new RegExp(args.filter) : null;
  const events = rules
    .map((r) => {
      const schema = r.jsonSchema as any;
      const props = schema?.properties?.properties?.properties ?? {};
      return {
        key: r.key,
        description: (schema?.description ?? null) as string | null,
        property_count: Object.keys(props).length,
        _props: props as Record<string, unknown>,
      };
    })
    .filter((e) => (filterRegex ? filterRegex.test(e.key) : true))
    .filter((e) =>
      args.missing_description ? !e.description : true,
    )
    .filter((e) =>
      args.has_property ? args.has_property in e._props : true,
    )
    .map(({ _props, ...rest }) => rest);
  return ok({ events });
}

export async function getEvent(
  ctx: ServerContext,
  args: z.infer<typeof getEventInput>,
): Promise<ToolResult<{ event: ReturnType<typeof ruleToYaml> }>> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) {
      return err("NOT_FOUND", e.message);
    }
    throw e;
  }
  const rules = readPlanSnapshot(ctx.repoPath, args.env, plan.path);
  const match = rules.find((r) => r.key === args.key);
  if (!match) {
    return err(
      "NOT_FOUND",
      `Event "${args.key}" not found in ${plan.name} (${args.env})`,
    );
  }
  return ok({ event: ruleToYaml(match) });
}

export const diffPlansInput = z
  .object({
    planA: z.string(),
    envA: z.enum(["dev", "prod"]),
    planB: z.string(),
    envB: z.enum(["dev", "prod"]),
  })
  .strict();
export const findPropertyUsageInput = z
  .object({
    property: z.string(),
    plan: z.string().optional(),
    env: z.enum(["dev", "prod"]),
  })
  .strict();
export const listRecentChangesInput = z
  .object({
    plan: z.string(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

function propsOf(rule: any): Record<string, any> {
  return rule?.jsonSchema?.properties?.properties?.properties ?? {};
}

export async function diffPlans(
  ctx: ServerContext,
  args: z.infer<typeof diffPlansInput>,
): Promise<
  ToolResult<{
    added: string[];
    removed: string[];
    modified: Array<{ key: string; changes: string[] }>;
  }>
> {
  let a, b;
  try {
    a = ctx.resolvePlanOrThrow(args.planA);
    b = ctx.resolvePlanOrThrow(args.planB);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const rulesA = readPlanSnapshot(ctx.repoPath, args.envA, a.path);
  const rulesB = readPlanSnapshot(ctx.repoPath, args.envB, b.path);
  const mapA = new Map(rulesA.map((r) => [r.key, r]));
  const mapB = new Map(rulesB.map((r) => [r.key, r]));

  const added: string[] = [];
  const removed: string[] = [];
  const modified: Array<{ key: string; changes: string[] }> = [];

  for (const key of mapB.keys()) if (!mapA.has(key)) added.push(key);
  for (const key of mapA.keys()) if (!mapB.has(key)) removed.push(key);
  for (const [key, ruleA] of mapA) {
    const ruleB = mapB.get(key);
    if (!ruleB) continue;
    const propsA = propsOf(ruleA);
    const propsB = propsOf(ruleB);
    const changes: string[] = [];
    for (const p of Object.keys(propsB)) {
      if (!(p in propsA)) changes.push(`added property ${p}`);
      else if ((propsA[p]?.type ?? "unknown") !== (propsB[p]?.type ?? "unknown")) {
        changes.push(
          `changed property ${p} type from ${propsA[p]?.type} to ${propsB[p]?.type}`,
        );
      }
    }
    for (const p of Object.keys(propsA)) {
      if (!(p in propsB)) changes.push(`removed property ${p}`);
    }
    if (changes.length) modified.push({ key, changes });
  }
  return ok({ added, removed, modified });
}

export async function findPropertyUsage(
  ctx: ServerContext,
  args: z.infer<typeof findPropertyUsageInput>,
): Promise<ToolResult<{ usages: Array<{ plan: string; event: string }> }>> {
  let plansToSearch: typeof ctx.plans;
  if (args.plan) {
    try {
      plansToSearch = [ctx.resolvePlanOrThrow(args.plan)];
    } catch (e) {
      if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
      throw e;
    }
  } else {
    plansToSearch = ctx.plans;
  }
  const usages: Array<{ plan: string; event: string }> = [];
  for (const p of plansToSearch) {
    const rules = readPlanSnapshot(ctx.repoPath, args.env, p.path);
    for (const r of rules) {
      if (args.property in propsOf(r)) {
        usages.push({ plan: p.path, event: r.key });
      }
    }
  }
  return ok({ usages });
}

export async function listRecentChanges(
  ctx: ServerContext,
  args: z.infer<typeof listRecentChangesInput>,
): Promise<ToolResult<{ commits: Array<{ sha: string; subject: string }> }>> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const limit = args.limit ?? 20;
  const out = execFileSync(
    "git",
    [
      "log",
      `--max-count=${limit}`,
      "--pretty=format:%H%x1f%s",
      "--",
      `tracking-rules/${plan.path}/`,
    ],
    { cwd: ctx.repoPath, encoding: "utf8" },
  );
  const commits = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split("\x1f");
      return { sha, subject };
    });
  return ok({ commits });
}
