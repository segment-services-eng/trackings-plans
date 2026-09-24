import { z } from "zod";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerContext, WriteMode } from "../context.js";
import { err, ToolResult } from "./result.js";
import {
  BASE_BRANCH,
  branchBaseRef,
  getWorkingTreeStatus,
  GitOpsError,
  listFilesAtRef,
  readFileAtRef,
} from "../../lib/git-ops.js";
import { applyWriteFlow, type MutatorResult, type WriteOutput } from "./write-flow.js";
import { PlanNotFoundError, getPlanIdEnvVar, type PlanConfig } from "../../lib/plans-config.js";
import { SegmentApiError, type Rule } from "../../lib/segment-api.js";
import {
  formatSnapshotFiles,
  isSnapshotFileName,
  parseSnapshotSource,
  readSnapshotSources,
  resetRules,
  type SnapshotSource,
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

/**
 * Refuse a DEV reset whose target could be a PROD plan: the plan's dev_secret
 * names any plan's prod_secret env var, or the resolved DEV plan id equals any
 * configured PROD plan id. Must run before any Segment call.
 */
function prodWriteBlocked(
  ctx: ServerContext,
  plan: PlanConfig,
  devPlanId?: string,
): ToolResult<never> | undefined {
  const bySecret = ctx.plans.find((p) => p.prod_secret === plan.dev_secret);
  if (bySecret) {
    return err(
      "PROD_WRITE_BLOCKED",
      `Plan "${plan.name}" dev_secret (${plan.dev_secret}) is the prod_secret of plan "${bySecret.name}". Refusing to reset a PROD tracking plan.`,
      {
        remediation:
          "Fix config/tracking-plans-config.json so every dev_secret names a DEV-only env var.",
      },
    );
  }
  if (devPlanId) {
    const byId = ctx.plans.find((p) => ctx.planIdEnv(p.path, "prod") === devPlanId);
    if (byId) {
      return err(
        "PROD_WRITE_BLOCKED",
        `${plan.dev_secret} resolves to the PROD tracking plan id of "${byId.name}" (${byId.prod_secret}). Refusing to reset a PROD tracking plan.`,
        {
          remediation: `Set ${plan.dev_secret} to the DEV Segment tracking plan id for "${plan.name}".`,
        },
      );
    }
  }
  return undefined;
}

/**
 * Prod snapshot sources for the reset. branch/pr: read from the ref the tp
 * branch is created from (main), matching the RESET_DEV workflow's
 * `ref: main`. files: read the working tree, warning when not on main.
 */
function loadProdSources(
  ctx: ServerContext,
  planPath: string,
  mode: WriteMode,
): { sources: SnapshotSource[]; from: string; warnings: string[] } {
  const relDir = `plans/prod/${planPath}`;
  if (mode !== "files") {
    const ref = branchBaseRef(ctx.repoPath);
    const names = listFilesAtRef(ctx.repoPath, ref, relDir).filter(isSnapshotFileName).sort();
    const sources = names.map((n) =>
      parseSnapshotSource(n, readFileAtRef(ctx.repoPath, ref, `${relDir}/${n}`)),
    );
    return { sources, from: `${ref}:${relDir}`, warnings: [] };
  }
  const dir = join(ctx.repoPath, relDir);
  const sources = existsSync(dir) ? readSnapshotSources(dir) : [];
  const warnings: string[] = [];
  let current: string | undefined;
  try {
    current = getWorkingTreeStatus(ctx.repoPath).current_branch;
  } catch {
    current = undefined; // not a git checkout; nothing to compare
  }
  if (current !== undefined && current !== BASE_BRANCH) {
    warnings.push(
      `files mode read the prod snapshot from the working tree on branch "${current}", not "${BASE_BRANCH}". ` +
        `The RESET_DEV workflow resets from ${BASE_BRANCH}; DEV may not match the reviewed prod snapshot.`,
    );
  }
  return { sources, from: relDir, warnings };
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
  let plan: PlanConfig;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const secretBlocked = prodWriteBlocked(ctx, plan);
  if (secretBlocked) return secretBlocked;
  const target = resolveTarget(ctx, args.plan, "dev");
  if ("error" in target) return target.error;
  const devPlanId = target.planId;
  const idBlocked = prodWriteBlocked(ctx, plan, devPlanId);
  if (idBlocked) return idBlocked;

  let loaded: ReturnType<typeof loadProdSources>;
  try {
    loaded = loadProdSources(ctx, plan.path, mode);
  } catch (e) {
    if (e instanceof GitOpsError) {
      return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
  const { sources, from, warnings: sourceWarnings } = loaded;
  if (sources.length === 0) {
    return err("NOT_FOUND", `No prod snapshot found at ${from}/current-rules*.json.`, {
      remediation: `Run pull_from_segment({ plan: "${plan.name}", env: "prod" }) and merge it to ${BASE_BRANCH} first.`,
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
  const res = withUnchangedWarning(
    await applyWriteFlow(
      ctx,
      plan.path,
      plan.name,
      "dev from prod",
      "reset",
      mode,
      snapshotMutator(ctx.repoPath, "dev", plan.path, devRules, extras),
    ),
  );
  if (!res.ok) {
    // Segment was already reset; only the local snapshot write failed.
    return {
      ok: false,
      error: {
        ...res.error,
        details: {
          ...extras,
          ...(res.error.details !== undefined ? { cause: res.error.details } : {}),
        },
        remediation:
          `The DEV Segment tracking plan WAS reset (${counts.deleted} rules deleted, ${counts.patched} patched), ` +
          `but writing the local dev snapshot failed. Fix the git error, then run ` +
          `pull_from_segment({ plan: "${plan.name}", env: "dev" }) to re-sync plans/dev/${plan.path}/.`,
      },
    };
  }
  const warnings = [...sourceWarnings, ...(res.warnings ?? [])];
  return {
    ok: true,
    data: res.data as WriteOutput & { rules_deleted: number; rules_patched: number },
    ...(warnings.length ? { warnings } : {}),
  };
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
