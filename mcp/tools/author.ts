import { z } from "zod";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ServerContext } from "../context.js";
import { err, ok, ToolResult } from "./result.js";
import {
  loadYamlRuleFile,
  writeYamlRuleFile,
  type YamlRule,
  type YamlProperty,
} from "../../lib/yaml-transform.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";

const yamlPropertySchema: z.ZodType<YamlProperty> = z
  .object({
    type: z.string().optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
  })
  .catchall(z.unknown());

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

interface WriteOutput {
  files_changed: string[];
  mode: "files";
}

export async function addEvent(
  ctx: ServerContext,
  args: z.infer<typeof addEventInput>,
): Promise<ToolResult<WriteOutput>> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const mode = ctx.resolveWriteMode(args.mode);
  if (mode !== "files") {
    return err(
      "VALIDATION",
      "This task only supports mode: 'files'. Branch/PR modes land in Task 7.",
    );
  }
  const filePath = planYamlPath(ctx.repoPath, plan.path, args.key);
  if (existsSync(filePath)) {
    return err(
      "VALIDATION",
      `Event "${args.key}" already exists at ${filePath}. Use update_event to modify.`,
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
  return ok({
    files_changed: [`tracking-rules/${plan.path}/${args.key.replace(/ /g, "_")}.yml`],
    mode: "files",
  });
}

export async function updateEvent(
  ctx: ServerContext,
  args: z.infer<typeof updateEventInput>,
): Promise<ToolResult<WriteOutput>> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const mode = ctx.resolveWriteMode(args.mode);
  if (mode !== "files") {
    return err(
      "VALIDATION",
      "This task only supports mode: 'files'. Branch/PR modes land in Task 7.",
    );
  }
  const filePath = planYamlPath(ctx.repoPath, plan.path, args.key);
  if (!existsSync(filePath)) {
    return err("NOT_FOUND", `Event "${args.key}" has no yaml file at ${filePath}.`);
  }
  const current = loadYamlRuleFile(filePath);
  if (args.changes.description !== undefined) current.description = args.changes.description;
  if (args.changes.labels !== undefined) current.labels = args.changes.labels;
  if (args.changes.add_properties) {
    for (const [name, prop] of Object.entries(args.changes.add_properties)) {
      if (current.properties[name]) {
        return err(
          "VALIDATION",
          `Property "${name}" already exists on "${args.key}"; use update_properties instead.`,
        );
      }
      current.properties[name] = prop;
    }
  }
  if (args.changes.update_properties) {
    for (const [name, patch] of Object.entries(args.changes.update_properties)) {
      if (!current.properties[name]) {
        return err(
          "NOT_FOUND",
          `Property "${name}" not found on "${args.key}"; use add_properties.`,
        );
      }
      current.properties[name] = { ...current.properties[name], ...patch };
    }
  }
  if (args.changes.remove_properties) {
    for (const name of args.changes.remove_properties) {
      delete current.properties[name];
    }
  }
  writeYamlRuleFile(filePath, current);
  return ok({
    files_changed: [`tracking-rules/${plan.path}/${args.key.replace(/ /g, "_")}.yml`],
    mode: "files",
  });
}

export async function removeEvent(
  ctx: ServerContext,
  args: z.infer<typeof removeEventInput>,
): Promise<ToolResult<WriteOutput & { removed_yaml: YamlRule }>> {
  const parsed = removeEventInput.safeParse(args);
  if (!parsed.success) {
    return err("VALIDATION", parsed.error.message);
  }
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const mode = ctx.resolveWriteMode(args.mode);
  if (mode !== "files") {
    return err(
      "VALIDATION",
      "This task only supports mode: 'files'. Branch/PR modes land in Task 7.",
    );
  }
  const filePath = planYamlPath(ctx.repoPath, plan.path, args.key);
  if (!existsSync(filePath)) {
    return err("NOT_FOUND", `Event "${args.key}" has no yaml file at ${filePath}.`);
  }
  const removed = loadYamlRuleFile(filePath);
  unlinkSync(filePath);
  return ok({
    files_changed: [`tracking-rules/${plan.path}/${args.key.replace(/ /g, "_")}.yml`],
    mode: "files",
    removed_yaml: removed,
  });
}
