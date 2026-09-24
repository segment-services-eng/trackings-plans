import { z } from "zod";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerContext } from "../context.js";
import { err, ToolResult } from "./result.js";
import { applyWriteFlow, type MutatorResult, type WriteOutput } from "./write-flow.js";
import { PlanNotFoundError, getPlanIdEnvVar, type PlanConfig } from "../../lib/plans-config.js";
import { SegmentApiError, type Rule } from "../../lib/segment-api.js";
import {
  formatSnapshotFiles,
  isSnapshotFileName,
  readSnapshotSources,
  resetRules,
} from "../../lib/snapshot-sync.js";

type Env = "dev" | "prod";
const modeSchema = z.enum(["files", "branch", "pr"]).optional();

// No env / plan-id arguments: the reset target is always the DEV plan id.
export const resetDevFromProdInput = z
  .object({
    plan: z.string(),
    confirm: z.boolean().optional(),
    mode: modeSchema,
  })
  .strict();

export const pullFromSegmentInput = z
  .object({
    plan: z.string(),
    env: z.enum(["dev", "prod"]),
    mode: modeSchema,
  })
  .strict();

const UNCHANGED_WARNING = "Snapshot unchanged — Segment matches the local file; nothing to commit.";

function segmentErr(e: SegmentApiError): ToolResult<never> {
  return err("SEGMENT_API", e.message, {
    details: { status: e.status, body: e.body },
    remediation: `Segment returned ${e.status ?? "an error"}. Check SEGMENT_PUBLIC_API_TOKEN and the tracking plan id, or retry shortly.`,
  });
}

/** Resolve plan + token + plan id for `env`. Returns an error result on failure. */
function resolveTarget(
  ctx: ServerContext,
  planArg: string,
  env: Env,
): { plan: PlanConfig; planId: string } | { error: ToolResult<never> } {
  let plan: PlanConfig;
  try {
    plan = ctx.resolvePlanOrThrow(planArg);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return { error: err("NOT_FOUND", e.message) };
    throw e;
  }
  if (!ctx.segmentApiKey) {
    return {
      error: err("CONFIG", "SEGMENT_PUBLIC_API_TOKEN is not set in the MCP server env.", {
        remediation: "Add SEGMENT_PUBLIC_API_TOKEN to the MCP server env config.",
      }),
    };
  }
  const planId = ctx.planIdEnv(plan.path, env);
  if (!planId) {
    const varName = getPlanIdEnvVar(plan, env);
    return {
      error: err("CONFIG", `${varName} is not set in the MCP server env.`, {
        remediation: `Add ${varName} (the ${env.toUpperCase()} Segment tracking plan id for "${plan.name}") to the MCP server env config.`,
      }),
    };
  }
  return { plan, planId };
}

/**
 * Mutator that writes `rules` to plans/<env>/<plan>/ in save-tracking-plan.js
 * format, removing stale current-rules*.json files. Only touched paths are
 * reported, so identical content yields files_changed: [].
 */
function snapshotMutator(
  repoPath: string,
  env: Env,
  planPath: string,
  rules: Rule[],
  extras: Record<string, unknown>,
): () => MutatorResult {
  return () => {
    const relDir = `plans/${env}/${planPath}`;
    const dir = join(repoPath, relDir);
    mkdirSync(dir, { recursive: true });
    const files = formatSnapshotFiles(rules);
    const keep = new Set(files.map((f) => f.name));
    const changed: string[] = [];
    for (const f of files) {
      const full = join(dir, f.name);
      if (existsSync(full) && readFileSync(full, "utf8") === f.content) continue;
      writeFileSync(full, f.content);
      changed.push(`${relDir}/${f.name}`);
    }
    for (const name of readdirSync(dir).filter(isSnapshotFileName)) {
      if (keep.has(name)) continue;
      unlinkSync(join(dir, name));
      changed.push(`${relDir}/${name}`);
    }
    return { files_changed: changed, extras };
  };
}

function withUnchangedWarning(res: ToolResult<WriteOutput>): ToolResult<WriteOutput> {
  if (res.ok && res.data.files_changed.length === 0) {
    return { ok: true, data: res.data, warnings: [UNCHANGED_WARNING] };
  }
  return res;
}

export async function resetDevFromProd(
  ctx: ServerContext,
  args: z.infer<typeof resetDevFromProdInput>,
): Promise<ToolResult<WriteOutput & { rules_deleted: number; rules_patched: number }>> {
  if (args.confirm !== true) {
    return err(
      "VALIDATION",
      "reset_dev_from_prod deletes every rule in the DEV Segment tracking plan and replaces them with the prod snapshot.",
      { remediation: "Re-run with confirm: true to proceed." },
    );
  }
  const mode = ctx.resolveWriteMode(args.mode);
  const pre = ctx.preflightWrite(mode);
  if (pre.blocked) return { ok: false, error: pre.error };

  // Hard-coded "dev": this tool has no code path that can target prod.
  const target = resolveTarget(ctx, args.plan, "dev");
  if ("error" in target) return target.error;
  const { plan, planId: devPlanId } = target;

  const prodDir = join(ctx.repoPath, "plans", "prod", plan.path);
  const sources = existsSync(prodDir) ? readSnapshotSources(prodDir) : [];
  if (sources.length === 0) {
    return err("NOT_FOUND", `No prod snapshot found at plans/prod/${plan.path}/current-rules*.json.`, {
      remediation: `Run pull_from_segment({ plan: "${plan.name}", env: "prod" }) first.`,
    });
  }

  let counts: { deleted: number; patched: number };
  let devRules: Rule[];
  try {
    const client = ctx.segmentClient();
    counts = await resetRules(client, devPlanId, sources);
    devRules = await client.fetchAllRules(devPlanId);
  } catch (e) {
    if (e instanceof SegmentApiError) return segmentErr(e);
    throw e;
  }

  const extras = { rules_deleted: counts.deleted, rules_patched: counts.patched };
  const res = await applyWriteFlow(
    ctx,
    plan.path,
    plan.name,
    "dev from prod",
    "reset",
    mode,
    snapshotMutator(ctx.repoPath, "dev", plan.path, devRules, extras),
  );
  return withUnchangedWarning(res) as ToolResult<
    WriteOutput & { rules_deleted: number; rules_patched: number }
  >;
}

export async function pullFromSegment(
  ctx: ServerContext,
  args: z.infer<typeof pullFromSegmentInput>,
): Promise<ToolResult<WriteOutput & { rule_count: number }>> {
  const mode = ctx.resolveWriteMode(args.mode);
  const pre = ctx.preflightWrite(mode);
  if (pre.blocked) return { ok: false, error: pre.error };

  const target = resolveTarget(ctx, args.plan, args.env);
  if ("error" in target) return target.error;
  const { plan, planId } = target;

  let rules: Rule[];
  try {
    // Read-only: fetchAllRules is the only Segment call made here.
    rules = await ctx.segmentClient().fetchAllRules(planId);
  } catch (e) {
    if (e instanceof SegmentApiError) return segmentErr(e);
    throw e;
  }

  const res = await applyWriteFlow(
    ctx,
    plan.path,
    plan.name,
    `${args.env} snapshot`,
    "pull",
    mode,
    snapshotMutator(ctx.repoPath, args.env, plan.path, rules, { rule_count: rules.length }),
  );
  return withUnchangedWarning(res) as ToolResult<WriteOutput & { rule_count: number }>;
}
