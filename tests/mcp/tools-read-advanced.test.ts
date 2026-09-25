import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContext } from "../../mcp/context.js";
import {
  diffPlans,
  findPropertyUsage,
  listRecentChanges,
} from "../../mcp/tools/read.js";

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "tp-adv-"));
  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(
    join(repo, "config", "tracking-plans-config.json"),
    JSON.stringify({
      plans: [
        {
          name: "JavaScript",
          path: "javascript",
          dev_secret: "DEV_JS",
          prod_secret: "PROD_JS",
        },
      ],
    }),
  );
  // dev has A(x), B(y) as YAML; prod has A(x, z), C(w) as snapshot
  const devYaml = join(repo, "tracking-rules", "javascript");
  mkdirSync(devYaml, { recursive: true });
  writeFileSync(
    join(devYaml, "A.yml"),
    "rules:\n  - key: A\n    type: TRACK\n    version: 1\n    properties:\n      x:\n        type: string\n",
  );
  writeFileSync(
    join(devYaml, "B.yml"),
    "rules:\n  - key: B\n    type: TRACK\n    version: 1\n    properties:\n      y:\n        type: string\n",
  );
  const prodDir = join(repo, "plans", "prod", "javascript");
  mkdirSync(prodDir, { recursive: true });
  writeFileSync(
    join(prodDir, "current-rules.json"),
    JSON.stringify({
      rules: [
        {
          key: "A",
          type: "TRACK",
          version: 1,
          jsonSchema: {
            properties: {
              properties: {
                type: "object",
                properties: { x: { type: "number" }, z: { type: "boolean" } },
              },
            },
          },
        },
        {
          key: "C",
          type: "TRACK",
          version: 1,
          jsonSchema: {
            properties: {
              properties: { type: "object", properties: { w: { type: "string" } } },
            },
          },
        },
      ],
    }),
  );
  return repo;
}

function makeGitRepo(): string {
  const repo = makeRepo();
  const trackingDir = join(repo, "tracking-rules", "javascript");
  mkdirSync(trackingDir, { recursive: true });
  writeFileSync(join(trackingDir, "a.yml"), "rules:\n  - key: A\n");
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  execSync("git add . && git commit -qm 'initial'", { cwd: repo });
  writeFileSync(join(trackingDir, "b.yml"), "rules:\n  - key: B\n");
  execSync("git add . && git commit -qm 'add b'", { cwd: repo });
  return repo;
}

describe("diffPlans", () => {
  it("reports added, removed, and modified between dev and prod", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await diffPlans(ctx, {
      planA: "javascript",
      envA: "dev",
      planB: "javascript",
      envB: "prod",
    });
    if (!res.ok) throw new Error();
    expect(res.data.added.sort()).toEqual(["C"]);
    expect(res.data.removed.sort()).toEqual(["B"]);
    expect(res.data.modified.map((m) => m.key)).toEqual(["A"]);
    const changes = res.data.modified[0].changes.join("\n");
    expect(changes).toMatch(/added property z/);
    expect(changes).toMatch(/type from string to number/);
  });
});

describe("findPropertyUsage", () => {
  it("finds events using a given property in dev", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await findPropertyUsage(ctx, { property: "x", env: "dev" });
    if (!res.ok) throw new Error();
    expect(res.data.usages).toEqual([{ plan: "javascript", event: "A" }]);
  });
});

describe("listRecentChanges", () => {
  it("returns commit log limited to the tracking-rules/<plan> directory", async () => {
    const ctx = resolveContext({ REPO_PATH: makeGitRepo() });
    const res = await listRecentChanges(ctx, { plan: "javascript", limit: 10 });
    if (!res.ok) throw new Error();
    expect(res.data.commits.length).toBeGreaterThanOrEqual(1);
    expect(res.data.commits[0].subject).toMatch(/add b|initial/);
  });

  it("returns GIT error envelope when REPO_PATH is not a git repository", async () => {
    // makeRepo() creates a plain directory with no git init
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await listRecentChanges(ctx, { plan: "javascript", limit: 5 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("GIT");
  });
});

describe("diffPlans — description and required changes", () => {
  function makeDescRequiredRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "tp-descreq-"));
    mkdirSync(join(repo, "config"), { recursive: true });
    writeFileSync(
      join(repo, "config", "tracking-plans-config.json"),
      JSON.stringify({
        plans: [
          {
            name: "JavaScript",
            path: "javascript",
            dev_secret: "DEV_JS",
            prod_secret: "PROD_JS",
          },
        ],
      }),
    );
    // dev: YAML event E with description "Old description" and prop p (not required)
    const devYaml = join(repo, "tracking-rules", "javascript");
    mkdirSync(devYaml, { recursive: true });
    writeFileSync(
      join(devYaml, "E.yml"),
      "rules:\n  - key: E\n    type: TRACK\n    version: 1\n    description: Old description\n    properties:\n      p:\n        type: string\n",
    );
    // prod: event E with description "New description" and prop p (now required)
    const prodDir = join(repo, "plans", "prod", "javascript");
    mkdirSync(prodDir, { recursive: true });
    writeFileSync(
      join(prodDir, "current-rules.json"),
      JSON.stringify({
        rules: [
          {
            key: "E",
            type: "TRACK",
            version: 1,
            jsonSchema: {
              description: "New description",
              properties: {
                properties: {
                  type: "object",
                  properties: { p: { type: "string" } },
                  required: ["p"],
                },
              },
            },
          },
        ],
      }),
    );
    return repo;
  }

  it("reports description change in modified[].changes", async () => {
    const ctx = resolveContext({ REPO_PATH: makeDescRequiredRepo() });
    const res = await diffPlans(ctx, {
      planA: "javascript",
      envA: "dev",
      planB: "javascript",
      envB: "prod",
    });
    if (!res.ok) throw new Error(JSON.stringify(res));
    expect(res.data.modified.map((m) => m.key)).toContain("E");
    const changes = res.data.modified.find((m) => m.key === "E")!.changes.join("\n");
    expect(changes).toMatch(/changed description from/);
    expect(changes).toMatch(/Old description/);
    expect(changes).toMatch(/New description/);
  });

  it("reports required-set change in modified[].changes", async () => {
    const ctx = resolveContext({ REPO_PATH: makeDescRequiredRepo() });
    const res = await diffPlans(ctx, {
      planA: "javascript",
      envA: "dev",
      planB: "javascript",
      envB: "prod",
    });
    if (!res.ok) throw new Error(JSON.stringify(res));
    const changes = res.data.modified.find((m) => m.key === "E")!.changes.join("\n");
    expect(changes).toMatch(/property p is now required/);
  });
});

describe("findPropertyUsage — cross-plan search", () => {
  function makeTwoPlanRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "tp-twoplans-"));
    mkdirSync(join(repo, "config"), { recursive: true });
    writeFileSync(
      join(repo, "config", "tracking-plans-config.json"),
      JSON.stringify({
        plans: [
          {
            name: "JavaScript",
            path: "javascript",
            dev_secret: "DEV_JS",
            prod_secret: "PROD_JS",
          },
          {
            name: "Server",
            path: "server",
            dev_secret: "DEV_SERVER",
            prod_secret: "PROD_SERVER",
          },
        ],
      }),
    );
    for (const planPath of ["javascript", "server"]) {
      const dir = join(repo, "tracking-rules", planPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "Event_With_User.yml"),
        "rules:\n  - key: Event With User\n    type: TRACK\n    version: 1\n    properties:\n      user_id:\n        type: string\n",
      );
    }
    return repo;
  }

  it("finds property usage across all plans when plan arg is omitted", async () => {
    const ctx = resolveContext({ REPO_PATH: makeTwoPlanRepo() });
    const res = await findPropertyUsage(ctx, { property: "user_id", env: "dev" });
    if (!res.ok) throw new Error(JSON.stringify(res));
    const planPaths = res.data.usages.map((u) => u.plan);
    expect(planPaths).toContain("javascript");
    expect(planPaths).toContain("server");
    expect(res.data.usages).toHaveLength(2);
  });
});
