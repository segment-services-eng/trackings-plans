import { z } from "zod";
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
