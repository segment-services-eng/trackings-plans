import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { ForgeError } from "../../lib/forge.js";
import {
  createGitHubForge,
  mapStatus,
  parseRemoteUrl,
  type CommandRunner,
  type OctokitLike,
} from "../../lib/forge-github.js";

const ORIGIN = "git@github.com:acme/tp.git";

type Call = { cmd: string; args: string[]; cwd: string };

/** Fake runner: `git config` returns ORIGIN; `gh` delegates to handler. */
function fakeRun(gh: (args: string[]) => string, origin = ORIGIN) {
  const calls: Call[] = [];
  const run: CommandRunner = (cmd, args, { cwd }) => {
    calls.push({ cmd, args, cwd });
    if (cmd === "git") return `${origin}\n`;
    return gh(args);
  };
  return { run, calls, ghCalls: () => calls.filter((c) => c.cmd === "gh").map((c) => c.args) };
}

function ghFails(stderr = "gh: command not found"): never {
  const e = new Error("Command failed: gh") as Error & { stderr: string };
  e.stderr = stderr;
  throw e;
}

function fakeOctokit(overrides: {
  pulls?: Partial<OctokitLike["pulls"]>;
  actions?: Partial<OctokitLike["actions"]>;
} = {}) {
  const unexpected = () => vi.fn(async () => { throw new Error("unexpected call"); });
  const o = {
    pulls: { list: unexpected(), create: unexpected(), ...overrides.pulls },
    actions: {
      createWorkflowDispatch: unexpected(),
      listWorkflowRuns: unexpected(),
      getWorkflowRun: unexpected(),
      listWorkflowRunArtifacts: unexpected(),
      downloadArtifact: unexpected(),
      ...overrides.actions,
    },
  } as unknown as OctokitLike;
  const factory = vi.fn((_token: string) => o);
  return { o, factory };
}

describe("parseRemoteUrl", () => {
  it.each([
    ["https://github.com/acme/tp.git", "acme", "tp"],
    ["https://github.com/acme/tp", "acme", "tp"],
    ["https://x-access-token:abc@github.com/acme/tp.git", "acme", "tp"],
    ["git@github.com:acme/tp.git", "acme", "tp"],
    ["git@github.com:acme/tp", "acme", "tp"],
    ["ssh://git@github.com/acme/tp.git", "acme", "tp"],
    ["ssh://git@github.com:22/acme/tp.git", "acme", "tp"],
  ])("%s", (url, owner, repo) => {
    expect(parseRemoteUrl(url)).toEqual({ owner, repo });
  });

  it("returns null for garbage", () => {
    expect(parseRemoteUrl("not a url")).toBeNull();
  });
});

describe("mapStatus", () => {
  it.each([
    ["queued", "queued"],
    ["waiting", "queued"],
    ["pending", "queued"],
    ["requested", "queued"],
    ["in_progress", "in_progress"],
    ["completed", "completed"],
    ["COMPLETED", "completed"],
  ])("%s -> %s", (s, want) => expect(mapStatus(s)).toBe(want));
});

describe("createGitHubForge — gh path", () => {
  it("findOpenPullRequest: exact args + parse", async () => {
    const f = fakeRun(() =>
      JSON.stringify([
        { number: 7, url: "https://github.com/acme/tp/pull/7", headRefName: "tp/x", baseRefName: "main" },
      ]),
    );
    const forge = createGitHubForge({ repoPath: "/repo", run: f.run });
    expect(await forge.findOpenPullRequest("tp/x")).toEqual({
      number: 7, url: "https://github.com/acme/tp/pull/7", branch: "tp/x", base: "main",
    });
    expect(f.ghCalls()).toEqual([[
      "pr", "list", "--head", "tp/x", "--state", "open",
      "--json", "number,url,headRefName,baseRefName", "--limit", "1",
    ]]);
    expect(f.calls[0].cwd).toBe("/repo");
  });

  it("findOpenPullRequest: empty array -> null", async () => {
    const f = fakeRun(() => "[]");
    expect(await createGitHubForge({ repoPath: "/r", run: f.run }).findOpenPullRequest("b")).toBeNull();
  });

  it("openPullRequest: exact args, number parsed from URL", async () => {
    const f = fakeRun(() => "Creating pull request...\nhttps://github.com/acme/tp/pull/42\n");
    const pr = await createGitHubForge({ repoPath: "/r", run: f.run }).openPullRequest({
      branch: "tp/x", base: "main", title: "T", body: "B",
    });
    expect(pr).toEqual({ number: 42, url: "https://github.com/acme/tp/pull/42", branch: "tp/x", base: "main" });
    expect(f.ghCalls()).toEqual([[
      "pr", "create", "--head", "tp/x", "--base", "main", "--title", "T", "--body", "B",
    ]]);
  });

  it("dispatchWorkflow: exact args with -f inputs", async () => {
    const f = fakeRun(() => "");
    await createGitHubForge({ repoPath: "/r", run: f.run }).dispatchWorkflow({
      workflow: "deploy-dev.yml", ref: "main", inputs: { request_id: "abc", plan: "all" },
    });
    expect(f.ghCalls()).toEqual([[
      "workflow", "run", "deploy-dev.yml", "--ref", "main", "-f", "request_id=abc", "-f", "plan=all",
    ]]);
  });

  it("findRunByRequestId: exact args, matches [requestId], maps status", async () => {
    const f = fakeRun(() =>
      JSON.stringify([
        { databaseId: 1, displayTitle: "deploy-dev [other]", status: "completed", conclusion: "success", url: "u1" },
        { databaseId: 2, displayTitle: "deploy-dev [abc]", status: "completed", conclusion: "FAILURE", url: "u2" },
      ]),
    );
    const run = await createGitHubForge({ repoPath: "/r", run: f.run }).findRunByRequestId("deploy-dev.yml", "abc");
    expect(run).toEqual({
      id: 2, workflow: "deploy-dev.yml", url: "u2", status: "completed", conclusion: "failure", name: "deploy-dev [abc]",
    });
    expect(f.ghCalls()).toEqual([[
      "run", "list", "--workflow", "deploy-dev.yml", "--event", "workflow_dispatch", "--limit", "20",
      "--json", "databaseId,displayTitle,status,conclusion,url",
    ]]);
  });

  it("findRunByRequestId: no match -> null; request id must be bracketed", async () => {
    const f = fakeRun(() =>
      JSON.stringify([{ databaseId: 1, displayTitle: "deploy-dev abc", status: "queued", conclusion: "", url: "u" }]),
    );
    expect(await createGitHubForge({ repoPath: "/r", run: f.run }).findRunByRequestId("w.yml", "abc")).toBeNull();
  });

  it("getRun: exact args; conclusion omitted unless completed; workflow from earlier lookup", async () => {
    const f = fakeRun((args) => {
      if (args[1] === "list") {
        return JSON.stringify([{ databaseId: 9, displayTitle: "x [r1]", status: "queued", conclusion: "", url: "u" }]);
      }
      return JSON.stringify({
        databaseId: 9, displayTitle: "x [r1]", status: "in_progress", conclusion: "", url: "u", workflowName: "Deploy dev",
      });
    });
    const forge = createGitHubForge({ repoPath: "/r", run: f.run });
    expect((await forge.getRun(9)).workflow).toBe("Deploy dev");
    await forge.findRunByRequestId("deploy-dev.yml", "r1");
    const run = await forge.getRun(9);
    expect(run).toEqual({ id: 9, workflow: "deploy-dev.yml", url: "u", status: "in_progress", name: "x [r1]" });
    expect(run).not.toHaveProperty("conclusion");
    expect(f.ghCalls()[0]).toEqual([
      "run", "view", "9", "--json", "databaseId,displayTitle,status,conclusion,url,workflowName",
    ]);
  });

  it("getRun: waiting maps to queued", async () => {
    const f = fakeRun(() =>
      JSON.stringify({ databaseId: 3, displayTitle: "n", status: "waiting", conclusion: "", url: "u", workflowName: "w" }),
    );
    expect((await createGitHubForge({ repoPath: "/r", run: f.run }).getRun(3)).status).toBe("queued");
  });

  it("getRunResult: downloads into -D dir, parses result.json, cleans up", async () => {
    let dir = "";
    const f = fakeRun((args) => {
      dir = args[args.indexOf("-D") + 1];
      fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ ok: true, workflow: "reset-dev" }));
      return "";
    });
    const result = await createGitHubForge({ repoPath: "/r", run: f.run }).getRunResult(55);
    expect(result).toEqual({ ok: true, workflow: "reset-dev" });
    expect(f.ghCalls()).toEqual([["run", "download", "55", "-n", "result", "-D", dir]]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("getRunResult: missing artifact -> null", async () => {
    const f = fakeRun(() => ghFails("no valid artifacts found to download"));
    expect(await createGitHubForge({ repoPath: "/r", run: f.run }).getRunResult(1)).toBeNull();
  });

  it("invalid JSON from gh -> GH_CLI", async () => {
    const f = fakeRun(() => "not json");
    await expect(
      createGitHubForge({ repoPath: "/r", run: f.run }).findOpenPullRequest("b"),
    ).rejects.toMatchObject({ code: "GH_CLI" });
  });
});

describe("createGitHubForge — errors and fallback", () => {
  it("gh fails with no token -> GH_CLI with stderr, Octokit never built", async () => {
    const f = fakeRun(() => ghFails("HTTP 401: Bad credentials"));
    const { factory } = fakeOctokit();
    const forge = createGitHubForge({ repoPath: "/r", run: f.run, octokitFactory: factory });
    const err = await forge.dispatchWorkflow({ workflow: "w.yml", ref: "main", inputs: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect(err.code).toBe("GH_CLI");
    expect(err.message).toContain("HTTP 401: Bad credentials");
    expect(factory).not.toHaveBeenCalled();
  });

  it("falls back to Octokit when gh throws and a token exists; token not in errors", async () => {
    const f = fakeRun(() => ghFails());
    const list = vi.fn(async () => ({
      data: [{ number: 3, html_url: "https://github.com/acme/tp/pull/3", head: { ref: "b" }, base: { ref: "main" } }],
    }));
    const { factory } = fakeOctokit({ pulls: { list } });
    const forge = createGitHubForge({ repoPath: "/r", token: "sekret", run: f.run, octokitFactory: factory });
    expect(await forge.findOpenPullRequest("b")).toEqual({
      number: 3, url: "https://github.com/acme/tp/pull/3", branch: "b", base: "main",
    });
    expect(factory).toHaveBeenCalledWith("sekret");
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "tp", state: "open", head: "acme:b" }),
    );
  });

  it("Octokit failure -> GITHUB_API without leaking the token", async () => {
    const f = fakeRun(() => ghFails());
    const create = vi.fn(async () => {
      throw Object.assign(new Error("Validation Failed"), { status: 422 });
    });
    const { factory } = fakeOctokit({ pulls: { create } });
    const forge = createGitHubForge({ repoPath: "/r", token: "sekret", run: f.run, octokitFactory: factory });
    const err = await forge
      .openPullRequest({ branch: "b", base: "main", title: "t", body: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect(err.code).toBe("GITHUB_API");
    expect(err.message).toContain("Validation Failed");
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain("sekret");
  });

  it("resolves owner/repo lazily and caches it (https origin)", async () => {
    const f = fakeRun(() => ghFails(), "https://github.com/octo/repo.git");
    const createWorkflowDispatch = vi.fn(async () => ({}));
    const { factory } = fakeOctokit({ actions: { createWorkflowDispatch } });
    const forge = createGitHubForge({ repoPath: "/r", token: "t", run: f.run, octokitFactory: factory });
    expect(f.calls.length).toBe(0);
    await forge.dispatchWorkflow({ workflow: "w.yml", ref: "main", inputs: { request_id: "q" } });
    await forge.dispatchWorkflow({ workflow: "w.yml", ref: "main", inputs: { request_id: "q" } });
    expect(f.calls.filter((c) => c.cmd === "git").map((c) => c.args)).toEqual([
      ["config", "--get", "remote.origin.url"],
    ]);
    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "octo", repo: "repo", workflow_id: "w.yml", ref: "main", inputs: { request_id: "q" },
    });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("Octokit openPullRequest", async () => {
    const f = fakeRun(() => ghFails());
    const create = vi.fn(async () => ({
      data: { number: 11, html_url: "https://github.com/acme/tp/pull/11", head: { ref: "b" }, base: { ref: "main" } },
    }));
    const { factory } = fakeOctokit({ pulls: { create } });
    const forge = createGitHubForge({ repoPath: "/r", token: "t", run: f.run, octokitFactory: factory });
    expect(await forge.openPullRequest({ branch: "b", base: "main", title: "T", body: "B" })).toEqual({
      number: 11, url: "https://github.com/acme/tp/pull/11", branch: "b", base: "main",
    });
    expect(create).toHaveBeenCalledWith({ owner: "acme", repo: "tp", head: "b", base: "main", title: "T", body: "B" });
  });

  it("Octokit findRunByRequestId + getRun", async () => {
    const f = fakeRun(() => ghFails());
    const listWorkflowRuns = vi.fn(async () => ({
      data: {
        workflow_runs: [
          { id: 1, display_title: "reset-dev [zzz]", status: "queued", conclusion: null, html_url: "u1" },
          { id: 2, display_title: "reset-dev [req-1]", status: "pending", conclusion: null, html_url: "u2" },
        ],
      },
    }));
    const getWorkflowRun = vi.fn(async () => ({
      data: {
        id: 5, name: "Reset dev", display_title: "reset-dev [req-2]", status: "completed",
        conclusion: "Success", html_url: "u5", path: ".github/workflows/reset-dev.yml",
      },
    }));
    const { factory } = fakeOctokit({ actions: { listWorkflowRuns, getWorkflowRun } });
    const forge = createGitHubForge({ repoPath: "/r", token: "t", run: f.run, octokitFactory: factory });
    expect(await forge.findRunByRequestId("reset-dev.yml", "req-1")).toEqual({
      id: 2, workflow: "reset-dev.yml", url: "u2", status: "queued", name: "reset-dev [req-1]",
    });
    expect(listWorkflowRuns).toHaveBeenCalledWith({
      owner: "acme", repo: "tp", workflow_id: "reset-dev.yml", event: "workflow_dispatch", per_page: 20,
    });
    expect(await forge.findRunByRequestId("reset-dev.yml", "nope")).toBeNull();
    expect(await forge.getRun(5)).toEqual({
      id: 5, workflow: "reset-dev.yml", url: "u5", status: "completed", conclusion: "success", name: "reset-dev [req-2]",
    });
  });

  it("Octokit getRunResult unzips result.json", async () => {
    const f = fakeRun(() => ghFails());
    const zip = zipSync({ "result.json": strToU8(JSON.stringify({ ok: false, errors: ["boom"] })) });
    const ab = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
    const listWorkflowRunArtifacts = vi.fn(async () => ({
      data: { artifacts: [{ id: 1, name: "logs" }, { id: 77, name: "result" }] },
    }));
    const downloadArtifact = vi.fn(async () => ({ data: ab }));
    const { factory } = fakeOctokit({ actions: { listWorkflowRunArtifacts, downloadArtifact } });
    const forge = createGitHubForge({ repoPath: "/r", token: "t", run: f.run, octokitFactory: factory });
    expect(await forge.getRunResult(9)).toEqual({ ok: false, errors: ["boom"] });
    expect(downloadArtifact).toHaveBeenCalledWith({
      owner: "acme", repo: "tp", artifact_id: 77, archive_format: "zip",
    });
  });

  it("Octokit getRunResult: no result artifact -> null", async () => {
    const f = fakeRun(() => ghFails());
    const listWorkflowRunArtifacts = vi.fn(async () => ({ data: { artifacts: [{ id: 1, name: "logs" }] } }));
    const { factory } = fakeOctokit({ actions: { listWorkflowRunArtifacts } });
    const forge = createGitHubForge({ repoPath: "/r", token: "t", run: f.run, octokitFactory: factory });
    expect(await forge.getRunResult(9)).toBeNull();
  });
});
