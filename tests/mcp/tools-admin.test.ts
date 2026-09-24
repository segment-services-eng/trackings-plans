import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContext } from "../../mcp/context.js";
import { createServer } from "../../mcp/server.js";
import {
  resetDevFromProd,
  resetDevFromProdInput,
  pullFromSegment,
  pullFromSegmentInput,
} from "../../mcp/tools/admin.js";
import type { Rule } from "../../lib/segment-api.js";

const BASE = "https://api.segmentapis.com";
const DEV_ID = "rs_dev_123";
const PROD_ID = "rs_prod_999";

const rule = (key: string, version = 1): Rule => ({
  key,
  type: "TRACK",
  version,
  jsonSchema: { description: `${key} desc` },
});

// ---- stateful fake Segment ----------------------------------------------
const server = setupServer();
let store: Record<string, Rule[]>;
let requests: { method: string; url: string; body?: any }[];

function installSegment(opts: { failOn?: string; status?: number } = {}) {
  const fail = (method: string) =>
    opts.failOn === method
      ? HttpResponse.json({ errors: [{ message: "nope" }] }, { status: opts.status ?? 500 })
      : undefined;
  server.use(
    http.get(`${BASE}/tracking-plans/:id/rules`, ({ params, request }) => {
      requests.push({ method: "GET", url: request.url });
      const f = fail("GET");
      if (f) return f;
      const rules = store[params.id as string] ?? [];
      return HttpResponse.json({ data: { rules, pagination: {} } });
    }),
    http.patch(`${BASE}/tracking-plans/:id/rules`, async ({ params, request }) => {
      const body = (await request.json()) as { rules: Rule[] };
      requests.push({ method: "PATCH", url: request.url, body });
      const f = fail("PATCH");
      if (f) return f;
      const id = params.id as string;
      const existing = store[id] ?? [];
      store[id] = [
        ...existing.filter((r) => !body.rules.some((n) => n.key === r.key)),
        ...body.rules,
      ];
      return HttpResponse.json({ data: {} });
    }),
    http.delete(`${BASE}/tracking-plans/:id/rules`, async ({ params, request }) => {
      const body = (await request.json()) as { rules: { key: string }[] };
      requests.push({ method: "DELETE", url: request.url, body });
      const f = fail("DELETE");
      if (f) return f;
      const id = params.id as string;
      store[id] = (store[id] ?? []).filter((r) => !body.rules.some((d) => d.key === r.key));
      return HttpResponse.json({ data: {} });
    }),
  );
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---- temp repo -----------------------------------------------------------
function snapshot(rules: Rule[]): string {
  return JSON.stringify({ rules }, null, 2);
}

type PlanEntry = { name: string; path: string; dev_secret: string; prod_secret: string };
const JS_PLAN: PlanEntry = { name: "JavaScript", path: "javascript", dev_secret: "DEV_JS", prod_secret: "PROD_JS" };

function makeRepo(
  opts: { prod?: Rule[]; dev?: Rule[] } = {},
  plans: PlanEntry[] = [JS_PLAN],
): string {
  store = {};
  requests = [];
  const dir = mkdtempSync(join(tmpdir(), "tp-admin-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: dir });
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    join(dir, "config", "tracking-plans-config.json"),
    JSON.stringify({ plans }),
  );
  for (const [env, rules] of Object.entries(opts)) {
    if (!rules) continue;
    mkdirSync(join(dir, "plans", env, "javascript"), { recursive: true });
    writeFileSync(join(dir, "plans", env, "javascript", "current-rules.json"), snapshot(rules));
  }
  execSync("git add . && git commit -qm init", { cwd: dir });
  return dir;
}

const fullEnv = (repo: string) => ({
  REPO_PATH: repo,
  SEGMENT_PUBLIC_API_TOKEN: "tok",
  DEV_JS: DEV_ID,
  PROD_JS: PROD_ID,
});

const git = (repo: string, cmd: string) =>
  execSync(`git ${cmd}`, { cwd: repo, encoding: "utf8" }).trim();

function installFailingPreCommitHook(repo: string): void {
  writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n", {
    mode: 0o755,
  });
}

// ---- reset_dev_from_prod -------------------------------------------------
describe("reset_dev_from_prod", () => {
  it("refuses without confirm: true (VALIDATION + remediation), no Segment calls", async () => {
    const repo = makeRepo({ prod: [rule("A")] });
    installSegment();
    const ctx = resolveContext(fullEnv(repo));
    for (const confirm of [undefined, false]) {
      const res = await resetDevFromProd(ctx, { plan: "javascript", confirm, mode: "files" });
      if (res.ok) throw new Error("expected failure");
      expect(res.error.code).toBe("VALIDATION");
      expect(res.error.remediation).toMatch(/confirm: true/);
    }
    expect(requests).toEqual([]);
  });

  it("CONFIG error when the Segment token is missing", async () => {
    const repo = makeRepo({ prod: [rule("A")] });
    installSegment();
    const ctx = resolveContext({ REPO_PATH: repo, DEV_JS: DEV_ID, PROD_JS: PROD_ID });
    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "files" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("CONFIG");
    expect(requests).toEqual([]);
  });

  it("CONFIG error when only the PROD plan id is set — never falls back to prod", async () => {
    const repo = makeRepo({ prod: [rule("A")] });
    installSegment();
    const ctx = resolveContext({
      REPO_PATH: repo,
      SEGMENT_PUBLIC_API_TOKEN: "tok",
      PROD_JS: PROD_ID,
    });
    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "files" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("CONFIG");
    expect(res.error.message).toContain("DEV_JS");
    expect(requests).toEqual([]);
  });

  it("schema rejects any attempt to pass a target env or plan id", () => {
    expect(() =>
      resetDevFromProdInput.parse({ plan: "javascript", confirm: true, env: "prod" }),
    ).toThrow();
    expect(() =>
      resetDevFromProdInput.parse({ plan: "javascript", confirm: true, tracking_plan_id: PROD_ID }),
    ).toThrow();
  });

  it("NOT_FOUND when the prod snapshot is missing", async () => {
    const repo = makeRepo();
    installSegment();
    const ctx = resolveContext(fullEnv(repo));
    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "files" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("NOT_FOUND");
    expect(requests).toEqual([]);
  });

  it("files mode: deletes dev rules, patches prod rules, refreshes dev snapshot; only ever targets DEV", async () => {
    const prodRules = [rule("A"), rule("B")];
    const repo = makeRepo({ prod: prodRules, dev: [rule("Old", 3)] });
    installSegment();
    store[DEV_ID] = [rule("Old", 3), rule("A")];
    store[PROD_ID] = [rule("ProdOnly")];
    const ctx = resolveContext(fullEnv(repo));

    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "files" });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.data.rules_deleted).toBe(2);
    expect(res.data.rules_patched).toBe(2);
    expect(res.data.mode).toBe("files");
    expect(res.data.files_changed).toEqual(["plans/dev/javascript/current-rules.json"]);

    // Segment dev now matches prod snapshot; prod untouched
    expect(store[DEV_ID].map((r) => r.key)).toEqual(["A", "B"]);
    expect(store[PROD_ID].map((r) => r.key)).toEqual(["ProdOnly"]);
    // No request of any kind ever hit the prod plan id
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.url.includes(`/tracking-plans/${DEV_ID}/`))).toBe(true);
    expect(requests.some((r) => r.url.includes(PROD_ID))).toBe(false);
    expect(requests.map((r) => r.method)).toEqual(["GET", "DELETE", "PATCH", "GET"]);

    const devFile = readFileSync(join(repo, "plans/dev/javascript/current-rules.json"), "utf8");
    expect(devFile).toBe(snapshot(prodRules));
  });

  it("branch mode: commits the dev snapshot with a structured message and restores main", async () => {
    const repo = makeRepo({ prod: [rule("A")], dev: [rule("Old")] });
    installSegment();
    store[DEV_ID] = [rule("Old")];
    const ctx = resolveContext(fullEnv(repo));

    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "branch" });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.data.branch).toMatch(/^tp\/javascript\/reset-dev-from-prod-\d+$/);
    expect(res.data.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo, "rev-parse --abbrev-ref HEAD")).toBe("main");
    expect(git(repo, `log -1 --format=%s ${res.data.branch}`)).toBe(
      "[tp:javascript] reset dev from prod",
    );
    expect(
      git(repo, `show ${res.data.branch}:plans/dev/javascript/current-rules.json`),
    ).toBe(snapshot([rule("A")]));
    expect(git(repo, "status --porcelain")).toBe("");
  });

  it("branch mode refuses on a dirty tree BEFORE touching Segment", async () => {
    const repo = makeRepo({ prod: [rule("A")] });
    installSegment();
    writeFileSync(join(repo, "dirty.txt"), "x");
    const ctx = resolveContext(fullEnv(repo));
    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "branch" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("DIRTY_TREE");
    expect(requests).toEqual([]);
  });

  it("SEGMENT_API error when Segment fails; no snapshot written", async () => {
    const repo = makeRepo({ prod: [rule("A")], dev: [rule("Old")] });
    installSegment({ failOn: "DELETE", status: 500 });
    store[DEV_ID] = [rule("Old")];
    const ctx = resolveContext(fullEnv(repo));
    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "files" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("SEGMENT_API");
    expect(res.error.remediation).toMatch(/SEGMENT_PUBLIC_API_TOKEN/);
    expect(readFileSync(join(repo, "plans/dev/javascript/current-rules.json"), "utf8")).toBe(
      snapshot([rule("Old")]),
    );
  });
});

describe("reset_dev_from_prod safety + source", () => {
  it("PROD_WRITE_BLOCKED when the DEV plan id equals a configured PROD plan id; no Segment calls", async () => {
    const other: PlanEntry = { name: "iOS", path: "ios", dev_secret: "DEV_IOS", prod_secret: "PROD_IOS" };
    const repo = makeRepo({ prod: [rule("A")] }, [JS_PLAN, other]);
    installSegment();
    const ctx = resolveContext({
      ...fullEnv(repo),
      DEV_JS: "rs_ios_prod",
      DEV_IOS: "rs_ios_dev",
      PROD_IOS: "rs_ios_prod",
    });
    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "files" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("PROD_WRITE_BLOCKED");
    expect(requests).toEqual([]);
  });

  it("PROD_WRITE_BLOCKED when the DEV plan id equals its own PROD plan id", async () => {
    const repo = makeRepo({ prod: [rule("A")] });
    installSegment();
    const ctx = resolveContext({ ...fullEnv(repo), DEV_JS: PROD_ID });
    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "files" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("PROD_WRITE_BLOCKED");
    expect(requests).toEqual([]);
  });

  it("PROD_WRITE_BLOCKED when the plan's dev_secret names a PROD env var; no Segment calls", async () => {
    const other: PlanEntry = { name: "iOS", path: "ios", dev_secret: "DEV_IOS", prod_secret: "PROD_IOS" };
    const bad: PlanEntry = { ...JS_PLAN, dev_secret: "PROD_IOS" };
    const repo = makeRepo({ prod: [rule("A")] }, [bad, other]);
    installSegment();
    // PROD_IOS deliberately unset so only the secret-name check can catch it.
    const ctx = resolveContext({ ...fullEnv(repo), PROD_IOS: undefined, DEV_IOS: "rs_ios_dev" });
    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "files" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("PROD_WRITE_BLOCKED");
    expect(requests).toEqual([]);
  });

  it("branch mode reads the prod snapshot from main, not the checked-out branch", async () => {
    const repo = makeRepo({ prod: [rule("A")] });
    mkdirSync(join(repo, "plans/prod/javascript"), { recursive: true });
    writeFileSync(join(repo, "plans/prod/javascript/current-rules.json"), snapshot([]));
    writeFileSync(join(repo, "plans/prod/javascript/current-rules-1.json"), snapshot([rule("M1")]));
    writeFileSync(join(repo, "plans/prod/javascript/current-rules-2.json"), snapshot([rule("M2")]));
    execSync("git add . && git commit -qm chunks", { cwd: repo });
    execSync("git checkout -qb feature", { cwd: repo });
    execSync("git rm -q plans/prod/javascript/current-rules-*.json", { cwd: repo });
    writeFileSync(join(repo, "plans/prod/javascript/current-rules.json"), snapshot([rule("FeatureOnly")]));
    execSync("git add . && git commit -qm feature", { cwd: repo });
    installSegment();
    store[DEV_ID] = [rule("Old")];
    const ctx = resolveContext(fullEnv(repo));
    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "branch" });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(store[DEV_ID].map((r) => r.key)).toEqual(["M1", "M2"]);
    expect(res.data.rules_patched).toBe(2);
    expect(git(repo, "rev-parse --abbrev-ref HEAD")).toBe("feature");
  });

  it("branch mode NOT_FOUND when main has no prod snapshot even if the current branch does", async () => {
    const repo = makeRepo();
    execSync("git checkout -qb feature", { cwd: repo });
    mkdirSync(join(repo, "plans/prod/javascript"), { recursive: true });
    writeFileSync(join(repo, "plans/prod/javascript/current-rules.json"), snapshot([rule("F")]));
    execSync("git add . && git commit -qm feature", { cwd: repo });
    installSegment();
    const ctx = resolveContext(fullEnv(repo));
    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "branch" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("NOT_FOUND");
    expect(requests).toEqual([]);
  });

  it("files mode warns when the current branch is not main", async () => {
    const repo = makeRepo({ prod: [rule("A")] });
    execSync("git checkout -qb feature", { cwd: repo });
    installSegment();
    const ctx = resolveContext(fullEnv(repo));
    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "files" });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.warnings?.join(" ")).toMatch(/feature/);
    expect(res.warnings?.join(" ")).toMatch(/main/);
  });

  it("files mode on main has no branch warning", async () => {
    const repo = makeRepo({ prod: [rule("A")] });
    installSegment();
    const ctx = resolveContext(fullEnv(repo));
    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "files" });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.warnings).toBeUndefined();
  });

  it("git failure after Segment reset: error carries counts + pull_from_segment remediation; tree clean", async () => {
    const repo = makeRepo({ prod: [rule("A"), rule("B")], dev: [rule("Old")] });
    installFailingPreCommitHook(repo);
    installSegment();
    store[DEV_ID] = [rule("Old")];
    const ctx = resolveContext(fullEnv(repo));
    const res = await resetDevFromProd(ctx, { plan: "javascript", confirm: true, mode: "branch" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("GIT");
    expect((res.error.details as any).rules_deleted).toBe(1);
    expect((res.error.details as any).rules_patched).toBe(2);
    expect(res.error.remediation).toMatch(/DEV Segment tracking plan WAS reset/);
    expect(res.error.remediation).toMatch(/pull_from_segment/);
    expect(res.error.remediation).toMatch(/env: "dev"/);
    expect(git(repo, "rev-parse --abbrev-ref HEAD")).toBe("main");
    expect(git(repo, "status --porcelain")).toBe("");
    expect(git(repo, "branch --list 'tp/*'")).toBe("");
  });
});

// ---- pull_from_segment ---------------------------------------------------
describe("pull_from_segment", () => {
  it("files mode (dev): writes current-rules.json exactly as save-tracking-plan.js", async () => {
    const repo = makeRepo();
    installSegment();
    store[DEV_ID] = [rule("A"), rule("B")];
    const ctx = resolveContext(fullEnv(repo));
    const res = await pullFromSegment(ctx, { plan: "javascript", env: "dev", mode: "files" });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.data.files_changed).toEqual(["plans/dev/javascript/current-rules.json"]);
    expect(res.data.rule_count).toBe(2);
    expect(readFileSync(join(repo, "plans/dev/javascript/current-rules.json"), "utf8")).toBe(
      snapshot(store[DEV_ID]),
    );
  });

  it("prod: reads the PROD plan id with GET only", async () => {
    const repo = makeRepo();
    installSegment();
    store[PROD_ID] = [rule("P")];
    const ctx = resolveContext(fullEnv(repo));
    const res = await pullFromSegment(ctx, { plan: "javascript", env: "prod", mode: "files" });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
    expect(requests[0].url).toContain(`/tracking-plans/${PROD_ID}/rules`);
    expect(existsSync(join(repo, "plans/prod/javascript/current-rules.json"))).toBe(true);
  });

  it("branch mode: commits with `[tp:<plan>] pull <env> snapshot`", async () => {
    const repo = makeRepo({ prod: [rule("Old")] });
    installSegment();
    store[PROD_ID] = [rule("New")];
    const ctx = resolveContext(fullEnv(repo));
    const res = await pullFromSegment(ctx, { plan: "javascript", env: "prod", mode: "branch" });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.data.branch).toMatch(/^tp\/javascript\/pull-prod-snapshot-\d+$/);
    expect(git(repo, `log -1 --format=%s ${res.data.branch}`)).toBe(
      "[tp:javascript] pull prod snapshot",
    );
    expect(git(repo, "rev-parse --abbrev-ref HEAD")).toBe("main");
  });

  it("unchanged content: ok with warning, no commit, no branch left behind", async () => {
    const rules = [rule("A")];
    const repo = makeRepo({ dev: rules });
    installSegment();
    store[DEV_ID] = rules;
    const ctx = resolveContext(fullEnv(repo));
    const head = git(repo, "rev-parse HEAD");
    const res = await pullFromSegment(ctx, { plan: "javascript", env: "dev", mode: "branch" });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.data.files_changed).toEqual([]);
    expect(res.warnings?.join(" ")).toMatch(/unchanged/i);
    expect(res.data.branch).toBeUndefined();
    expect(git(repo, "branch --format='%(refname:short)'")).toBe("main");
    expect(git(repo, "rev-parse HEAD")).toBe(head);
    expect(git(repo, "status --porcelain")).toBe("");
  });

  it("unchanged content in files mode also warns", async () => {
    const rules = [rule("A")];
    const repo = makeRepo({ dev: rules });
    installSegment();
    store[DEV_ID] = rules;
    const ctx = resolveContext(fullEnv(repo));
    const res = await pullFromSegment(ctx, { plan: "javascript", env: "dev", mode: "files" });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.data.files_changed).toEqual([]);
    expect(res.warnings?.join(" ")).toMatch(/unchanged/i);
  });

  it("replaces stale chunk files with the freshly formatted snapshot", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "plans/dev/javascript"), { recursive: true });
    writeFileSync(join(repo, "plans/dev/javascript/current-rules-1.json"), snapshot([rule("X")]));
    writeFileSync(join(repo, "plans/dev/javascript/current-rules-2.json"), snapshot([rule("Y")]));
    execSync("git add . && git commit -qm chunks", { cwd: repo });
    installSegment();
    store[DEV_ID] = [rule("A")];
    const ctx = resolveContext(fullEnv(repo));
    const res = await pullFromSegment(ctx, { plan: "javascript", env: "dev", mode: "branch" });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect([...res.data.files_changed].sort()).toEqual([
      "plans/dev/javascript/current-rules-1.json",
      "plans/dev/javascript/current-rules-2.json",
      "plans/dev/javascript/current-rules.json",
    ]);
    const tree = git(repo, `ls-tree --name-only ${res.data.branch} plans/dev/javascript/`);
    expect(tree).toBe("plans/dev/javascript/current-rules.json");
  });

  it("branch mode: failing pre-commit hook leaves no staged adds/deletes on the original branch", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "plans/dev/javascript"), { recursive: true });
    writeFileSync(join(repo, "plans/dev/javascript/current-rules-1.json"), snapshot([rule("X")]));
    writeFileSync(join(repo, "plans/dev/javascript/current-rules-2.json"), snapshot([rule("Y")]));
    execSync("git add . && git commit -qm chunks", { cwd: repo });
    installFailingPreCommitHook(repo);
    installSegment();
    store[DEV_ID] = [rule("A")];
    const ctx = resolveContext(fullEnv(repo));
    const res = await pullFromSegment(ctx, { plan: "javascript", env: "dev", mode: "branch" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("GIT");
    expect(git(repo, "rev-parse --abbrev-ref HEAD")).toBe("main");
    expect(git(repo, "status --porcelain")).toBe("");
    expect(git(repo, "branch --list 'tp/*'")).toBe("");
    expect(existsSync(join(repo, "plans/dev/javascript/current-rules.json"))).toBe(false);
    expect(existsSync(join(repo, "plans/dev/javascript/current-rules-1.json"))).toBe(true);
  });

  it("CONFIG error when the env's plan id is missing", async () => {
    const repo = makeRepo();
    installSegment();
    const ctx = resolveContext({ REPO_PATH: repo, SEGMENT_PUBLIC_API_TOKEN: "tok", DEV_JS: DEV_ID });
    const res = await pullFromSegment(ctx, { plan: "javascript", env: "prod", mode: "files" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("CONFIG");
    expect(res.error.message).toContain("PROD_JS");
    expect(requests).toEqual([]);
  });

  it("SEGMENT_API error on Segment failure", async () => {
    const repo = makeRepo();
    installSegment({ failOn: "GET", status: 401 });
    const ctx = resolveContext(fullEnv(repo));
    const res = await pullFromSegment(ctx, { plan: "javascript", env: "dev", mode: "files" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("SEGMENT_API");
    expect((res.error.details as any).status).toBe(401);
  });

  it("NOT_FOUND for an unknown plan", async () => {
    const repo = makeRepo();
    installSegment();
    const ctx = resolveContext(fullEnv(repo));
    const res = await pullFromSegment(ctx, { plan: "nope", env: "dev", mode: "files" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("NOT_FOUND");
  });

  it("schema requires env to be dev or prod", () => {
    expect(() => pullFromSegmentInput.parse({ plan: "javascript", env: "staging" })).toThrow();
  });
});

describe("admin tool registration", () => {
  it("registers reset_dev_from_prod and pull_from_segment", () => {
    const repo = makeRepo();
    const names = createServer(resolveContext({ REPO_PATH: repo })).listRegisteredToolNames();
    expect(names).toContain("reset_dev_from_prod");
    expect(names).toContain("pull_from_segment");
  });
});
