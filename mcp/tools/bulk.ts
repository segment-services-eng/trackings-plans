import { z } from "zod";
import { join } from "node:path";
import type { ServerContext, WriteMode } from "../context.js";
import { err, ok, ToolResult } from "./result.js";
import { yamlPropertySchema } from "./schemas.js";
import {
  loadYamlRuleFile,
  writeYamlRuleFile,
  type YamlProperty,
} from "../../lib/yaml-transform.js";
import { readYamlRules } from "./validate.js";
import { applyWriteFlow } from "./write-flow.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";

export const bulkRenamePropertyInput = z
  .object({
    plan: z.string(),
    from: z.string(),
    to: z.string(),
    dry_run: z.boolean().optional(),
    mode: z.enum(["files", "branch", "pr"]).optional(),
    on_collision: z.enum(["fail", "skip", "overwrite"]).optional(),
  })
  .strict();

export const bulkAddPropertyInput = z
  .object({
    plan: z.string(),
    property_name: z.string(),
    property: yamlPropertySchema,
    filter: z.string().optional(),
    dry_run: z.boolean().optional(),
    mode: z.enum(["files", "branch", "pr"]).optional(),
  })
  .strict();

function planFilePath(repoPath: string, planPath: string, key: string): string {
  return join(repoPath, "tracking-rules", planPath, `${key.replace(/ /g, "_")}.yml`);
}

export async function bulkRenameProperty(
  ctx: ServerContext,
  args: z.infer<typeof bulkRenamePropertyInput>,
): Promise<
  ToolResult<{
    files_changed: string[];
    affected_events: string[];
    dry_run: boolean;
    mode: WriteMode;
    collisions?: Array<{ event: string; existing: YamlProperty }>;
    [k: string]: unknown;
  }>
> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const rules = readYamlRules(ctx.repoPath, plan.path);
  const affected = rules.filter((r) => r.properties && args.from in r.properties);
  const relPaths = affected.map(
    (r) => `tracking-rules/${plan.path}/${r.key.replace(/ /g, "_")}.yml`,
  );
  const affected_events = affected.map((r) => r.key);

  // Detect collisions: events that already have a property named args.to
  const collisions: Array<{ event: string; existing: YamlProperty }> = affected
    .filter((r) => args.to in (r.properties ?? {}))
    .map((r) => ({ event: r.key, existing: r.properties[args.to] }));

  const dry_run = args.dry_run ?? true;
  if (dry_run) {
    return ok({
      files_changed: relPaths,
      affected_events,
      dry_run: true,
      mode: ctx.resolveWriteMode(args.mode),
      collisions,
    });
  }

  const on_collision = args.on_collision ?? "fail";

  // Fix 5: block on collisions unless caller opted in
  if (collisions.length > 0 && on_collision === "fail") {
    return err(
      "VALIDATION",
      `Cannot rename "${args.from}" to "${args.to}" — ${collisions.length} event(s) already have a property named "${args.to}"`,
      { details: { collisions } },
    );
  }

  const mode = ctx.resolveWriteMode(args.mode);

  // Determine which events to actually process based on on_collision strategy
  const toProcess =
    on_collision === "skip"
      ? affected.filter((r) => !(args.to in (r.properties ?? {})))
      : affected; // "overwrite" or no collisions → process all

  const processedPaths = toProcess.map(
    (r) => `tracking-rules/${plan.path}/${r.key.replace(/ /g, "_")}.yml`,
  );
  const processedEvents = toProcess.map((r) => r.key);

  const result = await applyWriteFlow(
    ctx,
    plan.path,
    plan.name,
    `rename ${args.from} → ${args.to}`,
    "update",
    mode,
    () => {
      for (const rule of toProcess) {
        const filePath = planFilePath(ctx.repoPath, plan.path, rule.key);
        const current = loadYamlRuleFile(filePath);
        const val = current.properties[args.from];
        delete current.properties[args.from];
        current.properties[args.to] = val;
        writeYamlRuleFile(filePath, current);
      }
      return { files_changed: processedPaths };
    },
  );
  if (!result.ok) return result;
  return ok(
    { ...result.data, affected_events: processedEvents, dry_run: false },
    result.warnings,
  );
}

export async function bulkAddProperty(
  ctx: ServerContext,
  args: z.infer<typeof bulkAddPropertyInput>,
): Promise<
  ToolResult<{
    files_changed: string[];
    affected_events: string[];
    dry_run: boolean;
    mode: WriteMode;
    [k: string]: unknown;
  }>
> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  let filterRegex: RegExp | null = null;
  if (args.filter) {
    try {
      filterRegex = new RegExp(args.filter);
    } catch (e) {
      return err("VALIDATION", `Invalid regex in 'filter': ${(e as Error).message}`);
    }
  }
  const rules = readYamlRules(ctx.repoPath, plan.path);
  const affected = rules.filter(
    (r) =>
      (!filterRegex || filterRegex.test(r.key)) &&
      !(args.property_name in (r.properties ?? {})),
  );
  const relPaths = affected.map(
    (r) => `tracking-rules/${plan.path}/${r.key.replace(/ /g, "_")}.yml`,
  );
  const affected_events = affected.map((r) => r.key);
  const dry_run = args.dry_run ?? true;
  if (dry_run) {
    return ok({
      files_changed: relPaths,
      affected_events,
      dry_run: true,
      mode: ctx.resolveWriteMode(args.mode),
    });
  }
  const mode = ctx.resolveWriteMode(args.mode);
  const result = await applyWriteFlow(
    ctx,
    plan.path,
    plan.name,
    `add ${args.property_name}`,
    "update",
    mode,
    () => {
      for (const rule of affected) {
        const filePath = planFilePath(ctx.repoPath, plan.path, rule.key);
        const current = loadYamlRuleFile(filePath);
        current.properties[args.property_name] = args.property;
        writeYamlRuleFile(filePath, current);
      }
      return { files_changed: relPaths };
    },
  );
  if (!result.ok) return result;
  return ok(
    { ...result.data, affected_events, dry_run: false },
    result.warnings,
  );
}
