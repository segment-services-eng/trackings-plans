import { execFileSync } from "node:child_process";

export type GitOpsCode = "DIRTY_TREE" | "GIT" | "GH_CLI" | "GITHUB_API";

export class GitOpsError extends Error {
  constructor(
    readonly code: GitOpsCode,
    message: string,
    readonly details?: unknown,
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

export function createBranch(repoPath: string, branchName: string): void {
  const hasOrigin = (() => {
    try {
      git(repoPath, ["remote", "get-url", "origin"]);
      return true;
    } catch {
      return false;
    }
  })();
  if (hasOrigin) {
    try {
      git(repoPath, ["fetch", "origin", "main"]);
    } catch {
      // proceed even if fetch fails; local main will be used
    }
    git(repoPath, ["checkout", "-b", branchName, "origin/main"]);
  } else {
    git(repoPath, ["checkout", "-b", branchName]);
  }
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

export function pushBranch(repoPath: string, branchName: string): void {
  git(repoPath, ["push", "-u", "origin", branchName]);
}

export interface OpenPullRequestOptions {
  branch: string;
  title: string;
  body: string;
  base?: string;
}

export async function openPullRequest(
  repoPath: string,
  opts: OpenPullRequestOptions,
): Promise<{ pr_url: string; pr_number: number }> {
  const base = opts.base ?? "main";
  try {
    const out = execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--base",
        base,
        "--head",
        opts.branch,
        "--title",
        opts.title,
        "--body",
        opts.body,
      ],
      { cwd: repoPath, encoding: "utf8" },
    ).trim();
    const prMatch = out.match(/\/pull\/(\d+)/);
    if (!prMatch) {
      throw new GitOpsError("GH_CLI", `Could not parse PR URL from gh output: ${out}`);
    }
    return { pr_url: out, pr_number: Number(prMatch[1]) };
  } catch (e: any) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new GitOpsError(
        "GH_CLI",
        `gh pr create failed and GITHUB_TOKEN is not set: ${e.stderr ?? e.message}`,
      );
    }
    return openPullRequestViaOctokit(repoPath, opts, base, token);
  }
}

async function openPullRequestViaOctokit(
  repoPath: string,
  opts: OpenPullRequestOptions,
  base: string,
  token: string,
): Promise<{ pr_url: string; pr_number: number }> {
  const { Octokit } = await import("@octokit/rest");
  const url = git(repoPath, ["config", "--get", "remote.origin.url"]).trim();
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new GitOpsError("GITHUB_API", `Cannot parse owner/repo from origin: ${url}`);
  }
  const [, owner, repo] = match;
  const octokit = new Octokit({ auth: token });
  try {
    const res = await octokit.pulls.create({
      owner,
      repo,
      head: opts.branch,
      base,
      title: opts.title,
      body: opts.body,
    });
    return { pr_url: res.data.html_url, pr_number: res.data.number };
  } catch (e: any) {
    throw new GitOpsError("GITHUB_API", `Octokit PR create failed: ${e.message}`, e);
  }
}
