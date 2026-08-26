import { z } from "zod";
import { join } from "node:path";
import type { ServerContext } from "../context.js";
import { err, ok, ToolResult } from "./result.js";
import {
  loadYamlRuleFile,
  writeYamlRuleFile,
  type YamlProperty,
} from "../../lib/yaml-transform.js";
import { readYamlRules } from "./validate.js";
import { applyWriteFlow } from "./author.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";

const yamlPropertySchema: z.ZodType<YamlProperty> = z
  .object({
    type: z.string().optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
  })
  .catchall(z.unknown());

export const bulkRenamePropertyInput = z
  .object({
    plan: z.string(),
    from: z.string(),
    to: z.string(),
    dry_run: z.boolean().optional(),
    mode: z.enum(["files", "branch", "pr"]).optional(),
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
    mode: string;
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
    `rename ${args.from} → ${args.to}`,
    "update",
    mode,
    () => {
      for (const rule of affected) {
        const filePath = planFilePath(ctx.repoPath, plan.path, rule.key);
        const current = loadYamlRuleFile(filePath);
        const val = current.properties[args.from];
        delete current.properties[args.from];
        current.properties[args.to] = val;
        writeYamlRuleFile(filePath, current);
      }
      return { files_changed: relPaths };
    },
  );
  if (!result.ok) return result;
  return ok({ ...result.data, affected_events, dry_run: false });
}

export async function bulkAddProperty(
  ctx: ServerContext,
  args: z.infer<typeof bulkAddPropertyInput>,
): Promise<
  ToolResult<{
    files_changed: string[];
    affected_events: string[];
    dry_run: boolean;
    mode: string;
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
  return ok({ ...result.data, affected_events, dry_run: false });
}
