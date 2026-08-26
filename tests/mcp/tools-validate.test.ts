import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContext } from "../../mcp/context.js";
import { validateEvent, validatePlan, lintRules } from "../../mcp/tools/validate.js";

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "tp-val-"));
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
  const planDir = join(repo, "plans", "dev", "javascript");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(
    join(planDir, "current-rules.json"),
    JSON.stringify({
      rules: [
        {
          key: "Product Viewed",
          type: "TRACK",
          version: 1,
          jsonSchema: {
            description: "Fired on view",
            properties: {
              properties: {
                type: "object",
                properties: {
                  product_id: { type: "string", description: "id" },
                },
              },
            },
          },
        },
        {
          key: "Bad Event",
          type: "TRACK",
          version: 1,
          jsonSchema: {
            properties: {
              properties: {
                type: "object",
                properties: { p: { type: "banana" } },
              },
            },
          },
        },
      ],
    }),
  );
  return repo;
}

function makeRepoWithYaml(): string {
  const repo = makeRepo();
  const yamlDir = join(repo, "tracking-rules", "javascript");
  mkdirSync(yamlDir, { recursive: true });
  // Yaml for Product Viewed matches snapshot; a third YAML event has no snapshot counterpart.
  writeFileSync(
    join(yamlDir, "Product_Viewed.yml"),
    "rules:\n  - key: Product Viewed\n    type: TRACK\n    version: 1\n    description: Fired on view\n    properties:\n      product_id:\n        type: string\n        description: id\n",
  );
  writeFileSync(
    join(yamlDir, "Only_In_Yaml.yml"),
    "rules:\n  - key: Only In Yaml\n    type: TRACK\n    version: 1\n    description: not yet promoted\n    properties: {}\n",
  );
  return repo;
}

describe("validate MCP tools", () => {
  it("validate_event returns findings for one event", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await validateEvent(ctx, {
      plan: "javascript",
      env: "dev",
      key: "Bad Event",
    });
    if (!res.ok) throw new Error();
    expect(res.data.findings.map((f) => f.code)).toContain("invalid_property_type");
  });

  it("validate_event NOT_FOUND for missing event", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await validateEvent(ctx, {
      plan: "javascript",
      env: "dev",
      key: "Bogus",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.error.code).toBe("NOT_FOUND");
  });

  it("validate_plan returns findings + summary", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await validatePlan(ctx, { plan: "javascript", env: "dev" });
    if (!res.ok) throw new Error();
    expect(res.data.summary.errors).toBeGreaterThanOrEqual(1);
    expect(res.data.findings.length).toBeGreaterThanOrEqual(1);
  });

  it("lint_rules emits orphan_event findings for YAML vs snapshot", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepoWithYaml() });
    const res = await lintRules(ctx, {
      plan: "javascript",
      env: "dev",
      source: "yaml",
    });
    if (!res.ok) throw new Error();
    const orphans = res.data.findings.filter((f) => f.code === "orphan_event");
    expect(orphans.some((f) => f.path === "Only In Yaml")).toBe(true);
  });
});
