import { execFileSync } from "node:child_process";

export type GitOpsCode = "DIRTY_TREE" | "GIT";

export class GitOpsError extends Error {
  constructor(
    readonly code: GitOpsCode,
    message: string,
    readonly details?: unknown,
    readonly remediation?: string,
  ) {
    super(message);
  }
}

function git(repoPath: string, args: string[], input?: string): string {
  try {
    return execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: any) {
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    throw new GitOpsError("GIT", `git ${args.join(" ")} failed: ${stderr || e.message}`);
  }
}

export interface WorkingTreeStatus {
  clean: boolean;
  dirty_files: string[];
  current_branch: string;
}

export function getWorkingTreeStatus(repoPath: string): WorkingTreeStatus {
  const porcelain = git(repoPath, ["status", "--porcelain"]);
  const dirty_files = porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  const branch = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  return { clean: dirty_files.length === 0, dirty_files, current_branch: branch };
}

export function assertCleanTree(repoPath: string): void {
  const status = getWorkingTreeStatus(repoPath);
  if (!status.clean) {
    throw new GitOpsError(
      "DIRTY_TREE",
      `Working tree has uncommitted changes: ${status.dirty_files.join(", ")}`,
      { dirty_files: status.dirty_files, current_branch: status.current_branch },
    );
  }
}

/**
 * @deprecated Use `ctx.defaultBranch` (the `default_branch` config). Kept only
 * so `mcp/tools/admin.ts` compiles until those tools are removed in M4.
 */
export const BASE_BRANCH = "main";

function hasOrigin(repoPath: string): boolean {
  try {
    git(repoPath, ["remote", "get-url", "origin"]);
    return true;
  } catch {
    return false;
  }
}

function refExists(repoPath: string, ref: string): boolean {
  try {
    git(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ref `createBranch` bases new branches on: local `baseBranch` when it
 * exists, otherwise `HEAD`. Readers that must see the same content the tp
 * branch starts from should read from this ref.
 */
export function branchBaseRef(repoPath: string, baseBranch: string = "main"): string {
  return refExists(repoPath, `refs/heads/${baseBranch}`) ? baseBranch : "HEAD";
}

/**
 * Create and check out a new branch based on local `baseBranch` (the repo's
 * default branch). Best-effort `git fetch origin <baseBranch>` first when an
 * origin remote exists. Falls back to `HEAD` if local `baseBranch` doesn't exist.
 */
export function createBranch(repoPath: string, branchName: string, baseBranch: string): void {
  if (hasOrigin(repoPath)) {
    try {
      git(repoPath, ["fetch", "origin", baseBranch]);
    } catch {
      // proceed even if fetch fails; local base branch will be used
    }
  }
  git(repoPath, ["checkout", "-b", branchName, branchBaseRef(repoPath, baseBranch)]);
}

/**
 * Where an existing branch lives: `"local"` (refs/heads), `"remote"` (only on
 * origin — fetched into refs/remotes/origin), or `null` when it exists nowhere.
 */
export function locateBranch(repoPath: string, branchName: string): "local" | "remote" | null {
  if (refExists(repoPath, `refs/heads/${branchName}`)) return "local";
  if (!hasOrigin(repoPath)) return null;
  try {
    git(repoPath, [
      "fetch",
      "origin",
      `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
    ]);
  } catch {
    return null; // not on origin (or origin unreachable)
  }
  return refExists(repoPath, `refs/remotes/origin/${branchName}`) ? "remote" : null;
}

/** Create local `branchName` tracking `origin/<branchName>` and check it out. */
export function checkoutTrackingBranch(repoPath: string, branchName: string): void {
  git(repoPath, ["checkout", "-b", branchName, "--track", `origin/${branchName}`]);
}

/** Full sha of `ref`. */
export function revParse(repoPath: string, ref: string): string {
  return git(repoPath, ["rev-parse", "--verify", ref]).trim();
}

/** Switch to an existing branch. Throws GitOpsError on failure. */
export function checkoutBranch(repoPath: string, branchName: string): void {
  git(repoPath, ["checkout", branchName]);
}

/** Force-delete a local branch. Throws GitOpsError on failure. */
export function deleteBranch(repoPath: string, branchName: string): void {
  git(repoPath, ["branch", "-D", branchName]);
}

/**
 * Fully roll back the working tree AND index to `ref` (default HEAD):
 * `git reset --hard <ref>` drops staged adds/deletes and restores tracked
 * files; `git clean -fd` then removes `paths` plus any untracked files still
 * present. Write tools only run on a clean tree (dirty-tree rule), so every
 * untracked file at this point was created by the failed write.
 */
export function discardWorkingTreeChanges(
  repoPath: string,
  paths: string[] = [],
  ref: string = "HEAD",
): void {
  git(repoPath, ["reset", "--hard", ref]);
  const leftovers = getWorkingTreeStatus(repoPath).dirty_files;
  const toClean = [...new Set([...paths, ...leftovers])];
  if (toClean.length > 0) git(repoPath, ["clean", "-fd", "--", ...toClean]);
}

/** Names (not paths) of the blobs directly under `dir` at `ref`; [] if absent. */
export function listFilesAtRef(repoPath: string, ref: string, dir: string): string[] {
  const prefix = dir.replace(/\/+$/, "") + "/";
  const out = git(repoPath, ["ls-tree", "--name-only", ref, "--", prefix]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p));
}

/** Contents of `path` at `ref` (`git show <ref>:<path>`). */
export function readFileAtRef(repoPath: string, ref: string, path: string): string {
  return git(repoPath, ["show", `${ref}:${path}`]);
}

export function commitPaths(
  repoPath: string,
  paths: string[],
  message: string,
): string {
  if (paths.length === 0) throw new GitOpsError("GIT", "No paths to commit");
  git(repoPath, ["add", "--", ...paths]);
  git(repoPath, ["commit", "-m", message]);
  return git(repoPath, ["rev-parse", "HEAD"]).trim();
}

/**
 * `git push -u origin <branch>`. Never forces. A rejected (non-fast-forward)
 * push throws GitOpsError("GIT") with `details.reason = "non_fast_forward"`
 * and a pull/rebase remediation.
 */
export function pushBranch(repoPath: string, branchName: string): void {
  try {
    git(repoPath, ["push", "-u", "origin", branchName]);
  } catch (e) {
    const msg = (e as Error).message;
    if (/\[rejected\]|non-fast-forward|fetch first|\(stale info\)/i.test(msg)) {
      throw new GitOpsError(
        "GIT",
        `Push of "${branchName}" was rejected: origin/${branchName} has commits this clone does not.`,
        { reason: "non_fast_forward", branch: branchName, stderr: msg },
        `Run \`git checkout ${branchName} && git pull --rebase origin ${branchName}\` (then return to your branch) and retry. The MCP never force-pushes.`,
      );
    }
    throw e;
  }
}
