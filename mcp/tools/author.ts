import { z } from "zod";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ServerContext } from "../context.js";
import { err, ToolResult } from "./result.js";
import { yamlPropertySchema, writeModeSchema, sessionBranchSchema } from "./schemas.js";
import {
  loadYamlRuleFile,
  writeYamlRuleFile,
  type YamlRule,
} from "../../lib/yaml-transform.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";
import { applyWriteFlow, abort, type WriteOutput } from "./write-flow.js";

export const addEventInput = z
  .object({
    plan: z.string(),
    key: z.string(),
    type: z.string().optional(),
    version: z.number().int().positive().optional(),
    description: z.string(),
    properties: z.record(yamlPropertySchema),
    labels: z.record(z.string()).optional(),
    mode: writeModeSchema.optional(),
    branch: sessionBranchSchema.optional(),
  })
  .strict();

export const updateEventInput = z
  .object({
    plan: z.string(),
    key: z.string(),
    changes: z
      .object({
        description: z.string().optional(),
        add_properties: z.record(yamlPropertySchema).optional(),
        update_properties: z.record(yamlPropertySchema).optional(),
        remove_properties: z.array(z.string()).optional(),
        labels: z.record(z.string()).optional(),
      })
      .strict(),
    mode: writeModeSchema.optional(),
    branch: sessionBranchSchema.optional(),
  })
  .strict();

export const removeEventInput = z
  .object({
    plan: z.string(),
    key: z.string(),
    confirm: z.literal(true),
    mode: writeModeSchema.optional(),
    branch: sessionBranchSchema.optional(),
  })
  .strict();

function planYamlPath(repoPath: string, planPath: string, key: string): string {
  const fileName = `${key.replace(/ /g, "_")}.yml`;
  return join(repoPath, "tracking-rules", planPath, fileName);
}

export async function addEvent(
  ctx: ServerContext,
  args: z.infer<typeof addEventInput>,
): Promise<ToolResult<WriteOutput>> {
  const mode = ctx.resolveWriteMode(args.mode);
  const pre = ctx.preflightWrite(mode);
  if (pre.blocked) return { ok: false, error: pre.error };
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const filePath = planYamlPath(ctx.repoPath, plan.path, args.key);
  const relPath = `tracking-rules/${plan.path}/${args.key.replace(/ /g, "_")}.yml`;
  // Checks run inside the mutator so they see the target branch's files.
  return applyWriteFlow(
    ctx,
    plan.path,
    plan.name,
    args.key,
    "add",
    mode,
    () => {
      if (existsSync(filePath)) {
        abort(
          "VALIDATION",
          `Event "${args.key}" already exists at ${relPath}. Use update_event to modify.`,
        );
      }
      const yamlRule: YamlRule = {
        key: args.key,
        type: args.type ?? "TRACK",
        version: args.version ?? 1,
        description: args.description,
        properties: args.properties,
      };
      if (args.labels) yamlRule.labels = args.labels;
      writeYamlRuleFile(filePath, yamlRule);
      return { files_changed: [relPath] };
    },
    { branch: args.branch },
  );
}

export async function updateEvent(
  ctx: ServerContext,
  args: z.infer<typeof updateEventInput>,
): Promise<ToolResult<WriteOutput>> {
  const mode = ctx.resolveWriteMode(args.mode);
  const pre = ctx.preflightWrite(mode);
  if (pre.blocked) return { ok: false, error: pre.error };
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const filePath = planYamlPath(ctx.repoPath, plan.path, args.key);
  const relPath = `tracking-rules/${plan.path}/${args.key.replace(/ /g, "_")}.yml`;
  return applyWriteFlow(
    ctx,
    plan.path,
    plan.name,
    args.key,
    "update",
    mode,
    () => {
      if (!existsSync(filePath)) {
        abort("NOT_FOUND", `Event "${args.key}" has no yaml file at ${relPath}.`);
      }
      const rule = loadYamlRuleFile(filePath);
      for (const name of Object.keys(args.changes.add_properties ?? {})) {
        if (rule.properties[name]) {
          abort(
            "VALIDATION",
            `Property "${name}" already exists on "${args.key}"; use update_properties instead.`,
          );
        }
      }
      for (const name of Object.keys(args.changes.update_properties ?? {})) {
        if (!rule.properties[name]) {
          abort("NOT_FOUND", `Property "${name}" not found on "${args.key}"; use add_properties.`);
        }
      }
      if (args.changes.description !== undefined) rule.description = args.changes.description;
      if (args.changes.labels !== undefined) rule.labels = args.changes.labels;
      for (const [name, prop] of Object.entries(args.changes.add_properties ?? {})) {
        rule.properties[name] = prop;
      }
      for (const [name, patch] of Object.entries(args.changes.update_properties ?? {})) {
        rule.properties[name] = { ...rule.properties[name], ...patch };
      }
      for (const name of args.changes.remove_properties ?? []) {
        delete rule.properties[name];
      }
      writeYamlRuleFile(filePath, rule);
      return { files_changed: [relPath] };
    },
    { branch: args.branch },
  );
}

export async function removeEvent(
  ctx: ServerContext,
  args: z.infer<typeof removeEventInput>,
): Promise<ToolResult<WriteOutput & { removed_yaml: YamlRule }>> {
  // Note: schema validation (including confirm: true) is enforced by the tool
  // wrapper in mcp/tools/index.ts via makeTool → schema.parse().
  const mode = ctx.resolveWriteMode(args.mode);
  const pre = ctx.preflightWrite(mode);
  if (pre.blocked) return { ok: false, error: pre.error };
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const filePath = planYamlPath(ctx.repoPath, plan.path, args.key);
  const relPath = `tracking-rules/${plan.path}/${args.key.replace(/ /g, "_")}.yml`;
  return applyWriteFlow(
    ctx,
    plan.path,
    plan.name,
    args.key,
    "remove",
    mode,
    () => {
      if (!existsSync(filePath)) {
        abort("NOT_FOUND", `Event "${args.key}" has no yaml file at ${relPath}.`);
      }
      const removed = loadYamlRuleFile(filePath);
      unlinkSync(filePath);
      return { files_changed: [relPath], extras: { removed_yaml: removed } };
    },
    { branch: args.branch },
  ) as Promise<ToolResult<WriteOutput & { removed_yaml: YamlRule }>>;
}
