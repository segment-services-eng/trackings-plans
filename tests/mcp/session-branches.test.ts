import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { resolveContext } from "../../mcp/context.js";
import { addEvent, updateEvent, removeEvent } from "../../mcp/tools/author.js";
import { bulkAddProperty, bulkRenameProperty } from "../../mcp/tools/bulk.js";
import { applyWriteFlow } from "../../mcp/tools/write-flow.js";
import { ForgeError } from "../../lib/forge.js";
import { FakeForge } from "../helpers/fake-forge.js";

const run = (cwd: string, cmd: string) =>
  execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

interface Fixture {
  repo: string;
  origin: string;
  forge: FakeForge;
  git: (cmd: string) => string;
  ctx: ReturnType<typeof resolveContext>;
}

/**
 * Temp repo with a bare `origin`, one plan, and a pushed default branch.
 * `mcpConfig` is committed as `.tracking-plans-mcp.json` when provided.
 */
function makeFixture(opts: { defaultBranch?: string; mcpConfig?: object } = {}): Fixture {
  const defaultBranch = opts.defaultBranch ?? "main";
  const root = mkdtempSync(join(tmpdir(), "tp-session-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "work");
  run(root, `git init -q --bare -b ${defaultBranch} origin.git`);
  run(root, `git init -q -b ${defaultBranch} work`);
  run(repo, "git config user.email t@t.t && git config user.name t");
  run(repo, `git remote add origin ${origin}`);
  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(
    join(repo, "config", "tracking-plans-config.json"),
    JSON.stringify({
      plans: [{ name: "JavaScript", path: "javascript", dev_secret: "DEV_JS", prod_secret: "PROD_JS" }],
    }),
  );
  if (opts.mcpConfig) {
    writeFileSync(join(repo, ".tracking-plans-mcp.json"), JSON.stringify(opts.mcpConfig));
  }
  run(repo, "git add . && git commit -qm init");
  run(repo, `git push -q -u origin ${defaultBranch}`);
  const forge = new FakeForge();
  const ctx = resolveContext({ REPO_PATH: repo }, { forge });
  return { repo, origin, forge, ctx, git: (cmd) => run(repo, `git ${cmd}`) };
}

/** Creates `name` off HEAD with one committed event, then returns to the original branch. */
function seedSessionBranch(f: Fixture, name: string, push = false): string {
  const orig = f.git("rev-parse --abbrev-ref HEAD");
  f.git(`checkout -q -b ${name}`);
  mkdirSync(join(f.repo, "tracking-rules", "javascript"), { recursive: true });
  writeFileSync(
    join(f.repo, "tracking-rules", "javascript", "Seed_Event.yml"),
    yaml.dump({ rules: [{ key: "Seed Event", type: "TRACK", version: 1, description: "s", properties: {} }] }),
  );
  f.git("add . && git commit -qm seed-session");
  if (push) f.git(`push -q -u origin ${name}`);
  const sha = f.git("rev-parse HEAD");
  f.git(`checkout -q ${orig}`);
  return sha;
}

function addArgs(key: string, extra: Record<string, unknown> = {}) {
  return { plan: "javascript", key, description: "d", properties: {}, ...extra } as any;
}

function expectClean(f: Fixture, branch = "main") {
  expect(f.git("rev-parse --abbrev-ref HEAD")).toBe(branch);
  expect(f.git("status --porcelain")).toBe("");
}

describe("session branches: branch mode", () => {
  it("reuses one branch across 3 calls, producing 3 commits on it", async () => {
    const f = makeFixture();
    const first = await addEvent(f.ctx, addArgs("First Event", { mode: "branch" }));
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    expect(first.data.reused_branch).toBe(false);
    const branch = first.data.branch!;
    const base = f.git("rev-parse main");

    const second = await addEvent(f.ctx, addArgs("Second Event", { mode: "branch", branch }));
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    expect(second.data.branch).toBe(branch);
    expect(second.data.reused_branch).toBe(true);

    // update an event that exists only on the session branch (not on main)
    const third = await updateEvent(f.ctx, {
      plan: "javascript",
      key: "First Event",
      changes: { description: "updated in session" },
      mode: "branch",
      branch,
    });
    if (!third.ok) throw new Error(JSON.stringify(third.error));
    expect(third.data.reused_branch).toBe(true);
    expect(third.data.commit_sha).toBe(f.git(`rev-parse ${branch}`));

    expect(f.git(`rev-list --count ${base}..${branch}`)).toBe("3");
    expect(f.git("branch --list 'tp/*'").split("\n")).toHaveLength(1);
    expectClean(f);
    // main is untouched
    expect(existsSync(join(f.repo, "tracking-rules/javascript/First_Event.yml"))).toBe(false);
    const content = f.git(`show ${branch}:tracking-rules/javascript/First_Event.yml`);
    expect(content).toContain("updated in session");
  });

  it("remove_event and bulk tools also append to the session branch", async () => {
    const f = makeFixture();
    const sha = seedSessionBranch(f, "tp/javascript/session");
    const branch = "tp/javascript/session";

    const bulk = await bulkAddProperty(f.ctx, {
      plan: "javascript",
      property_name: "platform",
      property: { type: "string" },
      dry_run: false,
      mode: "branch",
      branch,
    });
    if (!bulk.ok) throw new Error(JSON.stringify(bulk.error));
    expect(bulk.data.affected_events).toEqual(["Seed Event"]);
    expect(bulk.data.reused_branch).toBe(true);

    const rename = await bulkRenameProperty(f.ctx, {
      plan: "javascript",
      from: "platform",
      to: "os",
      dry_run: false,
      mode: "branch",
      branch,
    });
    if (!rename.ok) throw new Error(JSON.stringify(rename.error));
    expect(rename.data.affected_events).toEqual(["Seed Event"]);

    const removed = await removeEvent(f.ctx, {
      plan: "javascript",
      key: "Seed Event",
      confirm: true,
      mode: "branch",
      branch,
    });
    if (!removed.ok) throw new Error(JSON.stringify(removed.error));
    expect((removed.data.removed_yaml as any).properties.os).toBeDefined();
    expect(f.git(`rev-list --count ${sha}..${branch}`)).toBe("3");
    expectClean(f);
  });

  it("bulk dry_run with branch reads the session branch, not the working tree", async () => {
    const f = makeFixture();
    seedSessionBranch(f, "tp/javascript/session");
    const res = await bulkAddProperty(f.ctx, {
      plan: "javascript",
      property_name: "platform",
      property: { type: "string" },
      dry_run: true,
      mode: "branch",
      branch: "tp/javascript/session",
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.data.affected_events).toEqual(["Seed Event"]);
    expectClean(f);
  });

  it("checks out a branch that exists only on origin as a local tracking branch", async () => {
    const f = makeFixture();
    const branch = "tp/javascript/remote-only";
    const sha = seedSessionBranch(f, branch, true);
    f.git(`branch -D ${branch}`);
    f.git(`update-ref -d refs/remotes/origin/${branch}`);

    const res = await addEvent(f.ctx, addArgs("Another", { mode: "branch", branch }));
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.data.reused_branch).toBe(true);
    expect(f.git(`rev-parse ${branch}~1`)).toBe(sha);
    expect(f.git(`rev-parse --abbrev-ref ${branch}@{upstream}`)).toBe(`origin/${branch}`);
    expectClean(f);
  });

  it("refuses the default branch with VALIDATION", async () => {
    const f = makeFixture();
    const res = await addEvent(f.ctx, addArgs("X", { mode: "branch", branch: "main" }));
    if (res.ok) throw new Error("expected refusal");
    expect(res.error.code).toBe("VALIDATION");
    expect(f.git("rev-list --count main")).toBe("1");
    expectClean(f);
  });

  it("refuses an unknown branch with NOT_FOUND and remediation", async () => {
    const f = makeFixture();
    const res = await addEvent(f.ctx, addArgs("X", { mode: "branch", branch: "tp/javascript/nope" }));
    if (res.ok) throw new Error("expected refusal");
    expect(res.error.code).toBe("NOT_FOUND");
    expect(res.error.remediation).toMatch(/omit branch/i);
    expect(f.git("branch --list 'tp/*'")).toBe("");
    expectClean(f);
  });

  it("rolls back to the pre-call sha when the commit fails, keeping the branch", async () => {
    const f = makeFixture();
    const branch = "tp/javascript/session";
    const sha = seedSessionBranch(f, branch);
    writeFileSync(join(f.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const res = await addEvent(f.ctx, addArgs("Blocked", { mode: "branch", branch }));
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("GIT");
    expect(f.git(`rev-parse ${branch}`)).toBe(sha);
    expect(f.git(`ls-tree -r --name-only ${branch}`)).not.toContain("Blocked.yml");
    expectClean(f);
  });

  it("rolls back and keeps the branch when the mutator throws", async () => {
    const f = makeFixture();
    const branch = "tp/javascript/session";
    const sha = seedSessionBranch(f, branch);
    const res = await applyWriteFlow(f.ctx, "javascript", "JavaScript", "k", "add", "branch", () => {
      writeFileSync(join(f.repo, "partial.yml"), "x");
      throw new Error("boom");
    }, { branch });
    expect(res.ok).toBe(false);
    expect(f.git(`rev-parse ${branch}`)).toBe(sha);
    expect(existsSync(join(f.repo, "partial.yml"))).toBe(false);
    expectClean(f);
  });

  it("zero-files short-circuit on an existing branch does not delete it", async () => {
    const f = makeFixture();
    const branch = "tp/javascript/session";
    const sha = seedSessionBranch(f, branch);
    const res = await bulkAddProperty(f.ctx, {
      plan: "javascript",
      property_name: "p",
      property: { type: "string" },
      filter: "^NOTHING$",
      dry_run: false,
      mode: "branch",
      branch,
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.warnings![0]).toMatch(/no files matched/i);
    expect(f.git(`rev-parse ${branch}`)).toBe(sha);
    expectClean(f);
  });

  it("validation errors from the target branch roll back and keep the branch", async () => {
    const f = makeFixture();
    const branch = "tp/javascript/session";
    const sha = seedSessionBranch(f, branch);
    // Seed Event exists on the session branch only → add_event must refuse.
    const res = await addEvent(f.ctx, addArgs("Seed Event", { mode: "branch", branch }));
    if (res.ok) throw new Error("expected refusal");
    expect(res.error.code).toBe("VALIDATION");
    expect(f.git(`rev-parse ${branch}`)).toBe(sha);
    expectClean(f);
  });

  it("restores the original branch when the caller started on a non-default branch", async () => {
    const f = makeFixture();
    const branch = "tp/javascript/session";
    seedSessionBranch(f, branch);
    f.git("checkout -q -b feature/elsewhere");
    const ok1 = await addEvent(f.ctx, addArgs("A", { mode: "branch", branch }));
    expect(ok1.ok).toBe(true);
    expectClean(f, "feature/elsewhere");
    const bad = await addEvent(f.ctx, addArgs("B", { mode: "branch", branch: "tp/none" }));
    expect(bad.ok).toBe(false);
    expectClean(f, "feature/elsewhere");
    const omitted = await addEvent(f.ctx, addArgs("C", { mode: "branch" }));
    expect(omitted.ok).toBe(true);
    expectClean(f, "feature/elsewhere");
  });

  it("works when the caller is already on the session branch", async () => {
    const f = makeFixture();
    const branch = "tp/javascript/session";
    const sha = seedSessionBranch(f, branch);
    f.git(`checkout -q ${branch}`);
    const res = await addEvent(f.ctx, addArgs("Here", { mode: "branch", branch }));
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(f.git(`rev-parse ${branch}~1`)).toBe(sha);
    expectClean(f, branch);
  });
});

describe("session branches: files mode", () => {
  it("ignores branch with a warning", async () => {
    const f = makeFixture();
    const res = await addEvent(f.ctx, addArgs("Inline", { mode: "files", branch: "tp/whatever" }));
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.warnings?.some((w) => /branch.*ignored/i.test(w))).toBe(true);
    expect(res.data.branch).toBeUndefined();
    expect(existsSync(join(f.repo, "tracking-rules/javascript/Inline.yml"))).toBe(true);
  });
});

describe("session branches: pr mode", () => {
  it("opens a PR on the first call and reuses it on the second (one PR total)", async () => {
    const f = makeFixture();
    const first = await addEvent(f.ctx, addArgs("First", { mode: "pr" }));
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    expect(first.data.pr_reused).toBe(false);
    expect(first.data.reused_branch).toBe(false);
    expect(f.forge.prs).toHaveLength(1);
    expect(f.forge.prs[0].base).toBe("main");
    const branch = first.data.branch!;

    const second = await addEvent(f.ctx, addArgs("Second", { mode: "pr", branch }));
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    expect(second.data.pr_reused).toBe(true);
    expect(second.data.reused_branch).toBe(true);
    expect(second.data.pr_number).toBe(first.data.pr_number);
    expect(second.data.pr_url).toBe(first.data.pr_url);
    expect(f.forge.prs).toHaveLength(1);
    // Both commits are on origin
    expect(run(f.origin, `git rev-parse ${branch}`)).toBe(second.data.commit_sha);
    expectClean(f);
  });

  it("opens a PR for a provided branch that has none yet", async () => {
    const f = makeFixture();
    const branch = "tp/javascript/session";
    seedSessionBranch(f, branch, true);
    const res = await addEvent(f.ctx, addArgs("X", { mode: "pr", branch }));
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.data.pr_reused).toBe(false);
    expect(f.forge.prs).toEqual([expect.objectContaining({ branch, base: "main" })]);
  });

  it("non-fast-forward push is a GIT error with pull remediation; local state restored, no force-push", async () => {
    const f = makeFixture();
    const branch = "tp/javascript/session";
    const sha = seedSessionBranch(f, branch, true);
    // Someone else advances the remote branch.
    const other = join(f.repo, "..", "other");
    run(join(f.repo, ".."), `git clone -q ${f.origin} other`);
    run(other, "git config user.email o@o.o && git config user.name o");
    run(other, `git checkout -q ${branch} && echo x > x.txt && git add x.txt && git commit -qm other && git push -q`);
    const remoteSha = run(f.origin, `git rev-parse ${branch}`);

    const res = await addEvent(f.ctx, addArgs("Mine", { mode: "pr", branch }));
    if (res.ok) throw new Error("expected push rejection");
    expect(res.error.code).toBe("GIT");
    expect(res.error.remediation).toMatch(/pull|rebase/i);
    expect(f.git(`rev-parse ${branch}`)).toBe(sha);
    expect(run(f.origin, `git rev-parse ${branch}`)).toBe(remoteSha);
    expect(f.forge.prs).toHaveLength(0);
    expectClean(f);
  });

  it("maps ForgeError to a ToolResult error with the same code", async () => {
    const f = makeFixture();
    f.forge.openPullRequest = async () => {
      throw new ForgeError("GH_CLI", "gh exploded");
    };
    const res = await addEvent(f.ctx, addArgs("X", { mode: "pr" }));
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("GH_CLI");
    expect(res.error.message).toContain("gh exploded");
    expectClean(f);
  });

  it("keeps the pushed commit when PR lookup fails after a successful push", async () => {
    const f = makeFixture();
    const branch = "tp/javascript/session";
    seedSessionBranch(f, branch, true);
    f.forge.findOpenPullRequest = async () => {
      throw new ForgeError("GITHUB_API", "api down");
    };
    const res = await addEvent(f.ctx, addArgs("X", { mode: "pr", branch }));
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("GITHUB_API");
    // local and origin agree, so a retry is a clean fast-forward
    expect(f.git(`rev-parse ${branch}`)).toBe(run(f.origin, `git rev-parse ${branch}`));
    expectClean(f);
  });
});

describe("session branches: default_branch config", () => {
  it("bases new branches and PRs on develop and refuses develop as a session branch", async () => {
    const f = makeFixture({ defaultBranch: "develop", mcpConfig: { default_branch: "develop" } });
    expect(f.ctx.defaultBranch).toBe("develop");
    const developSha = f.git("rev-parse develop");

    const res = await addEvent(f.ctx, addArgs("Dev Event", { mode: "pr" }));
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(f.git(`rev-parse ${res.data.branch}~1`)).toBe(developSha);
    expect(f.forge.prs[0].base).toBe("develop");
    expectClean(f, "develop");

    const refused = await addEvent(f.ctx, addArgs("Y", { mode: "branch", branch: "develop" }));
    if (refused.ok) throw new Error("expected refusal");
    expect(refused.error.code).toBe("VALIDATION");
  });

  it("bases the new branch on the default branch even when the caller is elsewhere", async () => {
    const f = makeFixture({ defaultBranch: "develop", mcpConfig: { default_branch: "develop" } });
    const developSha = f.git("rev-parse develop");
    f.git("checkout -q -b feature/x");
    writeFileSync(join(f.repo, "extra.txt"), "x");
    f.git("add extra.txt && git commit -qm extra");
    const res = await addEvent(f.ctx, addArgs("Z", { mode: "branch" }));
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(f.git(`rev-parse ${res.data.branch}~1`)).toBe(developSha);
    expectClean(f, "feature/x");
  });
});

describe("branch argument schema", () => {
  it("rejects branch names that could be parsed as git options", async () => {
    const { addEventInput } = await import("../../mcp/tools/author.js");
    expect(() => addEventInput.parse(addArgs("K", { branch: "--force" }))).toThrow();
    expect(addEventInput.parse(addArgs("K", { branch: "tp/javascript/x-1" })).branch).toBe(
      "tp/javascript/x-1",
    );
  });

  it("describes passing back the returned branch", async () => {
    const { sessionBranchSchema } = await import("../../mcp/tools/schemas.js");
    expect(sessionBranchSchema.description).toMatch(/pass back|returned/i);
    void readFileSync;
  });
});
