import { z } from "zod";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ServerContext } from "../context.js";
import { err, ok, ToolResult } from "./result.js";
import { renderMarkdown } from "../../lib/render-markdown.js";
import { yamlToRule, type YamlRule } from "../../lib/yaml-transform.js";
import type { Rule } from "../../lib/segment-api.js";
import { readPlanSnapshot } from "../../lib/plan-snapshot.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";
import { readYamlRules } from "./validate.js";

export const previewMarkdownInput = z
  .object({
    plan: z.string(),
    source: z.enum(["yaml", "snapshot"]).optional(),
    env: z.enum(["dev", "prod"]).optional(),
  })
  .strict();

export const previewSegmentPayloadInput = z
  .object({ plan: z.string(), key: z.string() })
  .strict();

export async function previewMarkdown(
  ctx: ServerContext,
  args: z.infer<typeof previewMarkdownInput>,
): Promise<
  ToolResult<{ markdown: string; diff_against_committed: string | null }>
> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const source = args.source ?? "yaml";
  let rules: Rule[];
  if (source === "yaml") {
    rules = readYamlRules(ctx.repoPath, plan.path).map(yamlToRule);
  } else {
    if (!args.env) {
      return err(
        "VALIDATION",
        "env is required when source is 'snapshot'",
      );
    }
    rules = readPlanSnapshot(ctx.repoPath, args.env, plan.path);
  }
  const markdown = renderMarkdown({ title: plan.name, rules });

  const committedMdPath = join(ctx.repoPath, "docs", `${plan.name}.md`);
  let diff: string | null = null;
  if (existsSync(committedMdPath)) {
    try {
      execFileSync(
        "git",
        ["diff", "--no-index", "--no-color", committedMdPath, "-"],
        { cwd: ctx.repoPath, input: markdown, encoding: "utf8" },
      );
      diff = "";
    } catch (e: any) {
      diff = typeof e.stdout === "string" ? e.stdout : String(e.stdout ?? "");
    }
  }
  return ok({ markdown, diff_against_committed: diff });
}

export async function previewSegmentPayload(
  ctx: ServerContext,
  args: z.infer<typeof previewSegmentPayloadInput>,
): Promise<ToolResult<{ payload: Rule }>> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const yamlRules = readYamlRules(ctx.repoPath, plan.path);
  const match = yamlRules.find((r: YamlRule) => r.key === args.key);
  if (!match) {
    return err(
      "NOT_FOUND",
      `Event "${args.key}" has no yaml file in tracking-rules/${plan.path}/`,
    );
  }
  return ok({ payload: yamlToRule(match) });
}
