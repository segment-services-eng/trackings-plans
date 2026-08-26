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
  // dev has A(x), B(y); prod has A(x, z), C(w)
  const devDir = join(repo, "plans", "dev", "javascript");
  mkdirSync(devDir, { recursive: true });
  writeFileSync(
    join(devDir, "current-rules.json"),
    JSON.stringify({
      rules: [
        {
          key: "A",
          type: "TRACK",
          version: 1,
          jsonSchema: {
            properties: {
              properties: { type: "object", properties: { x: { type: "string" } } },
            },
          },
        },
        {
          key: "B",
          type: "TRACK",
          version: 1,
          jsonSchema: {
            properties: {
              properties: { type: "object", properties: { y: { type: "string" } } },
            },
          },
        },
      ],
    }),
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
});
