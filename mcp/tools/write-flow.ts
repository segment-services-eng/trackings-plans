import type { ServerContext, WriteMode } from "../context.js";
import { ok, err, ToolResult, ToolResultError } from "./result.js";
import {
  createBranch,
  commitPaths,
  pushBranch,
  GitOpsError,
  getWorkingTreeStatus,
  checkoutBranch,
  checkoutTrackingBranch,
  deleteBranch,
  discardWorkingTreeChanges,
  locateBranch,
  revParse,
} from "../../lib/git-ops.js";
import { ForgeError } from "../../lib/forge.js";

export interface WriteOutput {
  files_changed: string[];
  mode: WriteMode;
  branch?: string;
  commit_sha?: string;
  /** True when the write was appended to a caller-supplied existing branch. */
  reused_branch?: boolean;
  pr_url?: string;
  pr_number?: number;
  /** True when pr mode found an already-open PR for the branch. */
  pr_reused?: boolean;
  next_steps?: string;
  [k: string]: unknown;
}

export interface MutatorResult {
  files_changed: string[];
  extras?: Record<string, unknown>;
}

/**
 * Thrown by a mutator to refuse the write with a typed error (e.g. VALIDATION
 * when the event already exists on the target branch). The write flow rolls
 * back exactly as for any other failure and returns `error` unchanged.
 */
export class WriteAbort extends Error {
  constructor(readonly error: ToolResultError) {
    super(error.message);
    this.name = "WriteAbort";
  }
}

export function abort(
  code: ToolResultError["code"],
  message: string,
  extras?: { details?: unknown; remediation?: string },
): never {
  throw new WriteAbort({ code, message, ...extras });
}

export interface WriteFlowOptions {
  /**
   * Existing session branch to append to (from a previous call's `branch`).
   * Omit to create a fresh tp/… branch off the default branch.
   */
  branch?: string;
  now?: number;
}

export function slugify(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export type WriteVerb = "add" | "update" | "remove" | "reset" | "pull";

/**
 * Commit subject. Event verbs: `<verb> event "<key>"`. Admin verbs ("reset",
 * "pull") treat `key` as a free-form object, e.g. `pull prod snapshot`.
 */
export function commitSubject(planPath: string, verb: WriteVerb, key: string): string {
  const body =
    verb === "reset" || verb === "pull" ? `${verb} ${key}` : `${verb} event "${key}"`;
  return `[tp:${planPath}] ${body}`;
}

export function branchName(planPath: string, key: string, verb: string, now: number): string {
  return `tp/${planPath}/${verb}-${slugify(key)}-${now}`;
}

function toToolError(e: unknown): ToolResultError {
  if (e instanceof WriteAbort) return e.error;
  if (e instanceof GitOpsError) {
    return {
      code: e.code,
      message: e.message,
      details: e.details,
      ...(e.remediation ? { remediation: e.remediation } : {}),
    };
  }
  if (e instanceof ForgeError) return { code: e.code, message: e.message, details: e.details };
  return { code: "UNKNOWN", message: `Unexpected error: ${(e as Error).message}` };
}

/**
 * Core write-flow for all mutating MCP tools.
 *
 * - "files" mode: run the mutator inline, no git branch/commit. `branch` is
 *   ignored with a warning.
 * - "branch" / "pr" mode:
 *   1. Record the caller's current branch so it can be restored.
 *   2. Check out the target: the caller-supplied existing `branch` (local, or
 *      a tracking branch when it only exists on origin), or a new tp/… branch
 *      off `ctx.defaultBranch`. Record the target's pre-call sha.
 *   3. Run the mutator on the target. Mutators validate against the target's
 *      files and may `abort()` with a typed error.
 *   4. Zero files → no commit; a new branch is deleted, an existing one kept.
 *   5. Commit; in pr mode push (never forced) and reuse the open PR for the
 *      branch if there is one, otherwise open one against the default branch.
 *   6. On any failure before the push lands: hard-reset the target to its
 *      pre-call sha, clean files the write created, restore the caller's
 *      branch, and delete the target only if this call created it. After a
 *      successful push nothing is rolled back, so local and origin agree.
 */
export async function applyWriteFlow(
  ctx: ServerContext,
  planPath: string,
  _planName: string,
  key: string,
  verb: WriteVerb,
  mode: WriteMode,
  mutator: () => MutatorResult,
  opts: WriteFlowOptions = {},
): Promise<ToolResult<WriteOutput>> {
  const pre = ctx.preflightWrite(mode);
  if (pre.blocked) return { ok: false, error: pre.error };

  if (mode === "files") {
    const warnings = opts.branch
      ? [`branch "${opts.branch}" ignored in files mode; edits were made in the working tree.`]
      : undefined;
    try {
      const { files_changed, extras } = mutator();
      return ok({ files_changed, mode, ...(extras ?? {}) }, warnings);
    } catch (e) {
      if (e instanceof WriteAbort) return { ok: false, error: e.error };
      throw e;
    }
  }

  const reused = opts.branch !== undefined;
  if (reused && opts.branch === ctx.defaultBranch) {
    return err(
      "VALIDATION",
      `Refusing to write directly to the default branch "${ctx.defaultBranch}".`,
      { remediation: "Omit branch to create a new tp/… branch, or pass a session branch." },
    );
  }

  const originalBranch = getWorkingTreeStatus(ctx.repoPath).current_branch;
  const target = opts.branch ?? branchName(planPath, key, verb, opts.now ?? Date.now());
  let onTarget = false;
  /** This call created the tp/… branch (never true for a reused branch). */
  let createdNew = false;
  let preSha: string | undefined;
  let pushed = false;
  let failed = false;
  let changedPaths: string[] = [];

  try {
    if (reused) {
      const where = locateBranch(ctx.repoPath, target);
      if (where === null) {
        return err("NOT_FOUND", `Branch "${target}" does not exist locally or on origin.`, {
          remediation:
            "Omit branch to create one, or pass the branch returned by an earlier call.",
        });
      }
      if (where === "remote") {
        checkoutTrackingBranch(ctx.repoPath, target);
      } else if (target !== originalBranch) {
        checkoutBranch(ctx.repoPath, target);
      }
    } else {
      createBranch(ctx.repoPath, target, ctx.defaultBranch);
      createdNew = true;
    }
    onTarget = true;
    preSha = revParse(ctx.repoPath, "HEAD");

    const { files_changed, extras } = mutator();
    changedPaths = files_changed;

    if (files_changed.length === 0) {
      cleanupTarget(ctx, originalBranch, target, { deleteBranch: createdNew });
      onTarget = false;
      return ok(
        { files_changed: [], mode, ...(reused ? { branch: target, reused_branch: true } : {}), ...(extras ?? {}) },
        ["No files matched — no changes to commit."],
      );
    }

    const subject = commitSubject(planPath, verb, key);
    const commit_sha = commitPaths(
      ctx.repoPath,
      files_changed,
      `${subject}\n\n- Generated via tracking-plans-mcp`,
    );
    const base = { files_changed, mode, branch: target, commit_sha, reused_branch: reused };

    if (mode === "branch") {
      return ok({
        ...base,
        next_steps:
          `Pass branch: "${target}" to further write tools to keep this session on one branch; ` +
          `push with \`git push -u origin ${target}\` or use mode: "pr".`,
        ...(extras ?? {}),
      });
    }

    pushBranch(ctx.repoPath, target);
    pushed = true;
    const existing = await ctx.forge.findOpenPullRequest(target);
    const pr =
      existing ??
      (await ctx.forge.openPullRequest({
        branch: target,
        base: ctx.defaultBranch,
        title: subject,
        body: `Generated by tracking-plans-mcp.\n\nFiles changed:\n${files_changed
          .map((f) => `- \`${f}\``)
          .join("\n")}`,
      }));
    try {
      await ctx.forge.addLabels(pr.number, ["deploy-dev"]);
    } catch {
      // Label attach is best-effort — deploy-dev gate is convenience, not correctness.
    }
    return ok({
      ...base,
      pr_url: pr.url,
      pr_number: pr.number,
      pr_reused: existing !== null,
      ...(extras ?? {}),
    });
  } catch (e) {
    failed = true;
    const error = toToolError(e);
    if (pushed) {
      // The commit is on origin; keep it so a retry with `branch` fast-forwards.
      return {
        ok: false,
        error: {
          ...error,
          details: { cause: error.details, branch: target, pushed: true },
          remediation:
            error.remediation ??
            `The commit was pushed to "${target}" but the PR step failed. Retry with branch: "${target}".`,
        },
      };
    }
    if (onTarget && preSha) {
      try {
        discardWorkingTreeChanges(ctx.repoPath, changedPaths, preSha);
      } catch {
        /* best effort */
      }
    }
    return { ok: false, error };
  } finally {
    // Always return the caller to where they started. A branch this call
    // created is deleted only on failure before anything reached origin.
    if (onTarget) {
      cleanupTarget(ctx, originalBranch, target, {
        deleteBranch: failed && createdNew && !pushed,
      });
    }
  }
}

function cleanupTarget(
  ctx: ServerContext,
  originalBranch: string,
  target: string,
  opts: { deleteBranch: boolean },
): void {
  if (target !== originalBranch) {
    try {
      checkoutBranch(ctx.repoPath, originalBranch);
    } catch {
      /* best effort */
    }
  }
  if (opts.deleteBranch && target !== originalBranch) {
    try {
      deleteBranch(ctx.repoPath, target);
    } catch {
      /* best effort */
    }
  }
}
