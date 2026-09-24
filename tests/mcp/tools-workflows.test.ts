import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContext } from "../../mcp/context.js";
import {
  __setWorkflowTiming,
  checkProdDrift,
  deployDev,
  getWorkflowRun,
  resetDev,
  WORKFLOW_FILES,
} from "../../mcp/tools/workflows.js";
import { ForgeError } from "../../lib/forge.js";
import { FakeForge } from "../helpers/fake-forge.js";

const sh = (cwd: string, cmd: string) =>
  execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

interface Fixture {
  repo: string;
  root: string;
  origin: string;
  forge: FakeForge;
  ctx: ReturnType<typeof resolveContext>;
  git: (cmd: string) => string;
}

/** Temp repo with a bare origin, one plan, default branch pushed. */
function makeFixture(opts: { defaultBranch?: string } = {}): Fixture {
  const defaultBranch = opts.defaultBranch ?? "main";
  const root = mkdtempSync(join(tmpdir(), "tp-wf-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "work");
  sh(root, `git init -q --bare -b ${defaultBranch} origin.git`);
  sh(root, `git init -q -b ${defaultBranch} work`);
  sh(repo, "git config user.email t@t.t && git config user.name t");
  sh(repo, `git remote add origin ${origin}`);
  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(
    join(repo, "config", "tracking-plans-config.json"),
    JSON.stringify({
      plans: [{ name: "JavaScript", path: "javascript", dev_secret: "DEV_JS", prod_secret: "PROD_JS" }],
    }),
  );
  if (opts.defaultBranch) {
    writeFileSync(
      join(repo, ".tracking-plans-mcp.json"),
      JSON.stringify({ default_branch: opts.defaultBranch }),
    );
  }
  sh(repo, "git add . && git commit -qm init");
  sh(repo, `git push -q -u origin ${defaultBranch}`);
  const forge = new FakeForge();
  const ctx = resolveContext({ REPO_PATH: repo }, { forge });
  return { repo, root, origin, forge, ctx, git: (cmd) => sh(repo, `git ${cmd}`) };
}

/** Commit a file on a new local branch `name`, then return to the original branch. */
function makeBranch(f: Fixture, name: string, file = "a.txt"): void {
  const orig = f.git("rev-parse --abbrev-ref HEAD");
  f.git(`checkout -q -b ${name}`);
  writeFileSync(join(f.repo, file), `${name} ${file}\n`);
  f.git(`add . && git commit -qm "${name} ${file}"`);
  f.git(`checkout -q ${orig}`);
}

// Fake clock: sleep advances `now` instantly; `onSleep` lets a test act mid-wait.
let clock = 0;
let onSleep: (() => void) | undefined;
let restore: () => void;
beforeEach(() => {
  clock = 1_000_000;
  onSleep = undefined;
  restore = __setWorkflowTiming({
    now: () => clock,
    sleep: async (ms) => {
      clock += Math.max(ms, 1);
      onSleep?.();
    },
    lookupMs: 5000,
    pollMs: 1000,
  });
});
afterEach(() => restore());

describe("dispatch contract", () => {
  it("dispatches on the default branch with request_id and tool inputs", async () => {
    const f = makeFixture();
    const res = await resetDev(f.ctx, { plan: "JavaScript", confirm: true });
    expect(res.ok).toBe(true);
    expect(f.forge.dispatches).toHaveLength(1);
    const d = f.forge.dispatches[0];
    expect(d.workflow).toBe("reset-dev.yml");
    expect(d.ref).toBe("main");
    expect(d.inputs.request_id).toMatch(/^mcp-\d+-[0-9a-z]{6}$/);
    expect(d.inputs).toEqual({ request_id: d.inputs.request_id, plan: "javascript" });
    if (res.ok) expect(res.data.request_id).toBe(d.inputs.request_id);
  });

  it("uses default_branch from config as the dispatch ref", async () => {
    const f = makeFixture({ defaultBranch: "develop" });
    expect(f.ctx.defaultBranch).toBe("develop");
    await checkProdDrift(f.ctx, {});
    const d = f.forge.dispatches[0];
    expect(d.workflow).toBe(WORKFLOW_FILES.prod_drift);
    expect(d.ref).toBe("develop");
    expect(Object.keys(d.inputs)).toEqual(["request_id"]);
  });

  it("returns run_id and run_url once the run is listed", async () => {
    const f = makeFixture();
    const res = await checkProdDrift(f.ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const run = f.forge.runs[0];
    expect(res.data).toEqual({
      request_id: f.forge.dispatches[0].inputs.request_id,
      workflow: "prod-drift.yml",
      run_id: run.id,
      run_url: run.url,
      status: "queued",
    });
  });

  it("polls for a run that is listed late", async () => {
    const f = makeFixture();
    f.forge.autoCreateRuns = false;
    let polls = 0;
    onSleep = () => {
      if (++polls === 2) {
        const d = f.forge.dispatches[0];
        f.forge.runs.push({
          id: 7,
          workflow: d.workflow,
          url: "https://github.com/acme/tp/actions/runs/7",
          status: "in_progress",
          name: `x [${d.inputs.request_id}]`,
        });
      }
    };
    const res = await checkProdDrift(f.ctx, {});
    expect(res.ok && res.data.run_id).toBe(7);
  });

  it("returns queued without run_id when the run never appears within the lookup window", async () => {
    const f = makeFixture();
    f.forge.autoCreateRuns = false;
    const res = await checkProdDrift(f.ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("queued");
    expect(res.data.run_id).toBeUndefined();
    expect(res.warnings?.[0]).toContain("get_workflow_run");
  });

  it("wait_seconds timeout is not an error: returns in_progress", async () => {
    const f = makeFixture();
    onSleep = () => {
      for (const r of f.forge.runs) r.status = "in_progress";
    };
    const start = clock;
    const res = await checkProdDrift(f.ctx, { wait_seconds: 10 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.status).toBe("in_progress");
    expect(clock - start).toBeGreaterThanOrEqual(10_000);
    expect(clock - start).toBeLessThan(12_000);
  });

  it("wait_seconds returns the result of a successful run", async () => {
    const f = makeFixture();
    const result = { ok: true, workflow: "reset-dev", plans: [{ plan: "javascript", env: "dev", rules_patched: 3 }] };
    onSleep = () => {
      const r = f.forge.runs[0];
      if (r && r.status !== "completed") f.forge.complete(r.id, "success", result);
    };
    const res = await resetDev(f.ctx, { confirm: true, wait_seconds: 30 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("completed");
    expect(res.data.conclusion).toBe("success");
    expect(res.data.result).toEqual(result);
    expect(f.forge.dispatches[0].inputs.plan).toBe("all");
  });

  it("a failed run is a WORKFLOW error with run_url and result", async () => {
    const f = makeFixture();
    const result = { ok: false, workflow: "prod-drift", plans: [], errors: ["boom"] };
    onSleep = () => {
      const r = f.forge.runs[0];
      if (r && r.status !== "completed") f.forge.complete(r.id, "failure", result);
    };
    const res = await checkProdDrift(f.ctx, { wait_seconds: 5 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const run = f.forge.runs[0];
    expect(res.error.code).toBe("WORKFLOW");
    expect(res.error.details).toEqual({
      run_id: run.id,
      run_url: run.url,
      conclusion: "failure",
      result,
    });
  });

  it("a dispatch that throws is a WORKFLOW error carrying the forge code", async () => {
    const f = makeFixture();
    f.forge.dispatchWorkflow = async () => {
      throw new ForgeError("GITHUB_API", "HTTP 404: workflow not found");
    };
    const res = await checkProdDrift(f.ctx, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("WORKFLOW");
    expect(res.error.message).toContain("HTTP 404: workflow not found");
    expect((res.error.details as any).forge_code).toBe("GITHUB_API");
  });
});

describe("reset_dev", () => {
  it("requires confirm: true", async () => {
    const f = makeFixture();
    for (const args of [{}, { confirm: false }]) {
      const res = await resetDev(f.ctx, args);
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.error.code).toBe("VALIDATION");
      expect(res.error.remediation).toBe(
        "re-run with confirm: true; this overwrites the shared Dev tracking plan with prod",
      );
    }
    expect(f.forge.dispatches).toHaveLength(0);
  });

  it("unknown plan is NOT_FOUND", async () => {
    const f = makeFixture();
    const res = await resetDev(f.ctx, { plan: "nope", confirm: true });
    expect(!res.ok && res.error.code).toBe("NOT_FOUND");
    expect(f.forge.dispatches).toHaveLength(0);
  });
});

describe("deploy_dev", () => {
  it("refuses the default branch", async () => {
    const f = makeFixture({ defaultBranch: "develop" });
    const res = await deployDev(f.ctx, { branch: "develop" });
    expect(!res.ok && res.error.code).toBe("VALIDATION");
    expect(f.forge.dispatches).toHaveLength(0);
  });

  it("unknown branch is NOT_FOUND", async () => {
    const f = makeFixture();
    const res = await deployDev(f.ctx, { branch: "tp/nope" });
    expect(!res.ok && res.error.code).toBe("NOT_FOUND");
    expect(f.forge.dispatches).toHaveLength(0);
  });

  it("unknown plan is NOT_FOUND", async () => {
    const f = makeFixture();
    makeBranch(f, "tp/s1");
    const res = await deployDev(f.ctx, { branch: "tp/s1", plan: "nope" });
    expect(!res.ok && res.error.code).toBe("NOT_FOUND");
    expect(f.forge.dispatches).toHaveLength(0);
  });

  it("pushes a local-only branch, then dispatches with plan + ref", async () => {
    const f = makeFixture();
    makeBranch(f, "tp/s1");
    const res = await deployDev(f.ctx, { branch: "tp/s1", plan: "javascript" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.pushed).toBe(true);
    expect(sh(f.origin, "git rev-parse tp/s1")).toBe(f.git("rev-parse tp/s1"));
    const d = f.forge.dispatches[0];
    expect(d.workflow).toBe("deploy-dev.yml");
    expect(d.ref).toBe("main");
    expect(d.inputs).toEqual({ request_id: d.inputs.request_id, plan: "javascript", ref: "tp/s1" });
    expect(f.git("rev-parse --abbrev-ref HEAD")).toBe("main");
  });

  it("pushes when ahead of origin, and skips the push when up to date", async () => {
    const f = makeFixture();
    makeBranch(f, "tp/s1");
    f.git("push -q -u origin tp/s1");
    let res = await deployDev(f.ctx, { branch: "tp/s1" });
    expect(res.ok && res.data.pushed).toBe(false);
    expect(f.forge.dispatches[0].inputs.plan).toBe("all");

    f.git("checkout -q tp/s1");
    writeFileSync(join(f.repo, "b.txt"), "b\n");
    f.git("add . && git commit -qm b && git checkout -q main");
    res = await deployDev(f.ctx, { branch: "tp/s1" });
    expect(res.ok && res.data.pushed).toBe(true);
    expect(sh(f.origin, "git rev-parse tp/s1")).toBe(f.git("rev-parse tp/s1"));
  });

  it("deploys a remote-only branch without pushing", async () => {
    const f = makeFixture();
    makeBranch(f, "tp/remote");
    f.git("push -q origin tp/remote && git branch -qD tp/remote");
    const res = await deployDev(f.ctx, { branch: "tp/remote" });
    expect(res.ok && res.data.pushed).toBe(false);
    expect(f.forge.dispatches[0].inputs.ref).toBe("tp/remote");
  });

  it("non-fast-forward push is a GIT error with the pull remediation", async () => {
    const f = makeFixture();
    makeBranch(f, "tp/s1");
    f.git("push -q -u origin tp/s1");
    // Someone else pushes to origin/tp/s1 from another clone.
    const other = join(f.root, "other");
    sh(f.root, `git clone -q ${f.origin} other`);
    sh(other, "git config user.email o@o.o && git config user.name o");
    sh(other, "git checkout -q tp/s1");
    writeFileSync(join(other, "theirs.txt"), "theirs\n");
    sh(other, "git add . && git commit -qm theirs && git push -q origin tp/s1");
    // Local diverges.
    f.git("checkout -q tp/s1");
    writeFileSync(join(f.repo, "mine.txt"), "mine\n");
    f.git("add . && git commit -qm mine && git checkout -q main");

    const res = await deployDev(f.ctx, { branch: "tp/s1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("GIT");
    expect(res.error.remediation).toContain("git pull --rebase origin tp/s1");
    expect((res.error.details as any).reason).toBe("non_fast_forward");
    expect(f.forge.dispatches).toHaveLength(0);
  });
});

describe("get_workflow_run", () => {
  it("finds a run by request_id + workflow key", async () => {
    const f = makeFixture();
    const trig = await checkProdDrift(f.ctx, {});
    if (!trig.ok) throw new Error("dispatch failed");
    f.forge.complete(trig.data.run_id!, "success", { ok: true, workflow: "prod-drift", plans: [] });
    const res = await getWorkflowRun(f.ctx, { request_id: trig.data.request_id, workflow: "prod_drift" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      request_id: trig.data.request_id,
      workflow: "prod-drift.yml",
      run_id: trig.data.run_id,
      status: "completed",
      conclusion: "success",
      result: { ok: true },
    });
  });

  it("finds a run by run_id and reports a failure as WORKFLOW", async () => {
    const f = makeFixture();
    const trig = await resetDev(f.ctx, { confirm: true });
    if (!trig.ok) throw new Error("dispatch failed");
    f.forge.complete(trig.data.run_id!, "cancelled");
    const res = await getWorkflowRun(f.ctx, { run_id: trig.data.run_id });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("WORKFLOW");
    expect((res.error.details as any).run_url).toBe(f.forge.runs[0].url);
    expect((res.error.details as any).conclusion).toBe("cancelled");
  });

  it("requires run_id or request_id + workflow", async () => {
    const f = makeFixture();
    const res = await getWorkflowRun(f.ctx, { request_id: "mcp-1-abcdef" });
    expect(!res.ok && res.error.code).toBe("VALIDATION");
  });

  it("unknown request_id is NOT_FOUND", async () => {
    const f = makeFixture();
    const res = await getWorkflowRun(f.ctx, { request_id: "mcp-1-abcdef", workflow: "deploy-dev.yml" });
    expect(!res.ok && res.error.code).toBe("NOT_FOUND");
  });
});
