import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unzipSync } from "fflate";
import type { ForgeClient, PullRequest, WorkflowRun, WorkflowRunStatus } from "./forge.js";
import { ForgeError } from "./forge.js";

/** Command runner: returns stdout, throws on non-zero exit (error may carry `stderr`). */
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => string | Promise<string>;

interface OctoPull {
  number: number;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

interface OctoRun {
  id: number;
  name?: string | null;
  display_title?: string | null;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  path?: string | null;
}

/** The subset of the Octokit REST client this module uses. */
export interface OctokitLike {
  pulls: {
    list(p: {
      owner: string;
      repo: string;
      state: "open";
      head: string;
      per_page?: number;
    }): Promise<{ data: OctoPull[] }>;
    create(p: {
      owner: string;
      repo: string;
      head: string;
      base: string;
      title: string;
      body: string;
    }): Promise<{ data: OctoPull }>;
  };
  actions: {
    createWorkflowDispatch(p: {
      owner: string;
      repo: string;
      workflow_id: string;
      ref: string;
      inputs: Record<string, string>;
    }): Promise<unknown>;
    listWorkflowRuns(p: {
      owner: string;
      repo: string;
      workflow_id: string;
      event: string;
      per_page: number;
    }): Promise<{ data: { workflow_runs: OctoRun[] } }>;
    getWorkflowRun(p: { owner: string; repo: string; run_id: number }): Promise<{ data: OctoRun }>;
    listWorkflowRunArtifacts(p: {
      owner: string;
      repo: string;
      run_id: number;
      per_page?: number;
    }): Promise<{ data: { artifacts: { id: number; name: string }[] } }>;
    downloadArtifact(p: {
      owner: string;
      repo: string;
      artifact_id: number;
      archive_format: "zip";
    }): Promise<{ data: unknown }>;
  };
}

export interface GitHubForgeOptions {
  repoPath: string;
  /** GITHUB_TOKEN / GH_TOKEN for the Octokit fallback when `gh` is unavailable. */
  token?: string;
  /** Command runner (default: execFileSync, utf8, throws on non-zero exit). */
  run?: CommandRunner;
  /** Octokit constructor (default: `new Octokit({ auth })` from `@octokit/rest`). */
  octokitFactory?: (token: string) => OctokitLike | Promise<OctokitLike>;
  /** Reserved for polling helpers; the client itself does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultRun: CommandRunner = (cmd, args, { cwd }) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const defaultOctokitFactory = async (token: string): Promise<OctokitLike> => {
  const { Octokit } = await import("@octokit/rest");
  return new Octokit({ auth: token }) as unknown as OctokitLike;
};

/** Parse owner/repo from an HTTPS, scp-style SSH, or ssh:// remote URL. */
export function parseRemoteUrl(url: string): { owner: string; repo: string } | null {
  const m = url
    .trim()
    .match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?[^/:]+(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const parts = m[1].split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts.slice(-2);
  return { owner, repo };
}

/** Map GitHub run status to the three-state WorkflowRunStatus. */
export function mapStatus(status: string | null | undefined): WorkflowRunStatus {
  const s = (status ?? "").toLowerCase();
  if (s === "completed") return "completed";
  if (s === "in_progress") return "in_progress";
  return "queued"; // queued, waiting, pending, requested (and unknown)
}

function toRun(r: {
  id: number;
  workflow: string;
  url: string;
  status: string | null | undefined;
  conclusion: string | null | undefined;
  name: string | null | undefined;
}): WorkflowRun {
  const status = mapStatus(r.status);
  const run: WorkflowRun = { id: r.id, workflow: r.workflow, url: r.url, status, name: r.name ?? "" };
  if (status === "completed" && r.conclusion) run.conclusion = r.conclusion.toLowerCase();
  return run;
}

function errText(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown } | undefined;
  const raw = err?.stderr;
  const stderr =
    typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
  return (stderr.trim() || String(err?.message ?? e)).trim();
}

const MISSING_ARTIFACT = /no artifact|no valid artifacts|artifact not found/i;

/**
 * GitHub ForgeClient: `gh` CLI first, Octokit + token fallback.
 * The token is only handed to the Octokit factory; it is never logged or put in errors.
 */
export function createGitHubForge(opts: GitHubForgeOptions): ForgeClient {
  const run = opts.run ?? defaultRun;
  const token = opts.token;
  const makeOctokit = opts.octokitFactory ?? defaultOctokitFactory;
  const cwd = opts.repoPath;
  /** run id -> workflow file, learned from findRunByRequestId, so getRun can report it. */
  const runWorkflows = new Map<number, string>();

  let repoCache: { owner: string; repo: string } | undefined;
  let octoCache: OctokitLike | undefined;

  async function repoInfo(): Promise<{ owner: string; repo: string }> {
    if (repoCache) return repoCache;
    let url: string;
    try {
      url = String(await run("git", ["config", "--get", "remote.origin.url"], { cwd })).trim();
    } catch (e) {
      throw new ForgeError("GITHUB_API", `Cannot read remote.origin.url: ${errText(e)}`);
    }
    const parsed = parseRemoteUrl(url);
    if (!parsed) {
      throw new ForgeError("GITHUB_API", `Cannot parse owner/repo from remote URL "${url}"`);
    }
    repoCache = parsed;
    return parsed;
  }

  const gh = async (args: string[]): Promise<string> => String(await run("gh", args, { cwd }));

  /** gh first; on failure fall back to Octokit when a token is set. */
  async function via<T>(
    op: string,
    ghFn: () => Promise<T>,
    octoFn: (o: OctokitLike, r: { owner: string; repo: string }) => Promise<T>,
  ): Promise<T> {
    let ghError: string;
    try {
      return await ghFn();
    } catch (e) {
      ghError = e instanceof ForgeError ? e.message : errText(e);
      if (!token) {
        if (e instanceof ForgeError) throw e;
        throw new ForgeError("GH_CLI", `gh ${op} failed (no token for API fallback): ${ghError}`, {
          stderr: ghError,
        });
      }
    }
    try {
      const r = await repoInfo();
      octoCache ??= await makeOctokit(token);
      return await octoFn(octoCache, r);
    } catch (e) {
      if (e instanceof ForgeError) throw e;
      const err = e as { status?: number; message?: string } | undefined;
      throw new ForgeError("GITHUB_API", `GitHub API ${op} failed: ${err?.message ?? String(e)}`, {
        status: err?.status,
        ghError,
      });
    }
  }

  function parseJson<T>(out: string, op: string): T {
    try {
      return JSON.parse(out) as T;
    } catch {
      throw new ForgeError("GH_CLI", `gh ${op}: could not parse JSON output`, {
        stdout: out.slice(0, 500),
      });
    }
  }

  const remember = (r: WorkflowRun): WorkflowRun => {
    runWorkflows.set(r.id, r.workflow);
    return r;
  };

  return {
    kind: "github",

    findOpenPullRequest: (branch) =>
      via(
        "pr list",
        async () => {
          const out = await gh([
            "pr", "list", "--head", branch, "--state", "open",
            "--json", "number,url,headRefName,baseRefName", "--limit", "1",
          ]);
          const prs = parseJson<
            { number: number; url: string; headRefName: string; baseRefName: string }[]
          >(out, "pr list");
          const p = prs[0];
          return p
            ? { number: p.number, url: p.url, branch: p.headRefName, base: p.baseRefName }
            : null;
        },
        async (o, { owner, repo }) => {
          const { data } = await o.pulls.list({
            owner, repo, state: "open", head: `${owner}:${branch}`, per_page: 1,
          });
          const p = data[0];
          return p
            ? { number: p.number, url: p.html_url, branch: p.head.ref, base: p.base.ref }
            : null;
        },
      ),

    openPullRequest: ({ branch, base, title, body }) =>
      via<PullRequest>(
        "pr create",
        async () => {
          const out = await gh([
            "pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body,
          ]);
          const m = out.match(/https?:\/\/\S+\/pull\/(\d+)/);
          if (!m) throw new ForgeError("GH_CLI", `gh pr create: no PR URL in output: ${out.trim()}`);
          return { number: Number(m[1]), url: m[0], branch, base };
        },
        async (o, { owner, repo }) => {
          const { data } = await o.pulls.create({ owner, repo, head: branch, base, title, body });
          return { number: data.number, url: data.html_url, branch, base };
        },
      ),

    dispatchWorkflow: ({ workflow, ref, inputs }) =>
      via(
        "workflow run",
        async () => {
          const fields = Object.entries(inputs).flatMap(([k, v]) => ["-f", `${k}=${v}`]);
          await gh(["workflow", "run", workflow, "--ref", ref, ...fields]);
        },
        async (o, { owner, repo }) => {
          await o.actions.createWorkflowDispatch({ owner, repo, workflow_id: workflow, ref, inputs });
        },
      ),

    findRunByRequestId: (workflow, requestId) => {
      const tag = `[${requestId}]`;
      return via(
        "run list",
        async () => {
          const out = await gh([
            "run", "list", "--workflow", workflow, "--event", "workflow_dispatch", "--limit", "20",
            "--json", "databaseId,displayTitle,status,conclusion,url",
          ]);
          const runs = parseJson<
            { databaseId: number; displayTitle: string; status: string; conclusion: string; url: string }[]
          >(out, "run list");
          const r = runs.find((x) => (x.displayTitle ?? "").includes(tag));
          if (!r) return null;
          return remember(
            toRun({
              id: r.databaseId, workflow, url: r.url,
              status: r.status, conclusion: r.conclusion, name: r.displayTitle,
            }),
          );
        },
        async (o, { owner, repo }) => {
          const { data } = await o.actions.listWorkflowRuns({
            owner, repo, workflow_id: workflow, event: "workflow_dispatch", per_page: 20,
          });
          const r = data.workflow_runs.find((x) => (x.display_title ?? x.name ?? "").includes(tag));
          if (!r) return null;
          return remember(
            toRun({
              id: r.id, workflow, url: r.html_url,
              status: r.status, conclusion: r.conclusion, name: r.display_title ?? r.name,
            }),
          );
        },
      );
    },

    getRun: (runId) =>
      via(
        "run view",
        async () => {
          const out = await gh([
            "run", "view", String(runId),
            "--json", "databaseId,displayTitle,status,conclusion,url,workflowName",
          ]);
          const r = parseJson<{
            databaseId: number; displayTitle: string; status: string;
            conclusion: string; url: string; workflowName: string;
          }>(out, "run view");
          return toRun({
            id: r.databaseId ?? runId,
            workflow: runWorkflows.get(runId) ?? r.workflowName ?? "",
            url: r.url, status: r.status, conclusion: r.conclusion, name: r.displayTitle,
          });
        },
        async (o, { owner, repo }) => {
          const { data: r } = await o.actions.getWorkflowRun({ owner, repo, run_id: runId });
          return toRun({
            id: r.id,
            workflow:
              runWorkflows.get(runId) ?? (r.path ? path.posix.basename(r.path) : (r.name ?? "")),
            url: r.html_url, status: r.status, conclusion: r.conclusion,
            name: r.display_title ?? r.name,
          });
        },
      ),

    getRunResult: (runId) =>
      via<unknown | null>(
        "run download",
        async () => {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-forge-"));
          try {
            try {
              await gh(["run", "download", String(runId), "-n", "result", "-D", dir]);
            } catch (e) {
              if (MISSING_ARTIFACT.test(errText(e))) return null;
              throw e;
            }
            const file = path.join(dir, "result.json");
            if (!fs.existsSync(file)) return null;
            return parseJson<unknown>(fs.readFileSync(file, "utf8"), "run download (result.json)");
          } finally {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        },
        async (o, { owner, repo }) => {
          const { data } = await o.actions.listWorkflowRunArtifacts({
            owner, repo, run_id: runId, per_page: 100,
          });
          const art = data.artifacts.find((a) => a.name === "result");
          if (!art) return null;
          const dl = await o.actions.downloadArtifact({
            owner, repo, artifact_id: art.id, archive_format: "zip",
          });
          const bytes =
            dl.data instanceof Uint8Array ? dl.data : new Uint8Array(dl.data as ArrayBuffer);
          const entry = unzipSync(bytes)["result.json"];
          if (!entry) return null;
          return JSON.parse(new TextDecoder().decode(entry)) as unknown;
        },
      ),
  };
}
