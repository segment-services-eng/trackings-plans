import { z } from "zod";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ServerContext } from "../context.js";
import { err, ok, ToolResult } from "./result.js";
import { ForgeError, type WorkflowRun, type WorkflowRunStatus } from "../../lib/forge.js";
import { GitOpsError, locateBranch, pushBranch } from "../../lib/git-ops.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";

/**
 * Workflow tools. The MCP holds no Segment token: every Segment call runs in
 * a GitHub Actions workflow. These tools dispatch those workflows (always on
 * the default branch) and report on their runs. See the M4 spec's
 * "Dispatch contract".
 */

export const WORKFLOW_FILES = {
  deploy_dev: "deploy-dev.yml",
  reset_dev: "reset-dev.yml",
  prod_drift: "prod-drift.yml",
} as const;

type WorkflowKey = keyof typeof WORKFLOW_FILES;
type WorkflowFile = (typeof WORKFLOW_FILES)[WorkflowKey];

// ---------------------------------------------------------------- timing

interface WorkflowTiming {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** How long to look for the run after dispatch (it may not be listed yet). */
  lookupMs: number;
  /** Interval between findRunByRequestId / getRun polls. */
  pollMs: number;
}

const DEFAULT_TIMING: WorkflowTiming = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  lookupMs: 5000,
  pollMs: 1000,
};

let timing: WorkflowTiming = { ...DEFAULT_TIMING };

/** Test hook: override sleep/clock/intervals. Returns a restore function. */
export function __setWorkflowTiming(t: Partial<WorkflowTiming>): () => void {
  const prev = timing;
  timing = { ...timing, ...t };
  return () => {
    timing = prev;
  };
}

// ---------------------------------------------------------------- shapes

export interface WorkflowRunOutput {
  request_id?: string;
  workflow: string;
  run_id?: number;
  run_url?: string;
  status: WorkflowRunStatus;
  conclusion?: string;
  result?: unknown;
}

const waitSeconds = z.number().int().min(0).max(45).optional();

export function newRequestId(): string {
  // 4 random bytes -> 6-char base64url suffix; ~32 bits of entropy regardless of the RNG draw.
  return `mcp-${Date.now()}-${randomBytes(4).toString("base64url")}`;
}

function forgeFailure(e: unknown, message: string, extra: Record<string, unknown>): ToolResult<never> {
  const cause = e instanceof Error ? e.message : String(e);
  return err("WORKFLOW", `${message}: ${cause}`, {
    details: { ...extra, ...(e instanceof ForgeError ? { forge_code: e.code, forge_details: e.details } : {}) },
    remediation:
      "Check GitHub auth (`gh auth status` or GITHUB_TOKEN) and that the workflow exists on the default branch with a workflow_dispatch trigger.",
  });
}

function runOutput(base: { request_id?: string; workflow: string }, run: WorkflowRun | null): WorkflowRunOutput {
  if (!run) return { ...base, status: "queued" };
  return {
    ...base,
    run_id: run.id,
    run_url: run.url,
    status: run.status,
    ...(run.conclusion !== undefined ? { conclusion: run.conclusion } : {}),
  };
}

/**
 * Poll `run` until completed or `deadline`; on completion fetch the result
 * artifact. A non-success conclusion is a WORKFLOW error.
 */
async function awaitRun(
  ctx: ServerContext,
  base: { request_id?: string; workflow: string },
  run: WorkflowRun,
  deadline: number,
): Promise<ToolResult<WorkflowRunOutput>> {
  let current = run;
  try {
    while (current.status !== "completed" && timing.now() < deadline) {
      await timing.sleep(Math.min(timing.pollMs, Math.max(0, deadline - timing.now())));
      current = await ctx.forge.getRun(current.id);
    }
  } catch (e) {
    return forgeFailure(e, `Failed to read workflow run ${current.id}`, { ...base, run_id: current.id, run_url: current.url });
  }
  const out = runOutput(base, current);
  if (current.status !== "completed") return ok(out);

  const warnings: string[] = [];
  let result: unknown = null;
  try {
    result = await ctx.forge.getRunResult(current.id);
  } catch (e) {
    warnings.push(`Could not read the run's result artifact: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (result !== null) out.result = result;

  if (current.conclusion !== "success") {
    return err("WORKFLOW", `Workflow run ${current.id} (${out.workflow}) concluded "${current.conclusion ?? "unknown"}".`, {
      details: { run_id: current.id, run_url: current.url, conclusion: current.conclusion, result },
      remediation: `Open ${current.url} for the job logs and summary.`,
    });
  }
  return ok(out, warnings.length ? warnings : undefined);
}

/** Look up the run for `requestId`, retrying until `deadline`. */
async function findRun(
  ctx: ServerContext,
  workflow: string,
  requestId: string,
  deadline: number,
): Promise<WorkflowRun | null> {
  for (;;) {
    const run = await ctx.forge.findRunByRequestId(workflow, requestId);
    if (run || timing.now() >= deadline) return run;
    await timing.sleep(Math.min(timing.pollMs, Math.max(0, deadline - timing.now())));
  }
}

/** Dispatch `workflow` on the default branch, locate its run, optionally wait. */
export async function dispatchAndTrack(
  ctx: ServerContext,
  workflow: WorkflowFile,
  inputs: Record<string, string>,
  waitSec = 0,
): Promise<ToolResult<WorkflowRunOutput>> {
  const request_id = newRequestId();
  const base = { request_id, workflow };
  const start = timing.now();
  try {
    await ctx.forge.dispatchWorkflow({ workflow, ref: ctx.defaultBranch, inputs: { request_id, ...inputs } });
  } catch (e) {
    return forgeFailure(e, `Dispatch of ${workflow} was rejected`, { ...base, ref: ctx.defaultBranch });
  }
  const waitDeadline = start + waitSec * 1000;
  let run: WorkflowRun | null;
  try {
    run = await findRun(ctx, workflow, request_id, Math.max(start + timing.lookupMs, waitDeadline));
  } catch (e) {
    return forgeFailure(e, `Dispatched ${workflow} but could not look up its run`, base);
  }
  if (!run) {
    return ok(runOutput(base, null), [
      `The run is not listed yet. Call get_workflow_run({ request_id: "${request_id}", workflow: "${workflow}" }) to check on it.`,
    ]);
  }
  return awaitRun(ctx, base, run, waitDeadline);
}

function resolvePlanPath(ctx: ServerContext, plan: string | undefined): string | ToolResult<never> {
  if (plan === undefined) return "all";
  try {
    return ctx.resolvePlanOrThrow(plan).path;
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
}

// ---------------------------------------------------------------- deploy_dev

export const deployDevInput = z
  .object({
    branch: z
      .string()
      .min(1)
      .refine((b) => !b.startsWith("-"), "branch must not start with '-'"),
    plan: z.string().optional(),
    wait_seconds: waitSeconds,
  })
  .strict();

function gitOut(repoPath: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

/** True when local `branch` has no origin counterpart or has commits origin lacks. */
function needsPush(repoPath: string, branch: string): boolean {
  // Best-effort refresh so the comparison uses origin's current tip.
  gitOut(repoPath, ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const remoteRef = `refs/remotes/origin/${branch}`;
  if (gitOut(repoPath, ["rev-parse", "--verify", "--quiet", remoteRef]) === null) return true;
  const ahead = gitOut(repoPath, ["rev-list", "--count", `${remoteRef}..refs/heads/${branch}`]);
  return ahead !== null && Number(ahead) > 0;
}

export async function deployDev(
  ctx: ServerContext,
  args: z.infer<typeof deployDevInput>,
): Promise<ToolResult<WorkflowRunOutput & { pushed: boolean }>> {
  if (args.branch === ctx.defaultBranch) {
    return err("VALIDATION", `Refusing to deploy the default branch "${ctx.defaultBranch}" to Dev.`, {
      remediation: `Pass the feature/session branch whose YAML you want in Dev. "${ctx.defaultBranch}" is deployed to prod by deploy-prod.yml.`,
    });
  }
  const plan = resolvePlanPath(ctx, args.plan);
  if (typeof plan !== "string") return plan;

  let pushed = false;
  try {
    const where = locateBranch(ctx.repoPath, args.branch);
    if (where === null) {
      return err("NOT_FOUND", `Branch "${args.branch}" does not exist locally or on origin.`, {
        remediation: "Check the branch name (the author tools return it as `branch`).",
      });
    }
    if (where === "local" && needsPush(ctx.repoPath, args.branch)) {
      pushBranch(ctx.repoPath, args.branch);
      pushed = true;
    }
  } catch (e) {
    if (e instanceof GitOpsError) {
      return err("GIT", e.message, {
        details: e.details,
        ...(e.remediation ? { remediation: e.remediation } : {}),
      });
    }
    throw e;
  }

  const res = await dispatchAndTrack(ctx, WORKFLOW_FILES.deploy_dev, { plan, ref: args.branch }, args.wait_seconds);
  if (!res.ok) return res;
  return { ...res, data: { ...res.data, pushed } };
}

// ---------------------------------------------------------------- reset_dev

export const resetDevInput = z
  .object({
    plan: z.string().optional(),
    confirm: z.boolean().optional(),
    wait_seconds: waitSeconds,
  })
  .strict();

export async function resetDev(
  ctx: ServerContext,
  args: z.infer<typeof resetDevInput>,
): Promise<ToolResult<WorkflowRunOutput>> {
  if (args.confirm !== true) {
    return err("VALIDATION", "reset_dev replaces the shared Dev Segment tracking plan with the prod snapshot.", {
      remediation: "re-run with confirm: true; this overwrites the shared Dev tracking plan with prod",
    });
  }
  const plan = resolvePlanPath(ctx, args.plan);
  if (typeof plan !== "string") return plan;
  return dispatchAndTrack(ctx, WORKFLOW_FILES.reset_dev, { plan }, args.wait_seconds);
}

// ---------------------------------------------------------------- check_prod_drift

export const checkProdDriftInput = z.object({ wait_seconds: waitSeconds }).strict();

export async function checkProdDrift(
  ctx: ServerContext,
  args: z.infer<typeof checkProdDriftInput>,
): Promise<ToolResult<WorkflowRunOutput>> {
  return dispatchAndTrack(ctx, WORKFLOW_FILES.prod_drift, {}, args.wait_seconds);
}

// ---------------------------------------------------------------- get_workflow_run

const workflowNames = [...Object.keys(WORKFLOW_FILES), ...Object.values(WORKFLOW_FILES)] as [string, ...string[]];

export const getWorkflowRunInput = z
  .object({
    run_id: z.number().int().positive().optional(),
    request_id: z.string().min(1).optional(),
    workflow: z.enum(workflowNames).optional(),
    wait_seconds: waitSeconds,
  })
  .strict();

function workflowFile(name: string): string {
  return (WORKFLOW_FILES as Record<string, string>)[name] ?? name;
}

export async function getWorkflowRun(
  ctx: ServerContext,
  args: z.infer<typeof getWorkflowRunInput>,
): Promise<ToolResult<WorkflowRunOutput>> {
  const deadline = timing.now() + (args.wait_seconds ?? 0) * 1000;
  if (args.run_id !== undefined) {
    let run: WorkflowRun;
    try {
      run = await ctx.forge.getRun(args.run_id);
    } catch (e) {
      return forgeFailure(e, `Failed to read workflow run ${args.run_id}`, { run_id: args.run_id });
    }
    const workflow = args.workflow ? workflowFile(args.workflow) : run.workflow;
    return awaitRun(ctx, { ...(args.request_id ? { request_id: args.request_id } : {}), workflow }, run, deadline);
  }
  if (!args.request_id || !args.workflow) {
    return err("VALIDATION", "get_workflow_run needs run_id, or request_id together with workflow.", {
      remediation: `Pass the run_id or request_id + workflow returned by deploy_dev / reset_dev / check_prod_drift. workflow is one of: ${workflowNames.join(", ")}.`,
    });
  }
  const workflow = workflowFile(args.workflow);
  const base = { request_id: args.request_id, workflow };
  let run: WorkflowRun | null;
  try {
    run = await findRun(ctx, workflow, args.request_id, deadline);
  } catch (e) {
    return forgeFailure(e, `Failed to look up the ${workflow} run for ${args.request_id}`, base);
  }
  if (!run) {
    return err("NOT_FOUND", `No ${workflow} run found for request_id "${args.request_id}".`, {
      remediation: "If it was dispatched moments ago GitHub may not list it yet; retry in a few seconds (or pass wait_seconds).",
    });
  }
  return awaitRun(ctx, base, run, deadline);
}
