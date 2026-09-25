import { z } from "zod";
import { join } from "node:path";
import type { ServerContext, WriteMode } from "../context.js";
import { err, ok, ToolResult } from "./result.js";
import { yamlPropertySchema, writeModeSchema, sessionBranchSchema } from "./schemas.js";
import {
  loadYamlRuleFile,
  parseYamlRule,
  writeYamlRuleFile,
  type YamlProperty,
  type YamlRule,
} from "../../lib/yaml-transform.js";
import { listFilesAtRef, locateBranch, readFileAtRef } from "../../lib/git-ops.js";
import { readYamlRules } from "./validate.js";
import { abort, applyWriteFlow } from "./write-flow.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";

export const bulkRenamePropertyInput = z
  .object({
    plan: z.string(),
    from: z.string(),
    to: z.string(),
    dry_run: z.boolean().optional(),
    mode: writeModeSchema.optional(),
    branch: sessionBranchSchema.optional(),
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
    mode: writeModeSchema.optional(),
    branch: sessionBranchSchema.optional(),
  })
  .strict();

function planFilePath(repoPath: string, planPath: string, key: string): string {
  return join(repoPath, "tracking-rules", planPath, `${key.replace(/ /g, "_")}.yml`);
}

function relPathFor(planPath: string, key: string): string {
  return `tracking-rules/${planPath}/${key.replace(/ /g, "_")}.yml`;
}

/**
 * YAML rules for a dry run. With a session branch in branch/pr mode, reads
 * that branch's committed files (without checking it out) so the preview
 * matches what the write would touch; otherwise reads the working tree.
 */
function readRulesForPreview(
  ctx: ServerContext,
  planPath: string,
  mode: WriteMode,
  branch: string | undefined,
): YamlRule[] | ToolResult<never> {
  if (!branch || mode === "files") return readYamlRules(ctx.repoPath, planPath);
  const where = locateBranch(ctx.repoPath, branch);
  if (where === null) {
    return err("NOT_FOUND", `Branch "${branch}" does not exist locally or on origin.`, {
      remediation: "Omit branch to create one, or pass the branch returned by an earlier call.",
    });
  }
  const ref = where === "local" ? branch : `origin/${branch}`;
  const dir = `tracking-rules/${planPath}`;
  return listFilesAtRef(ctx.repoPath, ref, dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => parseYamlRule(readFileAtRef(ctx.repoPath, ref, `${dir}/${f}`), `${ref}:${dir}/${f}`));
}

function renamePlan(rules: YamlRule[], from: string, to: string) {
  const affected = rules.filter((r) => r.properties && from in r.properties);
  const collisions = affected
    .filter((r) => to in (r.properties ?? {}))
    .map((r) => ({ event: r.key, existing: r.properties[to] }));
  return { affected, collisions };
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
  const mode = ctx.resolveWriteMode(args.mode);
  const on_collision = args.on_collision ?? "fail";

  if (args.dry_run ?? true) {
    const rules = readRulesForPreview(ctx, plan.path, mode, args.branch);
    if (!Array.isArray(rules)) return rules;
    const { affected, collisions } = renamePlan(rules, args.from, args.to);
    return ok({
      files_changed: affected.map((r) => relPathFor(plan.path, r.key)),
      affected_events: affected.map((r) => r.key),
      dry_run: true,
      mode,
      collisions,
    });
  }

  let processedEvents: string[] = [];
  // Selection runs inside the mutator so it sees the target branch's files.
  const result = await applyWriteFlow(
    ctx,
    plan.path,
    plan.name,
    `rename ${args.from} → ${args.to}`,
    "update",
    mode,
    () => {
      const { affected, collisions } = renamePlan(
        readYamlRules(ctx.repoPath, plan.path),
        args.from,
        args.to,
      );
      if (collisions.length > 0 && on_collision === "fail") {
        abort(
          "VALIDATION",
          `Cannot rename "${args.from}" to "${args.to}" — ${collisions.length} event(s) already have a property named "${args.to}"`,
          { details: { collisions } },
        );
      }
      const toProcess =
        on_collision === "skip"
          ? affected.filter((r) => !(args.to in (r.properties ?? {})))
          : affected;
      for (const rule of toProcess) {
        const filePath = planFilePath(ctx.repoPath, plan.path, rule.key);
        const current = loadYamlRuleFile(filePath);
        const val = current.properties[args.from];
        delete current.properties[args.from];
        current.properties[args.to] = val;
        writeYamlRuleFile(filePath, current);
      }
      processedEvents = toProcess.map((r) => r.key);
      return { files_changed: toProcess.map((r) => relPathFor(plan.path, r.key)) };
    },
    { branch: args.branch },
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
  const select = (rules: YamlRule[]) =>
    rules.filter(
      (r) =>
        (!filterRegex || filterRegex.test(r.key)) &&
        !(args.property_name in (r.properties ?? {})),
    );
  const mode = ctx.resolveWriteMode(args.mode);

  if (args.dry_run ?? true) {
    const rules = readRulesForPreview(ctx, plan.path, mode, args.branch);
    if (!Array.isArray(rules)) return rules;
    const affected = select(rules);
    return ok({
      files_changed: affected.map((r) => relPathFor(plan.path, r.key)),
      affected_events: affected.map((r) => r.key),
      dry_run: true,
      mode,
    });
  }

  let affectedEvents: string[] = [];
  const result = await applyWriteFlow(
    ctx,
    plan.path,
    plan.name,
    `add ${args.property_name}`,
    "update",
    mode,
    () => {
      const affected = select(readYamlRules(ctx.repoPath, plan.path));
      for (const rule of affected) {
        const filePath = planFilePath(ctx.repoPath, plan.path, rule.key);
        const current = loadYamlRuleFile(filePath);
        current.properties[args.property_name] = args.property;
        writeYamlRuleFile(filePath, current);
      }
      affectedEvents = affected.map((r) => r.key);
      return { files_changed: affected.map((r) => relPathFor(plan.path, r.key)) };
    },
    { branch: args.branch },
  );
  if (!result.ok) return result;
  return ok(
    { ...result.data, affected_events: affectedEvents, dry_run: false },
    result.warnings,
  );
}
