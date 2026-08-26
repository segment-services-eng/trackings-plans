import { z } from "zod";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ServerContext } from "../context.js";
import { err, ToolResult } from "./result.js";
import { yamlPropertySchema } from "./schemas.js";
import {
  loadYamlRuleFile,
  writeYamlRuleFile,
  type YamlRule,
} from "../../lib/yaml-transform.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";
import { applyWriteFlow, type WriteOutput } from "./write-flow.js";

export const addEventInput = z
  .object({
    plan: z.string(),
    key: z.string(),
    type: z.string().optional(),
    version: z.number().int().positive().optional(),
    description: z.string(),
    properties: z.record(yamlPropertySchema),
    labels: z.record(z.string()).optional(),
    mode: z.enum(["files", "branch", "pr"]).optional(),
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
    mode: z.enum(["files", "branch", "pr"]).optional(),
  })
  .strict();

export const removeEventInput = z
  .object({
    plan: z.string(),
    key: z.string(),
    confirm: z.literal(true),
    mode: z.enum(["files", "branch", "pr"]).optional(),
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
  if (existsSync(filePath)) {
    return err(
      "VALIDATION",
      `Event "${args.key}" already exists at ${filePath}. Use update_event to modify.`,
    );
  }
  return applyWriteFlow(ctx, plan.path, plan.name, args.key, "add", mode, () => {
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
  });
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
  if (!existsSync(filePath)) {
    return err("NOT_FOUND", `Event "${args.key}" has no yaml file at ${filePath}.`);
  }
  // Validate changes before entering write flow
  const current = loadYamlRuleFile(filePath);
  if (args.changes.add_properties) {
    for (const [name] of Object.entries(args.changes.add_properties)) {
      if (current.properties[name]) {
        return err(
          "VALIDATION",
          `Property "${name}" already exists on "${args.key}"; use update_properties instead.`,
        );
      }
    }
  }
  if (args.changes.update_properties) {
    for (const [name] of Object.entries(args.changes.update_properties)) {
      if (!current.properties[name]) {
        return err(
          "NOT_FOUND",
          `Property "${name}" not found on "${args.key}"; use add_properties.`,
        );
      }
    }
  }
  const relPath = `tracking-rules/${plan.path}/${args.key.replace(/ /g, "_")}.yml`;
  return applyWriteFlow(ctx, plan.path, plan.name, args.key, "update", mode, () => {
    // Re-load inside mutator so branch mode reads the file on the new branch
    const rule = loadYamlRuleFile(filePath);
    if (args.changes.description !== undefined) rule.description = args.changes.description;
    if (args.changes.labels !== undefined) rule.labels = args.changes.labels;
    if (args.changes.add_properties) {
      for (const [name, prop] of Object.entries(args.changes.add_properties)) {
        rule.properties[name] = prop;
      }
    }
    if (args.changes.update_properties) {
      for (const [name, patch] of Object.entries(args.changes.update_properties)) {
        rule.properties[name] = { ...rule.properties[name], ...patch };
      }
    }
    if (args.changes.remove_properties) {
      for (const name of args.changes.remove_properties) {
        delete rule.properties[name];
      }
    }
    writeYamlRuleFile(filePath, rule);
    return { files_changed: [relPath] };
  });
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
  if (!existsSync(filePath)) {
    return err("NOT_FOUND", `Event "${args.key}" has no yaml file at ${filePath}.`);
  }
  const relPath = `tracking-rules/${plan.path}/${args.key.replace(/ /g, "_")}.yml`;
  return applyWriteFlow(ctx, plan.path, plan.name, args.key, "remove", mode, () => {
    const removed = loadYamlRuleFile(filePath);
    unlinkSync(filePath);
    return { files_changed: [relPath], extras: { removed_yaml: removed } };
  }) as Promise<ToolResult<WriteOutput & { removed_yaml: YamlRule }>>;
}
