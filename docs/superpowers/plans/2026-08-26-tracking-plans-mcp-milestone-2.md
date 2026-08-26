# Tracking Plans MCP — Milestone 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute task-by-task. Steps use checkbox (`- [ ]`) for tracking.

**Goal:** Extend the MCP server with validation, preview, and authoring capabilities. After M2, a user can ask Claude to lint a plan, preview the markdown that will land in `docs/`, and draft YAML changes on a new branch (or full PR) — while the merge-to-main promotion spine stays untouched.

**Architecture:** Adds one new lib module (`validate.ts`), one new lib module (`git-ops.ts`), and eight new MCP tools. Reuses the `ToolResult` envelope from M1. Authoring tools follow a three-mode pattern (`files` → `branch` → `pr`) governed by tool arg > `MCP_WRITE_MODE` env > default `"branch"`. No Segment prod writes are possible from any M2 tool.

**Tech Stack:** Same as M1 — TypeScript, Vitest, msw, `@modelcontextprotocol/sdk`, zod. New: no additional runtime deps; git operations shell to the local `git` binary, PRs shell to `gh` CLI with an Octokit fallback via `@octokit/rest` (added in Task 4).

## Global Constraints

- Node 20+.
- All M1 tests must still pass (43 passing at start of M2).
- `lib/*` remains pure — no `process.env` access, no I/O at import.
- Authoring tools must NEVER write to Segment prod. Any code path that patches Segment must refuse when `env === "prod"` and return `PROD_WRITE_BLOCKED`.
- Authoring tools default `mode: "branch"`; overridden by tool arg or `MCP_WRITE_MODE` env.
- When `mode` is `branch` or `pr`, the working tree must be clean or the tool returns `DIRTY_TREE`.
- Every task ends with a green test run and a commit. TDD required for new lib modules and non-trivial MCP tools.

---

## File Structure Overview

```
lib/
├── validate.ts       # Task 1 — pure validation of YAML rules
└── git-ops.ts        # Task 4 — pure wrappers over git + gh CLI
mcp/
├── context.ts        # Task 5 — extended with write-mode + working-tree helpers
└── tools/
    ├── validate.ts   # Task 2 — validate_event, validate_plan, lint_rules
    ├── preview.ts    # Task 3 — preview_markdown, preview_segment_payload
    ├── author.ts     # Tasks 6, 7 — add_event, update_event, remove_event
    └── bulk.ts       # Task 8 — bulk_rename_property, bulk_add_property
tests/                # Vitest tests colocated by module
```

---

## Task 1: Add `lib/validate.ts`

**Files:**
- Create: `lib/validate.ts`
- Create: `tests/lib/validate.test.ts`

**Interfaces:**
- Consumes: `YamlRule`, `YamlProperty` from `lib/yaml-transform.ts`.
- Produces:
  - `type Finding = { severity: "error" | "warning"; code: string; path: string; message: string; }` — `path` is a dotted event/property path like `"Product Viewed.properties.product_id"`.
  - `validateRule(rule: YamlRule): Finding[]` — validates a single event.
  - `validatePlan(rules: YamlRule[]): Finding[]` — validates a plan (calls validateRule per event + adds plan-level lints).

Checks performed (single-event):

| Code                    | Severity | Condition                                                              |
| ----------------------- | -------- | ---------------------------------------------------------------------- |
| `missing_key`           | error    | `rule.key` empty or missing                                            |
| `invalid_type`          | error    | `rule.type` not in `["TRACK","IDENTIFY","GROUP","PAGE","SCREEN"]`      |
| `invalid_version`       | error    | `rule.version` not a positive integer                                  |
| `missing_description`   | warning  | `rule.description` missing, empty, or whitespace                       |
| `missing_property_type` | error    | Any property has no `type` field                                       |
| `invalid_property_type` | error    | Property `type` not one of JSON Schema primitives (string/number/integer/boolean/array/object/null) |
| `missing_property_description` | warning | Property has no non-empty `description`                       |

Plan-level checks:

| Code                    | Severity | Condition                                                              |
| ----------------------- | -------- | ---------------------------------------------------------------------- |
| `duplicate_event_key`   | error    | Two events share the same `key`                                        |
| `inconsistent_property_type` | warning | Same property name defined with different types across events        |

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/validate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateRule, validatePlan } from "../../lib/validate.js";
import type { YamlRule } from "../../lib/yaml-transform.js";

const good: YamlRule = {
  key: "Product Viewed",
  type: "TRACK",
  version: 1,
  description: "Fired on view",
  properties: {
    product_id: { type: "string", description: "the id", required: true },
  },
};

describe("validateRule", () => {
  it("returns empty for a fully-valid rule", () => {
    expect(validateRule(good)).toEqual([]);
  });

  it("flags missing_key", () => {
    const f = validateRule({ ...good, key: "" });
    expect(f.map((x) => x.code)).toContain("missing_key");
  });

  it("flags invalid_type", () => {
    const f = validateRule({ ...good, type: "BOGUS" } as any);
    expect(f.map((x) => x.code)).toContain("invalid_type");
  });

  it("flags invalid_version", () => {
    const f = validateRule({ ...good, version: 0 } as any);
    expect(f.map((x) => x.code)).toContain("invalid_version");
  });

  it("warns on missing description", () => {
    const f = validateRule({ ...good, description: "  " });
    expect(f.find((x) => x.code === "missing_description")?.severity).toBe("warning");
  });

  it("errors on property missing type", () => {
    const f = validateRule({
      ...good,
      properties: { product_id: { description: "no type" } as any },
    });
    expect(f.map((x) => x.code)).toContain("missing_property_type");
  });

  it("errors on invalid property type", () => {
    const f = validateRule({
      ...good,
      properties: { product_id: { type: "banana" } as any },
    });
    expect(f.map((x) => x.code)).toContain("invalid_property_type");
  });

  it("warns on property missing description", () => {
    const f = validateRule({
      ...good,
      properties: { product_id: { type: "string" } },
    });
    expect(f.find((x) => x.code === "missing_property_description")?.severity).toBe("warning");
  });

  it("path is dotted event.properties.propname", () => {
    const f = validateRule({
      ...good,
      properties: { product_id: { type: "string" } },
    });
    expect(f.find((x) => x.code === "missing_property_description")?.path).toBe(
      "Product Viewed.properties.product_id",
    );
  });
});

describe("validatePlan", () => {
  it("flags duplicate_event_key", () => {
    const findings = validatePlan([good, { ...good }]);
    expect(findings.map((f) => f.code)).toContain("duplicate_event_key");
  });

  it("flags inconsistent_property_type across events", () => {
    const other: YamlRule = {
      key: "Order Completed",
      type: "TRACK",
      version: 1,
      description: "d",
      properties: {
        product_id: { type: "number", description: "d" },
      },
    };
    const findings = validatePlan([good, other]);
    expect(findings.find((f) => f.code === "inconsistent_property_type")?.severity).toBe(
      "warning",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `lib/validate.js` does not exist.

- [ ] **Step 3: Implement `lib/validate.ts`**

```ts
import type { YamlRule, YamlProperty } from "./yaml-transform.js";

export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  code: string;
  path: string;
  message: string;
}

const VALID_TYPES = new Set(["TRACK", "IDENTIFY", "GROUP", "PAGE", "SCREEN"]);
const VALID_PROP_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
]);

function err(code: string, path: string, message: string): Finding {
  return { severity: "error", code, path, message };
}
function warn(code: string, path: string, message: string): Finding {
  return { severity: "warning", code, path, message };
}

function checkProperty(
  eventKey: string,
  propName: string,
  prop: YamlProperty,
): Finding[] {
  const path = `${eventKey}.properties.${propName}`;
  const out: Finding[] = [];
  if (!prop.type) {
    out.push(err("missing_property_type", path, `Property "${propName}" has no type`));
  } else if (!VALID_PROP_TYPES.has(prop.type)) {
    out.push(
      err(
        "invalid_property_type",
        path,
        `Property "${propName}" has invalid type "${prop.type}"`,
      ),
    );
  }
  if (!prop.description || !prop.description.trim()) {
    out.push(
      warn(
        "missing_property_description",
        path,
        `Property "${propName}" is missing a description`,
      ),
    );
  }
  if (prop.properties) {
    for (const [nested, nestedProp] of Object.entries(prop.properties)) {
      out.push(...checkProperty(eventKey, `${propName}.${nested}`, nestedProp));
    }
  }
  return out;
}

export function validateRule(rule: YamlRule): Finding[] {
  const path = rule.key || "<unknown>";
  const out: Finding[] = [];
  if (!rule.key || !rule.key.trim()) {
    out.push(err("missing_key", path, "Rule is missing a key"));
  }
  if (!rule.type || !VALID_TYPES.has(rule.type)) {
    out.push(
      err(
        "invalid_type",
        path,
        `Rule "${path}" has invalid type "${rule.type}" (allowed: ${[...VALID_TYPES].join(", ")})`,
      ),
    );
  }
  if (!Number.isInteger(rule.version) || rule.version <= 0) {
    out.push(
      err("invalid_version", path, `Rule "${path}" has invalid version "${rule.version}"`),
    );
  }
  if (!rule.description || !rule.description.trim()) {
    out.push(warn("missing_description", path, `Rule "${path}" is missing a description`));
  }
  for (const [name, prop] of Object.entries(rule.properties ?? {})) {
    out.push(...checkProperty(rule.key, name, prop));
  }
  return out;
}

export function validatePlan(rules: YamlRule[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    out.push(...validateRule(rule));
    if (rule.key) {
      if (seen.has(rule.key)) {
        out.push(
          err(
            "duplicate_event_key",
            rule.key,
            `Duplicate event key "${rule.key}" — event keys must be unique within a plan`,
          ),
        );
      }
      seen.add(rule.key);
    }
  }
  const propertyTypes = new Map<string, Set<string>>();
  for (const rule of rules) {
    for (const [name, prop] of Object.entries(rule.properties ?? {})) {
      if (!prop.type) continue;
      if (!propertyTypes.has(name)) propertyTypes.set(name, new Set());
      propertyTypes.get(name)!.add(prop.type);
    }
  }
  for (const [name, types] of propertyTypes) {
    if (types.size > 1) {
      out.push(
        warn(
          "inconsistent_property_type",
          name,
          `Property "${name}" is defined with different types across events: ${[...types].join(", ")}`,
        ),
      );
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 11 new tests + 43 M1 = 54 total.

- [ ] **Step 5: Commit**

```bash
git add lib/validate.ts tests/lib/validate.test.ts
git commit -m "feat(lib): add validate module with rule and plan-level checks"
```

---

## Task 2: MCP tools — `validate_event`, `validate_plan`, `lint_rules`

**Files:**
- Create: `mcp/tools/validate.ts`
- Modify: `mcp/tools/index.ts` — register three new tools.
- Create: `tests/mcp/tools-validate.test.ts`

**Interfaces:**
- Consumes: `validateRule`, `validatePlan` from `lib/validate.ts`; `readPlanSnapshot` from `lib/plan-snapshot.ts`; `ruleToYaml` from `lib/yaml-transform.ts`; `ServerContext` and `PlanNotFoundError`.
- Produces:
  - `validateEventInput`: `{ plan, env, key }`. Returns `ToolResult<{ findings: Finding[] }>`.
  - `validatePlanInput`: `{ plan, env }`. Returns `ToolResult<{ findings: Finding[]; summary: { errors: number; warnings: number } }>`.
  - `lintRulesInput`: `{ plan, env, source?: "yaml" | "snapshot" }` — `"yaml"` reads `tracking-rules/<planPath>/*.yml` directly; `"snapshot"` (default) reads `plans/<env>/<planPath>/current-rules*.json`.

`lint_rules` differs from `validate_plan` by additionally emitting `orphan_event` findings — events present in one source but not the other. When `source: "yaml"`, orphans are events in YAML with no snapshot counterpart; when `source: "snapshot"`, orphans are snapshot events with no YAML file.

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp/tools-validate.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `mcp/tools/validate.js` does not exist.

- [ ] **Step 3: Implement `mcp/tools/validate.ts`**

```ts
import { z } from "zod";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerContext } from "../context.js";
import { err, ok, ToolResult } from "./result.js";
import { readPlanSnapshot } from "../../lib/plan-snapshot.js";
import { ruleToYaml, loadYamlRuleFile, YamlRule } from "../../lib/yaml-transform.js";
import { validateRule, validatePlan as libValidatePlan, Finding } from "../../lib/validate.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";

export const validateEventInput = z
  .object({ plan: z.string(), env: z.enum(["dev", "prod"]), key: z.string() })
  .strict();
export const validatePlanInput = z
  .object({ plan: z.string(), env: z.enum(["dev", "prod"]) })
  .strict();
export const lintRulesInput = z
  .object({
    plan: z.string(),
    env: z.enum(["dev", "prod"]),
    source: z.enum(["yaml", "snapshot"]).optional(),
  })
  .strict();

function resolvePlanOr<T>(
  ctx: ServerContext,
  nameOrPath: string,
): { plan: import("../../lib/plans-config.js").PlanConfig } | ToolResult<T> {
  try {
    return { plan: ctx.resolvePlanOrThrow(nameOrPath) };
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
}

function readYamlRules(repoPath: string, planPath: string): YamlRule[] {
  const dir = join(repoPath, "tracking-rules", planPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => loadYamlRuleFile(join(dir, f)));
}

export async function validateEvent(
  ctx: ServerContext,
  args: z.infer<typeof validateEventInput>,
): Promise<ToolResult<{ findings: Finding[] }>> {
  const resolved = resolvePlanOr<{ findings: Finding[] }>(ctx, args.plan);
  if ("ok" in resolved) return resolved;
  const rules = readPlanSnapshot(ctx.repoPath, args.env, resolved.plan.path);
  const match = rules.find((r) => r.key === args.key);
  if (!match) {
    return err(
      "NOT_FOUND",
      `Event "${args.key}" not found in ${resolved.plan.name} (${args.env})`,
    );
  }
  return ok({ findings: validateRule(ruleToYaml(match)) });
}

export async function validatePlan(
  ctx: ServerContext,
  args: z.infer<typeof validatePlanInput>,
): Promise<
  ToolResult<{ findings: Finding[]; summary: { errors: number; warnings: number } }>
> {
  const resolved = resolvePlanOr<{
    findings: Finding[];
    summary: { errors: number; warnings: number };
  }>(ctx, args.plan);
  if ("ok" in resolved) return resolved;
  const rules = readPlanSnapshot(ctx.repoPath, args.env, resolved.plan.path).map(
    ruleToYaml,
  );
  const findings = libValidatePlan(rules);
  const summary = {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
  };
  return ok({ findings, summary });
}

export async function lintRules(
  ctx: ServerContext,
  args: z.infer<typeof lintRulesInput>,
): Promise<ToolResult<{ findings: Finding[] }>> {
  const resolved = resolvePlanOr<{ findings: Finding[] }>(ctx, args.plan);
  if ("ok" in resolved) return resolved;
  const source = args.source ?? "snapshot";
  const yamlRules = readYamlRules(ctx.repoPath, resolved.plan.path);
  const snapshotRules = readPlanSnapshot(
    ctx.repoPath,
    args.env,
    resolved.plan.path,
  ).map(ruleToYaml);

  const base = source === "yaml" ? yamlRules : snapshotRules;
  const other = source === "yaml" ? snapshotRules : yamlRules;
  const findings: Finding[] = libValidatePlan(base);

  const otherKeys = new Set(other.map((r) => r.key));
  for (const r of base) {
    if (r.key && !otherKeys.has(r.key)) {
      findings.push({
        severity: "warning",
        code: "orphan_event",
        path: r.key,
        message: `"${r.key}" exists in ${source} but not in ${source === "yaml" ? "snapshot" : "yaml"}`,
      });
    }
  }
  return ok({ findings });
}
```

- [ ] **Step 4: Register the three tools in `mcp/tools/index.ts`**

Add imports:

```ts
import {
  validateEvent,
  validateEventInput,
  validatePlan,
  validatePlanInput,
  lintRules,
  lintRulesInput,
} from "./validate.js";
```

Add to the `tools` array:

```ts
makeTool(
  "validate_event",
  "Validate a single event's schema, types, and required descriptions.",
  validateEventInput,
  validateEvent,
),
makeTool(
  "validate_plan",
  "Validate all events in a plan snapshot; returns findings and a severity summary.",
  validatePlanInput,
  validatePlan,
),
makeTool(
  "lint_rules",
  "Deep lint of a plan: schema errors, warnings, and orphan events between yaml and snapshot.",
  lintRulesInput,
  lintRules,
),
```

- [ ] **Step 5: Build and test**

Run: `npm run build && npm test`
Expected: PASS — 4 new tests + 54 prior = 58.

- [ ] **Step 6: Commit**

```bash
git add mcp/tools/validate.ts mcp/tools/index.ts tests/mcp/tools-validate.test.ts
git commit -m "feat(mcp): add validate_event, validate_plan, lint_rules"
```

---

## Task 3: MCP tools — `preview_markdown`, `preview_segment_payload`

**Files:**
- Create: `mcp/tools/preview.ts`
- Modify: `mcp/tools/index.ts` — register two new tools.
- Create: `tests/mcp/tools-preview.test.ts`

**Interfaces:**
- Consumes: `renderMarkdown` from `lib/render-markdown.ts`; `readYamlRules` helper (import from `mcp/tools/validate.ts` — export it there); `yamlToRule` for the payload preview.
- Produces:
  - `previewMarkdownInput`: `{ plan, source?: "yaml" | "snapshot", env? }`. Default `source: "yaml"` — the point of preview is "what would my LOCAL changes render as." When `source: "snapshot"`, `env` is required. Returns `{ markdown: string; diff_against_committed?: string }` — `diff_against_committed` is a unified diff vs `docs/<plan>.md` computed via `execFileSync("git", ["diff", "--no-index", ...])`.
  - `previewSegmentPayloadInput`: `{ plan, key }` — reads `tracking-rules/<planPath>/<key>.yml`, converts to Segment JSON, returns `{ payload: Rule }`. Never touches Segment.

- [ ] **Step 1: Export `readYamlRules` from validate.ts**

Modify `mcp/tools/validate.ts`: change `function readYamlRules(...)` to `export function readYamlRules(...)`.

- [ ] **Step 2: Write the failing tests**

Create `tests/mcp/tools-preview.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContext } from "../../mcp/context.js";
import {
  previewMarkdown,
  previewSegmentPayload,
} from "../../mcp/tools/preview.js";

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "tp-prev-"));
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
  const yamlDir = join(repo, "tracking-rules", "javascript");
  mkdirSync(yamlDir, { recursive: true });
  writeFileSync(
    join(yamlDir, "Product_Viewed.yml"),
    "rules:\n  - key: Product Viewed\n    type: TRACK\n    version: 1\n    description: Fired on view\n    properties:\n      product_id:\n        type: string\n        description: id\n        required: true\n",
  );
  return repo;
}

describe("preview MCP tools", () => {
  it("previewMarkdown renders from local YAML", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await previewMarkdown(ctx, { plan: "javascript" });
    if (!res.ok) throw new Error();
    expect(res.data.markdown).toContain("# JavaScript");
    expect(res.data.markdown).toContain("## Product Viewed");
    expect(res.data.markdown).toContain("| **product_id** | `string`");
  });

  it("previewSegmentPayload returns Segment JSON for an event", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await previewSegmentPayload(ctx, {
      plan: "javascript",
      key: "Product Viewed",
    });
    if (!res.ok) throw new Error();
    expect(res.data.payload.key).toBe("Product Viewed");
    const schema = res.data.payload.jsonSchema as any;
    expect(schema.properties.properties.required).toContain("product_id");
  });

  it("previewSegmentPayload NOT_FOUND for missing event", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await previewSegmentPayload(ctx, {
      plan: "javascript",
      key: "Bogus",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.error.code).toBe("NOT_FOUND");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `mcp/tools/preview.js` does not exist.

- [ ] **Step 4: Implement `mcp/tools/preview.ts`**

```ts
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ServerContext } from "../context.js";
import { err, ok, ToolResult } from "./result.js";
import { renderMarkdown } from "../../lib/render-markdown.js";
import { yamlToRule, type YamlRule } from "../../lib/yaml-transform.js";
import type { Rule } from "../../lib/segment-api.js";
import { readPlanSnapshot } from "../../lib/plan-snapshot.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";
import { readYamlRules } from "./validate.js";

export const previewMarkdownInput = z
  .object({
    plan: z.string(),
    source: z.enum(["yaml", "snapshot"]).optional(),
    env: z.enum(["dev", "prod"]).optional(),
  })
  .strict();

export const previewSegmentPayloadInput = z
  .object({ plan: z.string(), key: z.string() })
  .strict();

export async function previewMarkdown(
  ctx: ServerContext,
  args: z.infer<typeof previewMarkdownInput>,
): Promise<
  ToolResult<{ markdown: string; diff_against_committed: string | null }>
> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const source = args.source ?? "yaml";
  let rules: Rule[];
  if (source === "yaml") {
    rules = readYamlRules(ctx.repoPath, plan.path).map(yamlToRule);
  } else {
    if (!args.env) {
      return err(
        "VALIDATION",
        "env is required when source is 'snapshot'",
      );
    }
    rules = readPlanSnapshot(ctx.repoPath, args.env, plan.path);
  }
  const markdown = renderMarkdown({ title: plan.name, rules });

  const committedMdPath = join(ctx.repoPath, "docs", `${plan.name}.md`);
  let diff: string | null = null;
  if (existsSync(committedMdPath)) {
    try {
      execFileSync(
        "git",
        ["diff", "--no-index", "--no-color", committedMdPath, "-"],
        { cwd: ctx.repoPath, input: markdown, encoding: "utf8" },
      );
      diff = "";
    } catch (e: any) {
      diff = typeof e.stdout === "string" ? e.stdout : String(e.stdout ?? "");
    }
  }
  return ok({ markdown, diff_against_committed: diff });
}

export async function previewSegmentPayload(
  ctx: ServerContext,
  args: z.infer<typeof previewSegmentPayloadInput>,
): Promise<ToolResult<{ payload: Rule }>> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const yamlRules = readYamlRules(ctx.repoPath, plan.path);
  const match = yamlRules.find((r: YamlRule) => r.key === args.key);
  if (!match) {
    return err(
      "NOT_FOUND",
      `Event "${args.key}" has no yaml file in tracking-rules/${plan.path}/`,
    );
  }
  return ok({ payload: yamlToRule(match) });
}
```

Note on `execFileSync` behavior: `git diff --no-index` exits with status 1 when files differ (this is expected). Node's `execFileSync` treats non-zero exit as an error and throws — the diff output is on `e.stdout`. The code above handles both cases.

- [ ] **Step 5: Register in `mcp/tools/index.ts`**

Add imports:

```ts
import {
  previewMarkdown,
  previewMarkdownInput,
  previewSegmentPayload,
  previewSegmentPayloadInput,
} from "./preview.js";
```

Add to the tools array:

```ts
makeTool(
  "preview_markdown",
  "Render the markdown data dictionary from local YAML (or snapshot). Returns markdown + diff vs committed docs/<plan>.md.",
  previewMarkdownInput,
  previewMarkdown,
),
makeTool(
  "preview_segment_payload",
  "Show the exact Segment JSON payload for one event based on local YAML. Never touches Segment.",
  previewSegmentPayloadInput,
  previewSegmentPayload,
),
```

- [ ] **Step 6: Build and test**

Run: `npm run build && npm test`
Expected: PASS — 3 new + 58 prior = 61.

- [ ] **Step 7: Commit**

```bash
git add mcp/tools/preview.ts mcp/tools/validate.ts mcp/tools/index.ts tests/mcp/tools-preview.test.ts
git commit -m "feat(mcp): add preview_markdown and preview_segment_payload"
```

---

## Task 4: Add `lib/git-ops.ts`

**Files:**
- Create: `lib/git-ops.ts`
- Create: `tests/lib/git-ops.test.ts`
- Modify: `package.json` — add `@octokit/rest`.

**Interfaces:**
- Produces:
  - `getWorkingTreeStatus(repoPath: string): { clean: boolean; dirty_files: string[]; current_branch: string; }`
  - `assertCleanTree(repoPath: string): void` — throws `GitOpsError` with `code: "DIRTY_TREE"` if dirty.
  - `createBranch(repoPath: string, branchName: string): void` — `git fetch origin && git checkout -b <name> origin/main` if origin exists, else `git checkout -b <name>`.
  - `commitPaths(repoPath: string, paths: string[], message: string): string` — stages listed paths, commits with the message, returns the new commit SHA.
  - `pushBranch(repoPath: string, branchName: string): void`
  - `openPullRequest(repoPath: string, opts: { branch: string; title: string; body: string; base?: string; }): Promise<{ pr_url: string; pr_number: number }>` — tries `gh pr create`; on failure falls back to Octokit if `GITHUB_TOKEN` is present. Never invents a token.
  - `class GitOpsError extends Error { code: "DIRTY_TREE" | "GIT" | "GH_CLI" | "GITHUB_API"; details?: unknown; }`

- [ ] **Step 1: Install Octokit**

```bash
npm install @octokit/rest
```

- [ ] **Step 2: Write the failing tests**

Create `tests/lib/git-ops.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getWorkingTreeStatus,
  assertCleanTree,
  createBranch,
  commitPaths,
  GitOpsError,
} from "../../lib/git-ops.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tp-git-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: dir });
  writeFileSync(join(dir, "README.md"), "hello");
  execSync("git add . && git commit -qm 'init'", { cwd: dir });
  return dir;
}

describe("git-ops", () => {
  it("getWorkingTreeStatus returns clean=true and current branch after fresh commit", () => {
    const repo = initRepo();
    const s = getWorkingTreeStatus(repo);
    expect(s.clean).toBe(true);
    expect(s.dirty_files).toEqual([]);
    expect(s.current_branch).toBe("main");
  });

  it("getWorkingTreeStatus detects modified files", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "README.md"), "dirty");
    const s = getWorkingTreeStatus(repo);
    expect(s.clean).toBe(false);
    expect(s.dirty_files).toContain("README.md");
  });

  it("assertCleanTree throws DIRTY_TREE on dirty repo", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "README.md"), "dirty");
    expect(() => assertCleanTree(repo)).toThrow(GitOpsError);
    try {
      assertCleanTree(repo);
    } catch (e) {
      expect((e as GitOpsError).code).toBe("DIRTY_TREE");
    }
  });

  it("createBranch creates a new branch from HEAD when no origin", () => {
    const repo = initRepo();
    createBranch(repo, "feat/new-branch");
    const s = getWorkingTreeStatus(repo);
    expect(s.current_branch).toBe("feat/new-branch");
  });

  it("commitPaths stages and commits given files and returns SHA", () => {
    const repo = initRepo();
    createBranch(repo, "feat/edit");
    const filePath = join(repo, "hello.txt");
    writeFileSync(filePath, "world");
    const sha = commitPaths(repo, ["hello.txt"], "feat: add hello");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const log = execSync("git log --oneline -n 1", { cwd: repo, encoding: "utf8" });
    expect(log).toContain("feat: add hello");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `lib/git-ops.js` does not exist.

- [ ] **Step 4: Implement `lib/git-ops.ts`**

```ts
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
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS — 5 new + 61 prior = 66. `openPullRequest` is not covered by unit tests (it requires network / gh auth); it's exercised in Task 7's manual smoke test.

- [ ] **Step 6: Commit**

```bash
git add lib/git-ops.ts tests/lib/git-ops.test.ts package.json package-lock.json
git commit -m "feat(lib): add git-ops module for branch/commit/push/PR"
```

---

## Task 5: Extend `mcp/context.ts` for write modes and preflight

**Files:**
- Modify: `mcp/context.ts`
- Create: `tests/mcp/context.test.ts` (new file — M1's `tests/mcp/server.test.ts` covered basics; this adds write-mode tests).

**Interfaces:**
- Adds to `ServerContext`:
  - `defaultWriteMode: "files" | "branch" | "pr"`
  - `resolveWriteMode(argMode?: string): "files" | "branch" | "pr"` — tool arg > `MCP_WRITE_MODE` env > `"branch"` default.
  - `preflightWrite(mode: "files" | "branch" | "pr"): { blocked: false } | { blocked: true; error: ToolResultError }` — for `branch`/`pr` modes: checks working tree clean; for `files`, always allowed. Never mutates.

Where `ToolResultError` is the error object shape from `mcp/tools/result.ts` (extract as a named type in that file).

- [ ] **Step 1: Extract `ToolResultError` in `mcp/tools/result.ts`**

Modify `mcp/tools/result.ts`:

```ts
export interface ToolResultError {
  code:
    | "DIRTY_TREE"
    | "SEGMENT_API"
    | "GIT"
    | "VALIDATION"
    | "CONFIG"
    | "NOT_FOUND"
    | "PROD_WRITE_BLOCKED"
    | "GH_CLI"
    | "GITHUB_API"
    | "UNKNOWN";
  message: string;
  details?: unknown;
  remediation?: string;
}

export type ToolResult<T> =
  | { ok: true; data: T; warnings?: string[] }
  | { ok: false; error: ToolResultError };
```

Update `err(...)` return type to `ToolResult<never>` (already correct).

Also update the code union everywhere in the M1 code that references it (grep for `"UNKNOWN"` in the error union to verify).

- [ ] **Step 2: Write the failing tests**

Create `tests/mcp/context.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContext } from "../../mcp/context.js";

function makeRepo(dirty = false): string {
  const dir = mkdtempSync(join(tmpdir(), "tp-ctx-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: dir });
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    join(dir, "config", "tracking-plans-config.json"),
    JSON.stringify({
      plans: [
        { name: "JavaScript", path: "javascript", dev_secret: "DEV_JS", prod_secret: "PROD_JS" },
      ],
    }),
  );
  execSync("git add . && git commit -qm init", { cwd: dir });
  if (dirty) writeFileSync(join(dir, "config", "tracking-plans-config.json"), "{}");
  return dir;
}

describe("context write-mode", () => {
  it("defaultWriteMode is 'branch' when unset", () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    expect(ctx.defaultWriteMode).toBe("branch");
  });

  it("defaultWriteMode honors MCP_WRITE_MODE env", () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo(), MCP_WRITE_MODE: "files" });
    expect(ctx.defaultWriteMode).toBe("files");
  });

  it("resolveWriteMode: arg overrides env", () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo(), MCP_WRITE_MODE: "files" });
    expect(ctx.resolveWriteMode("pr")).toBe("pr");
  });

  it("resolveWriteMode: invalid arg falls back to default", () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    expect(ctx.resolveWriteMode("bogus")).toBe("branch");
  });

  it("preflightWrite: files mode always allowed", () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo(true) });
    const p = ctx.preflightWrite("files");
    expect(p.blocked).toBe(false);
  });

  it("preflightWrite: branch mode blocks on dirty tree", () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo(true) });
    const p = ctx.preflightWrite("branch");
    expect(p.blocked).toBe(true);
    if (!p.blocked) throw new Error();
    expect(p.error.code).toBe("DIRTY_TREE");
  });

  it("preflightWrite: branch mode allowed on clean tree", () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const p = ctx.preflightWrite("branch");
    expect(p.blocked).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — new methods don't exist.

- [ ] **Step 4: Update `mcp/context.ts`**

Add to imports:

```ts
import { getWorkingTreeStatus, assertCleanTree, GitOpsError } from "../lib/git-ops.js";
import type { ToolResultError } from "./tools/result.js";
```

Extend the `ServerContext` interface:

```ts
export type WriteMode = "files" | "branch" | "pr";

export interface ServerContext {
  repoPath: string;
  env: Record<string, string | undefined>;
  plans: PlanConfig[];
  segmentApiKey?: string;
  planIdEnv: (planPath: string, env: "dev" | "prod") => string | undefined;
  resolvePlanOrThrow: (nameOrPath: string) => PlanConfig;
  segmentClient: () => SegmentClient;
  defaultWriteMode: WriteMode;
  resolveWriteMode: (argMode?: string) => WriteMode;
  preflightWrite: (
    mode: WriteMode,
  ) => { blocked: false } | { blocked: true; error: ToolResultError };
}
```

Update `resolveContext` to add:

```ts
const WRITE_MODES: WriteMode[] = ["files", "branch", "pr"];

function parseMode(raw: string | undefined, fallback: WriteMode): WriteMode {
  if (raw && (WRITE_MODES as string[]).includes(raw)) return raw as WriteMode;
  return fallback;
}

const defaultWriteMode: WriteMode = parseMode(env.MCP_WRITE_MODE, "branch");

// ... inside the return object:
defaultWriteMode,
resolveWriteMode: (argMode) => parseMode(argMode, defaultWriteMode),
preflightWrite: (mode) => {
  if (mode === "files") return { blocked: false };
  try {
    assertCleanTree(repoPath);
    return { blocked: false };
  } catch (e) {
    if (e instanceof GitOpsError && e.code === "DIRTY_TREE") {
      return {
        blocked: true,
        error: {
          code: "DIRTY_TREE",
          message: e.message,
          details: e.details,
          remediation:
            "Stash or commit changes, or re-run with mode: 'files'.",
        },
      };
    }
    throw e;
  }
},
```

- [ ] **Step 5: Build and test**

Run: `npm run build && npm test`
Expected: PASS — 7 new + 66 prior = 73.

- [ ] **Step 6: Commit**

```bash
git add mcp/context.ts mcp/tools/result.ts tests/mcp/context.test.ts
git commit -m "feat(mcp): extend context with write-mode resolution and preflight"
```

---

## Task 6: Author tools — `add_event`, `update_event`, `remove_event` (files mode only)

**Files:**
- Create: `mcp/tools/author.ts`
- Modify: `mcp/tools/index.ts` — register three tools.
- Create: `tests/mcp/tools-author.test.ts`

**Interfaces:**
- Consumes: `writeYamlRuleFile`, `loadYamlRuleFile`, `YamlRule`, `YamlProperty` from `lib/yaml-transform.ts`; `readYamlRules` from `mcp/tools/validate.ts`; `ServerContext`.
- Produces:
  - `addEventInput`: `{ plan, key, type?, version?, description, properties, labels?, mode? }` — `type` defaults to `"TRACK"`, `version` defaults to `1`.
  - `updateEventInput`: `{ plan, key, changes: { description?, add_properties?, update_properties?, remove_properties?, labels? }, mode? }`.
  - `removeEventInput`: `{ plan, key, confirm: true, mode? }` — literal `true` required.
  - All return `ToolResult<{ files_changed: string[]; mode: "files" }>` in this task. Branch/PR modes land in Task 7.

Filename convention (matches existing): `<key>.yml` where spaces are replaced with `_`. E.g., `Product Viewed` → `Product_Viewed.yml`.

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp/tools-author.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { resolveContext } from "../../mcp/context.js";
import { addEvent, updateEvent, removeEvent } from "../../mcp/tools/author.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tp-auth-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: dir });
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    join(dir, "config", "tracking-plans-config.json"),
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
  execSync("git add . && git commit -qm init", { cwd: dir });
  return dir;
}

describe("author tools (files mode)", () => {
  it("addEvent writes a new YAML file", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await addEvent(ctx, {
      plan: "javascript",
      key: "Product Viewed",
      description: "Fired on view",
      properties: {
        product_id: { type: "string", description: "id", required: true },
      },
      mode: "files",
    });
    if (!res.ok) throw new Error();
    expect(res.data.files_changed).toEqual([
      "tracking-rules/javascript/Product_Viewed.yml",
    ]);
    const full = join(ctx.repoPath, res.data.files_changed[0]);
    const parsed = yaml.load(readFileSync(full, "utf8")) as any;
    expect(parsed.rules[0].key).toBe("Product Viewed");
    expect(parsed.rules[0].properties.product_id.required).toBe(true);
  });

  it("addEvent errors when the event already exists", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    await addEvent(ctx, {
      plan: "javascript",
      key: "Product Viewed",
      description: "d",
      properties: {},
      mode: "files",
    });
    const res = await addEvent(ctx, {
      plan: "javascript",
      key: "Product Viewed",
      description: "d",
      properties: {},
      mode: "files",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.error.code).toBe("VALIDATION");
  });

  it("updateEvent patches description and adds/removes/updates properties", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    await addEvent(ctx, {
      plan: "javascript",
      key: "Order Completed",
      description: "orig",
      properties: {
        order_id: { type: "string", description: "d", required: true },
        legacy: { type: "string", description: "old" },
      },
      mode: "files",
    });
    const res = await updateEvent(ctx, {
      plan: "javascript",
      key: "Order Completed",
      changes: {
        description: "updated",
        add_properties: { price: { type: "number", description: "p" } },
        update_properties: { order_id: { description: "the order id" } },
        remove_properties: ["legacy"],
      },
      mode: "files",
    });
    if (!res.ok) throw new Error();
    const parsed = yaml.load(
      readFileSync(
        join(ctx.repoPath, "tracking-rules/javascript/Order_Completed.yml"),
        "utf8",
      ),
    ) as any;
    expect(parsed.rules[0].description).toBe("updated");
    expect(parsed.rules[0].properties.price.type).toBe("number");
    expect(parsed.rules[0].properties.order_id.description).toBe("the order id");
    expect(parsed.rules[0].properties.legacy).toBeUndefined();
  });

  it("updateEvent NOT_FOUND when file missing", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await updateEvent(ctx, {
      plan: "javascript",
      key: "Missing",
      changes: { description: "x" },
      mode: "files",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.error.code).toBe("NOT_FOUND");
  });

  it("removeEvent deletes YAML file", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    await addEvent(ctx, {
      plan: "javascript",
      key: "Doomed",
      description: "d",
      properties: {},
      mode: "files",
    });
    const path = join(ctx.repoPath, "tracking-rules/javascript/Doomed.yml");
    expect(existsSync(path)).toBe(true);
    const res = await removeEvent(ctx, {
      plan: "javascript",
      key: "Doomed",
      confirm: true,
      mode: "files",
    });
    if (!res.ok) throw new Error();
    expect(existsSync(path)).toBe(false);
  });

  it("removeEvent refuses without confirm:true", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    await addEvent(ctx, {
      plan: "javascript",
      key: "Doomed",
      description: "d",
      properties: {},
      mode: "files",
    });
    const res = await removeEvent(ctx, {
      plan: "javascript",
      key: "Doomed",
      confirm: false as any,
      mode: "files",
    });
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `mcp/tools/author.ts`**

```ts
import { z } from "zod";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ServerContext } from "../context.js";
import { err, ok, ToolResult } from "./result.js";
import {
  loadYamlRuleFile,
  writeYamlRuleFile,
  type YamlRule,
  type YamlProperty,
} from "../../lib/yaml-transform.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";

const yamlPropertySchema: z.ZodType<YamlProperty> = z
  .object({
    type: z.string().optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
  })
  .catchall(z.unknown());

export const addEventInput = z
  .object({
    plan: z.string(),
    key: z.string(),
    type: z.string().optional(),
    version: z.number().int().positive().optional(),
    description: z.string(),
    properties: z.record(yamlPropertySchema),
    labels: z.record(z.string()).optional(),
    mode: z.enum(["files", "branch", "pr"]).optional(),
  })
  .strict();

export const updateEventInput = z
  .object({
    plan: z.string(),
    key: z.string(),
    changes: z
      .object({
        description: z.string().optional(),
        add_properties: z.record(yamlPropertySchema).optional(),
        update_properties: z.record(yamlPropertySchema).optional(),
        remove_properties: z.array(z.string()).optional(),
        labels: z.record(z.string()).optional(),
      })
      .strict(),
    mode: z.enum(["files", "branch", "pr"]).optional(),
  })
  .strict();

export const removeEventInput = z
  .object({
    plan: z.string(),
    key: z.string(),
    confirm: z.literal(true),
    mode: z.enum(["files", "branch", "pr"]).optional(),
  })
  .strict();

function planYamlPath(repoPath: string, planPath: string, key: string): string {
  const fileName = `${key.replace(/ /g, "_")}.yml`;
  return join(repoPath, "tracking-rules", planPath, fileName);
}

interface WriteOutput {
  files_changed: string[];
  mode: "files";
}

export async function addEvent(
  ctx: ServerContext,
  args: z.infer<typeof addEventInput>,
): Promise<ToolResult<WriteOutput>> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const mode = ctx.resolveWriteMode(args.mode);
  if (mode !== "files") {
    return err(
      "VALIDATION",
      "This task only supports mode: 'files'. Branch/PR modes land in Task 7.",
    );
  }
  const filePath = planYamlPath(ctx.repoPath, plan.path, args.key);
  if (existsSync(filePath)) {
    return err(
      "VALIDATION",
      `Event "${args.key}" already exists at ${filePath}. Use update_event to modify.`,
    );
  }
  const yamlRule: YamlRule = {
    key: args.key,
    type: args.type ?? "TRACK",
    version: args.version ?? 1,
    description: args.description,
    properties: args.properties,
  };
  if (args.labels) yamlRule.labels = args.labels;
  writeYamlRuleFile(filePath, yamlRule);
  return ok({
    files_changed: [`tracking-rules/${plan.path}/${args.key.replace(/ /g, "_")}.yml`],
    mode: "files",
  });
}

export async function updateEvent(
  ctx: ServerContext,
  args: z.infer<typeof updateEventInput>,
): Promise<ToolResult<WriteOutput>> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const mode = ctx.resolveWriteMode(args.mode);
  if (mode !== "files") {
    return err(
      "VALIDATION",
      "This task only supports mode: 'files'. Branch/PR modes land in Task 7.",
    );
  }
  const filePath = planYamlPath(ctx.repoPath, plan.path, args.key);
  if (!existsSync(filePath)) {
    return err("NOT_FOUND", `Event "${args.key}" has no yaml file at ${filePath}.`);
  }
  const current = loadYamlRuleFile(filePath);
  if (args.changes.description !== undefined) current.description = args.changes.description;
  if (args.changes.labels !== undefined) current.labels = args.changes.labels;
  if (args.changes.add_properties) {
    for (const [name, prop] of Object.entries(args.changes.add_properties)) {
      if (current.properties[name]) {
        return err(
          "VALIDATION",
          `Property "${name}" already exists on "${args.key}"; use update_properties instead.`,
        );
      }
      current.properties[name] = prop;
    }
  }
  if (args.changes.update_properties) {
    for (const [name, patch] of Object.entries(args.changes.update_properties)) {
      if (!current.properties[name]) {
        return err(
          "NOT_FOUND",
          `Property "${name}" not found on "${args.key}"; use add_properties.`,
        );
      }
      current.properties[name] = { ...current.properties[name], ...patch };
    }
  }
  if (args.changes.remove_properties) {
    for (const name of args.changes.remove_properties) {
      delete current.properties[name];
    }
  }
  writeYamlRuleFile(filePath, current);
  return ok({
    files_changed: [`tracking-rules/${plan.path}/${args.key.replace(/ /g, "_")}.yml`],
    mode: "files",
  });
}

export async function removeEvent(
  ctx: ServerContext,
  args: z.infer<typeof removeEventInput>,
): Promise<ToolResult<WriteOutput & { removed_yaml: YamlRule }>> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const mode = ctx.resolveWriteMode(args.mode);
  if (mode !== "files") {
    return err(
      "VALIDATION",
      "This task only supports mode: 'files'. Branch/PR modes land in Task 7.",
    );
  }
  const filePath = planYamlPath(ctx.repoPath, plan.path, args.key);
  if (!existsSync(filePath)) {
    return err("NOT_FOUND", `Event "${args.key}" has no yaml file at ${filePath}.`);
  }
  const removed = loadYamlRuleFile(filePath);
  unlinkSync(filePath);
  return ok({
    files_changed: [`tracking-rules/${plan.path}/${args.key.replace(/ /g, "_")}.yml`],
    mode: "files",
    removed_yaml: removed,
  });
}
```

- [ ] **Step 4: Register in `mcp/tools/index.ts`**

Add imports:

```ts
import {
  addEvent,
  addEventInput,
  updateEvent,
  updateEventInput,
  removeEvent,
  removeEventInput,
} from "./author.js";
```

Add to the tools array:

```ts
makeTool(
  "add_event",
  "Create a new event YAML file. Modes: files (default in this task) | branch | pr.",
  addEventInput,
  addEvent,
),
makeTool(
  "update_event",
  "Modify an existing event's description, labels, or properties.",
  updateEventInput,
  updateEvent,
),
makeTool(
  "remove_event",
  "Delete an event's YAML file. Requires confirm: true; returns the removed yaml for undo.",
  removeEventInput,
  removeEvent,
),
```

- [ ] **Step 5: Build and test**

Run: `npm run build && npm test`
Expected: PASS — 6 new + 73 prior = 79.

- [ ] **Step 6: Commit**

```bash
git add mcp/tools/author.ts mcp/tools/index.ts tests/mcp/tools-author.test.ts
git commit -m "feat(mcp): add add_event, update_event, remove_event (files mode)"
```

---

## Task 7: Extend author tools with `branch` and `pr` modes

**Files:**
- Modify: `mcp/tools/author.ts` — factor a shared write-flow helper and use it in all three author tools.
- Modify: `tests/mcp/tools-author.test.ts` — add branch/pr coverage.

**Interfaces:**
- Adds a helper in `mcp/tools/author.ts` (kept internal, not exported):
  - `applyWriteFlow(ctx, plan, mode, mutator, commitMessage): Promise<ToolResult<WriteOutput>>` where `mutator: () => { files_changed: string[]; extras?: object }`.
- Extends `WriteOutput` type to:
  ```ts
  type WriteOutput = {
    files_changed: string[];
    mode: WriteMode;
    branch?: string;
    commit_sha?: string;
    pr_url?: string;
    pr_number?: number;
    next_steps?: string;
  };
  ```

Flow per mode:

- **`files`**: Run mutator. Return `{ files_changed, mode: "files" }`.
- **`branch`**: preflight (checks clean tree). Create branch `tp/<plan>/<slug>-<timestamp>`. Run mutator. Commit files with generated message. Return `{ files_changed, mode, branch, commit_sha, next_steps: "git push -u origin <branch> && open PR" }`.
- **`pr`**: same as `branch`, then push + open PR. Return with `pr_url`, `pr_number`.

Timestamp for branch name: since M1 forbade `Date.now()` in workflow scripts, but that constraint was scoped to `Workflow`; regular tests and MCP tools may use it. Use `Date.now()` for the timestamp, but let the branch-name function accept an override for testability.

- [ ] **Step 1: Refactor `mcp/tools/author.ts` to route through a write-flow helper**

Add near the top of the file:

```ts
import type { WriteMode } from "../context.js";
import {
  createBranch,
  commitPaths,
  pushBranch,
  openPullRequest,
  GitOpsError,
} from "../../lib/git-ops.js";

interface WriteOutput {
  files_changed: string[];
  mode: WriteMode;
  branch?: string;
  commit_sha?: string;
  pr_url?: string;
  pr_number?: number;
  next_steps?: string;
  [k: string]: unknown;
}

interface MutatorResult {
  files_changed: string[];
  extras?: Record<string, unknown>;
}

function slugify(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function branchName(planPath: string, key: string, verb: string, now: number): string {
  return `tp/${planPath}/${verb}-${slugify(key)}-${now}`;
}

async function applyWriteFlow(
  ctx: ServerContext,
  planPath: string,
  planName: string,
  key: string,
  verb: "add" | "update" | "remove",
  mode: WriteMode,
  mutator: () => MutatorResult,
  now: number = Date.now(),
): Promise<ToolResult<WriteOutput>> {
  const pre = ctx.preflightWrite(mode);
  if (pre.blocked) return { ok: false, error: pre.error };

  if (mode === "files") {
    const { files_changed, extras } = mutator();
    return ok({ files_changed, mode, ...(extras ?? {}) });
  }

  const branch = branchName(planPath, key, verb, now);
  try {
    createBranch(ctx.repoPath, branch);
    const { files_changed, extras } = mutator();
    const commitMessage =
      `[tp:${planPath}] ${verb} event "${key}"\n\n` +
      `- Generated via tracking-plans-mcp`;
    const commit_sha = commitPaths(ctx.repoPath, files_changed, commitMessage);

    if (mode === "branch") {
      return ok({
        files_changed,
        mode,
        branch,
        commit_sha,
        next_steps: `git push -u origin ${branch} && open PR`,
        ...(extras ?? {}),
      });
    }

    // pr mode
    pushBranch(ctx.repoPath, branch);
    const pr = await openPullRequest(ctx.repoPath, {
      branch,
      title: `[tp:${planPath}] ${verb} event "${key}"`,
      body: `Generated by tracking-plans-mcp.\n\nFiles changed:\n${files_changed
        .map((f) => `- \`${f}\``)
        .join("\n")}`,
    });
    return ok({
      files_changed,
      mode,
      branch,
      commit_sha,
      pr_url: pr.pr_url,
      pr_number: pr.pr_number,
      ...(extras ?? {}),
    });
  } catch (e) {
    if (e instanceof GitOpsError) {
      return err(e.code, e.message, { details: e.details });
    }
    throw e;
  }
}
```

- [ ] **Step 2: Route each of the three author tools through `applyWriteFlow`**

Replace the body of `addEvent`, `updateEvent`, `removeEvent` — after the plan-resolve check — so each computes its `filePath`, defines a `mutator` closure that performs the mutation and returns `{ files_changed, extras? }`, then calls `applyWriteFlow(...)`.

Example new `addEvent` body (replaces the file-write block):

```ts
const mode = ctx.resolveWriteMode(args.mode);
const filePath = planYamlPath(ctx.repoPath, plan.path, args.key);
const relPath = `tracking-rules/${plan.path}/${args.key.replace(/ /g, "_")}.yml`;
if (existsSync(filePath)) {
  return err(
    "VALIDATION",
    `Event "${args.key}" already exists at ${filePath}. Use update_event to modify.`,
  );
}
return applyWriteFlow(ctx, plan.path, plan.name, args.key, "add", mode, () => {
  const yamlRule: YamlRule = {
    key: args.key,
    type: args.type ?? "TRACK",
    version: args.version ?? 1,
    description: args.description,
    properties: args.properties,
  };
  if (args.labels) yamlRule.labels = args.labels;
  writeYamlRuleFile(filePath, yamlRule);
  return { files_changed: [relPath] };
});
```

Do the analogous refactor for `updateEvent` and `removeEvent`. `removeEvent`'s mutator must capture `removed` before deletion and return it via `extras: { removed_yaml: removed }`.

Remove the previous "This task only supports mode: 'files'" checks.

- [ ] **Step 3: Add branch-mode tests**

Append to `tests/mcp/tools-author.test.ts`:

```ts
import { existsSync, readFileSync as fsRead } from "node:fs";

describe("author tools (branch mode)", () => {
  it("addEvent creates branch and commits when mode=branch", async () => {
    const repo = makeRepo();
    // Point origin at repo itself for createBranch's fetch to succeed (or skip): use no origin.
    const ctx = resolveContext({ REPO_PATH: repo });
    const res = await addEvent(ctx, {
      plan: "javascript",
      key: "Product Viewed",
      description: "d",
      properties: {},
      mode: "branch",
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.data.mode).toBe("branch");
    expect(res.data.branch).toMatch(/^tp\/javascript\/add-product-viewed-\d+$/);
    expect(res.data.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    const log = execSync("git log --oneline -n 1", { cwd: repo, encoding: "utf8" });
    expect(log).toContain(`add event "Product Viewed"`);
  });

  it("branch mode refuses when working tree is dirty", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "config", "tracking-plans-config.json"), "{}"); // dirty
    const ctx = resolveContext({ REPO_PATH: repo });
    const res = await addEvent(ctx, {
      plan: "javascript",
      key: "x",
      description: "d",
      properties: {},
      mode: "branch",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.error.code).toBe("DIRTY_TREE");
  });
});
```

- [ ] **Step 4: Build and test**

Run: `npm run build && npm test`
Expected: PASS — 2 new + 79 prior = 81. `pr` mode is not unit-tested (requires network / gh auth); it's exercised in the smoke test in Task 9.

- [ ] **Step 5: Commit**

```bash
git add mcp/tools/author.ts tests/mcp/tools-author.test.ts
git commit -m "feat(mcp): route author tools through branch and pr write modes"
```

---

## Task 8: Bulk tools — `bulk_rename_property`, `bulk_add_property`

**Files:**
- Create: `mcp/tools/bulk.ts`
- Modify: `mcp/tools/index.ts` — register two tools.
- Create: `tests/mcp/tools-bulk.test.ts`

**Interfaces:**
- Consumes: `readYamlRules`, write flow helper (export `applyWriteFlow` from `mcp/tools/author.ts`).
- Produces:
  - `bulkRenamePropertyInput`: `{ plan, from: string, to: string, dry_run?: boolean, mode? }` — default `dry_run: true`.
  - `bulkAddPropertyInput`: `{ plan, property_name: string, property: YamlProperty, filter?: string, dry_run?: boolean, mode? }` — `filter` is a regex on event key.
  - Return shape: `ToolResult<{ files_changed: string[]; affected_events: string[]; dry_run: boolean; mode: WriteMode; branch?; commit_sha?; pr_url?; pr_number?; next_steps? }>`.

When `dry_run: true`, the tool computes `affected_events` and `files_changed` but does NOT write. `mode` is ignored in dry runs.

- [ ] **Step 1: Export `applyWriteFlow` from author.ts**

Modify `mcp/tools/author.ts`: change `async function applyWriteFlow(...)` to `export async function applyWriteFlow(...)`.

- [ ] **Step 2: Write the failing tests**

Create `tests/mcp/tools-bulk.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { resolveContext } from "../../mcp/context.js";
import { addEvent } from "../../mcp/tools/author.js";
import { bulkRenameProperty, bulkAddProperty } from "../../mcp/tools/bulk.js";

async function seed(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "tp-bulk-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: dir });
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    join(dir, "config", "tracking-plans-config.json"),
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
  execSync("git add . && git commit -qm init", { cwd: dir });
  const ctx = resolveContext({ REPO_PATH: dir });
  await addEvent(ctx, {
    plan: "javascript",
    key: "Product Viewed",
    description: "d",
    properties: {
      userId: { type: "string", description: "u" },
      product_id: { type: "string", description: "p" },
    },
    mode: "files",
  });
  await addEvent(ctx, {
    plan: "javascript",
    key: "Order Completed",
    description: "d",
    properties: { userId: { type: "string", description: "u" } },
    mode: "files",
  });
  execSync("git add . && git commit -qm seed", { cwd: dir });
  return dir;
}

describe("bulk tools", () => {
  it("bulkRenameProperty dry_run reports affected events without changing files", async () => {
    const repo = await seed();
    const ctx = resolveContext({ REPO_PATH: repo });
    const res = await bulkRenameProperty(ctx, {
      plan: "javascript",
      from: "userId",
      to: "user_id",
      dry_run: true,
    });
    if (!res.ok) throw new Error();
    expect(res.data.affected_events.sort()).toEqual([
      "Order Completed",
      "Product Viewed",
    ]);
    expect(res.data.dry_run).toBe(true);
    // No file mutations
    const raw = readFileSync(
      join(repo, "tracking-rules/javascript/Product_Viewed.yml"),
      "utf8",
    );
    expect(raw).toContain("userId");
  });

  it("bulkRenameProperty dry_run:false applies renames in files mode", async () => {
    const repo = await seed();
    const ctx = resolveContext({ REPO_PATH: repo });
    const res = await bulkRenameProperty(ctx, {
      plan: "javascript",
      from: "userId",
      to: "user_id",
      dry_run: false,
      mode: "files",
    });
    if (!res.ok) throw new Error();
    const parsed = yaml.load(
      readFileSync(
        join(repo, "tracking-rules/javascript/Product_Viewed.yml"),
        "utf8",
      ),
    ) as any;
    expect(parsed.rules[0].properties.user_id).toBeDefined();
    expect(parsed.rules[0].properties.userId).toBeUndefined();
  });

  it("bulkAddProperty respects filter regex", async () => {
    const repo = await seed();
    const ctx = resolveContext({ REPO_PATH: repo });
    const res = await bulkAddProperty(ctx, {
      plan: "javascript",
      property_name: "platform",
      property: { type: "string", description: "web/ios/android" },
      filter: "^Order",
      dry_run: false,
      mode: "files",
    });
    if (!res.ok) throw new Error();
    expect(res.data.affected_events).toEqual(["Order Completed"]);
    const parsed = yaml.load(
      readFileSync(
        join(repo, "tracking-rules/javascript/Order_Completed.yml"),
        "utf8",
      ),
    ) as any;
    expect(parsed.rules[0].properties.platform.type).toBe("string");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `mcp/tools/bulk.ts`**

```ts
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerContext } from "../context.js";
import { err, ok, ToolResult } from "./result.js";
import {
  loadYamlRuleFile,
  writeYamlRuleFile,
  type YamlProperty,
} from "../../lib/yaml-transform.js";
import { readYamlRules } from "./validate.js";
import { applyWriteFlow } from "./author.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";

const yamlPropertySchema: z.ZodType<YamlProperty> = z
  .object({
    type: z.string().optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
  })
  .catchall(z.unknown());

export const bulkRenamePropertyInput = z
  .object({
    plan: z.string(),
    from: z.string(),
    to: z.string(),
    dry_run: z.boolean().optional(),
    mode: z.enum(["files", "branch", "pr"]).optional(),
  })
  .strict();

export const bulkAddPropertyInput = z
  .object({
    plan: z.string(),
    property_name: z.string(),
    property: yamlPropertySchema,
    filter: z.string().optional(),
    dry_run: z.boolean().optional(),
    mode: z.enum(["files", "branch", "pr"]).optional(),
  })
  .strict();

function planFilePath(repoPath: string, planPath: string, key: string): string {
  return join(repoPath, "tracking-rules", planPath, `${key.replace(/ /g, "_")}.yml`);
}

export async function bulkRenameProperty(
  ctx: ServerContext,
  args: z.infer<typeof bulkRenamePropertyInput>,
): Promise<
  ToolResult<{
    files_changed: string[];
    affected_events: string[];
    dry_run: boolean;
    mode: string;
    [k: string]: unknown;
  }>
> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const rules = readYamlRules(ctx.repoPath, plan.path);
  const affected = rules.filter((r) => r.properties && args.from in r.properties);
  const relPaths = affected.map(
    (r) => `tracking-rules/${plan.path}/${r.key.replace(/ /g, "_")}.yml`,
  );
  const affected_events = affected.map((r) => r.key);
  const dry_run = args.dry_run ?? true;
  if (dry_run) {
    return ok({
      files_changed: relPaths,
      affected_events,
      dry_run: true,
      mode: ctx.resolveWriteMode(args.mode),
    });
  }
  const mode = ctx.resolveWriteMode(args.mode);
  const first = affected[0];
  const key = first?.key ?? args.from;
  const result = await applyWriteFlow(
    ctx,
    plan.path,
    plan.name,
    `rename ${args.from} → ${args.to}`,
    "update",
    mode,
    () => {
      for (const rule of affected) {
        const filePath = planFilePath(ctx.repoPath, plan.path, rule.key);
        const current = loadYamlRuleFile(filePath);
        const val = current.properties[args.from];
        delete current.properties[args.from];
        current.properties[args.to] = val;
        writeYamlRuleFile(filePath, current);
      }
      return { files_changed: relPaths };
    },
  );
  if (!result.ok) return result;
  return ok({ ...result.data, affected_events, dry_run: false });
}

export async function bulkAddProperty(
  ctx: ServerContext,
  args: z.infer<typeof bulkAddPropertyInput>,
): Promise<
  ToolResult<{
    files_changed: string[];
    affected_events: string[];
    dry_run: boolean;
    mode: string;
    [k: string]: unknown;
  }>
> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  let filterRegex: RegExp | null = null;
  if (args.filter) {
    try {
      filterRegex = new RegExp(args.filter);
    } catch (e) {
      return err("VALIDATION", `Invalid regex in 'filter': ${(e as Error).message}`);
    }
  }
  const rules = readYamlRules(ctx.repoPath, plan.path);
  const affected = rules.filter(
    (r) =>
      (!filterRegex || filterRegex.test(r.key)) &&
      !(args.property_name in (r.properties ?? {})),
  );
  const relPaths = affected.map(
    (r) => `tracking-rules/${plan.path}/${r.key.replace(/ /g, "_")}.yml`,
  );
  const affected_events = affected.map((r) => r.key);
  const dry_run = args.dry_run ?? true;
  if (dry_run) {
    return ok({
      files_changed: relPaths,
      affected_events,
      dry_run: true,
      mode: ctx.resolveWriteMode(args.mode),
    });
  }
  const mode = ctx.resolveWriteMode(args.mode);
  const result = await applyWriteFlow(
    ctx,
    plan.path,
    plan.name,
    `add ${args.property_name}`,
    "update",
    mode,
    () => {
      for (const rule of affected) {
        const filePath = planFilePath(ctx.repoPath, plan.path, rule.key);
        const current = loadYamlRuleFile(filePath);
        current.properties[args.property_name] = args.property;
        writeYamlRuleFile(filePath, current);
      }
      return { files_changed: relPaths };
    },
  );
  if (!result.ok) return result;
  return ok({ ...result.data, affected_events, dry_run: false });
}
```

- [ ] **Step 5: Register in `mcp/tools/index.ts`**

Add imports:

```ts
import {
  bulkRenameProperty,
  bulkRenamePropertyInput,
  bulkAddProperty,
  bulkAddPropertyInput,
} from "./bulk.js";
```

Add to the tools array:

```ts
makeTool(
  "bulk_rename_property",
  "Rename a property across every event in a plan. Default dry_run: true — must explicitly set false to execute.",
  bulkRenamePropertyInput,
  bulkRenameProperty,
),
makeTool(
  "bulk_add_property",
  "Add a property to every event matching an optional filter. Default dry_run: true.",
  bulkAddPropertyInput,
  bulkAddProperty,
),
```

- [ ] **Step 6: Build and test**

Run: `npm run build && npm test`
Expected: PASS — 3 new + 81 prior = 84.

- [ ] **Step 7: Commit**

```bash
git add mcp/tools/bulk.ts mcp/tools/author.ts mcp/tools/index.ts tests/mcp/tools-bulk.test.ts
git commit -m "feat(mcp): add bulk_rename_property and bulk_add_property"
```

---

## Task 9: M2 smoke test, README update, prod-write safety audit

**Files:**
- Create: `docs/mcp-smoke-test-m2.md`
- Modify: `README.md` — expand MCP section with M2 tools and write-mode config.
- Create: `docs/mcp-prod-write-audit.md` — a short static audit demonstrating M2 tools cannot write to Segment prod.

- [ ] **Step 1: Static audit — verify no tool code path can PATCH prod Segment**

Run a quick static check and record it in `docs/mcp-prod-write-audit.md`:

```bash
grep -rn "patchRules\|deleteRules" mcp/
grep -rn "prod" mcp/tools/
```

Expected: `patchRules`/`deleteRules` should appear ZERO times in `mcp/`. Prod references should only appear in read-only tools (`list_events`, `get_event`, `diff_plans`, `find_property_usage`, `list_recent_changes`, `validate_*`, `preview_*` — all read-only against `plans/prod/`).

Write the audit doc:

```markdown
# MCP Prod-Write Safety Audit (M2)

**Date:** 2026-08-XX (fill in)

## Method

Static grep of `mcp/` for any Segment mutation call (`patchRules`, `deleteRules`).

## Findings

- `grep -rn "patchRules\|deleteRules" mcp/` → no matches. Confirmed.
- Prod references in `mcp/tools/*` are exclusively for READING `plans/prod/<plan>/current-rules*.json`. No prod code path calls `ctx.segmentClient()`.

## Conclusion

M2 tools cannot mutate the Segment prod tracking plan. Prod-side writes still flow through merge-to-main → `.github/workflows/update-prod-tracking-plans.yml` → `scripts/update-tracking-plan.js`.
```

- [ ] **Step 2: Create `docs/mcp-smoke-test-m2.md`**

```markdown
# Tracking Plans MCP — M2 Manual Smoke Test

## Prerequisites

- M1 smoke test passing (`docs/mcp-smoke-test.md`).
- `gh` CLI installed and authenticated (`gh auth status`) — needed for `pr` mode.

## Steps

### 1. Rebuild

```bash
npm ci && npm run build
```

### 2. Verify M2 tools appear

Ask Claude: "List every tool the tracking-plans MCP exposes."
Expected: 6 read tools + `validate_event` + `validate_plan` + `lint_rules` + `preview_markdown` + `preview_segment_payload` + `add_event` + `update_event` + `remove_event` + `bulk_rename_property` + `bulk_add_property` = 16 tools total.

### 3. Validate + preview

- "Lint the JavaScript prod plan."
- "Preview the markdown that would land in docs/JavaScript.md based on my current YAML."
- "Show me the Segment payload for the 'Product Viewed' event in the JS plan."

### 4. Author (files mode) — sandbox

On a throwaway branch:

- "Add a `Test Event` to the JavaScript plan with properties `test_id` (string, required). Use mode: files."
- Verify a new file appeared at `tracking-rules/javascript/Test_Event.yml`.
- "Delete the `Test Event` from the JavaScript plan."

### 5. Author (branch mode)

- Ensure your working tree is clean.
- "Add a `Sample Event` to the JavaScript plan (default mode)."
- Verify: MCP created branch `tp/javascript/add-sample-event-<timestamp>` with one commit, and your working tree is now on that branch.
- Verify `git log --oneline -n 1` shows the generated commit message.
- Delete the branch: `git checkout main && git branch -D tp/javascript/add-sample-event-<timestamp>`.

### 6. Author (pr mode)

- "Add a `PR Test Event` with mode: pr."
- Verify a PR is opened on GitHub. Close and delete.

### 7. Dirty-tree refusal

- Make an uncommitted change (e.g., `echo x >> README.md`).
- Ask Claude to add a new event (default mode: branch).
- Expected: `DIRTY_TREE` error, remediation includes the list of dirty files.

### 8. Bulk operations

- "Show me a dry-run of renaming `userId` to `user_id` across the JavaScript plan."
- Verify no files change.
- "Now execute that rename."
- Verify commit is created on a new branch.
```

- [ ] **Step 3: Update README**

Append to the MCP section in README:

```markdown

### Available tools (M2)

**Validate:**
- `validate_event` — check one event's schema, types, required fields
- `validate_plan` — validate every event in a plan snapshot
- `lint_rules` — deep lint including orphan events (yaml ↔ snapshot)

**Preview:**
- `preview_markdown` — render docs/<plan>.md from local YAML, with diff vs committed
- `preview_segment_payload` — see the exact JSON that would PATCH to Segment

**Author (write modes: files | branch | pr; default branch):**
- `add_event` — create a new event YAML
- `update_event` — patch description, labels, or properties
- `remove_event` — delete an event (requires confirm: true)
- `bulk_rename_property` — rename a property across every event (default dry_run: true)
- `bulk_add_property` — add a property to every event matching a filter

### Configuring write mode

Add `MCP_WRITE_MODE` to the `env` block in your Claude Desktop config:

- `"files"` — MCP edits YAML in your working tree; you commit and push.
- `"branch"` — MCP creates a branch, commits, leaves you there (default).
- `"pr"` — MCP creates a branch, pushes, opens a GitHub PR via `gh` CLI (or `GITHUB_TOKEN`).

Prod tracking plans are still updated ONLY by merging to `main` — no MCP tool can bypass this.
```

- [ ] **Step 4: Commit**

```bash
git add docs/mcp-smoke-test-m2.md docs/mcp-prod-write-audit.md README.md
git commit -m "docs: M2 smoke test, prod-write audit, README update"
```

- [ ] **Step 5: Execute the manual smoke test**

Follow every step in `docs/mcp-smoke-test-m2.md`. If any step fails, do not mark M2 complete — file a note in the ledger and fix.

---

## Self-review

- Spec coverage: M2 delivers every remaining Milestone-2 tool from the spec (`validate_*`, `preview_*`, `add_event`, `update_event`, `remove_event`, `bulk_*`) plus the three write modes with the DIRTY_TREE guardrail, plus the PROD_WRITE_BLOCKED invariant (no path can mutate prod Segment).
- No placeholders: every step has code or a concrete command; the `pr` mode requires network so it's covered manually in Task 9 — that's called out, not hidden.
- Type consistency: `WriteMode`, `WriteOutput`, `ToolResultError` used consistently across new files. `Finding` shared between `lib/validate.ts` and MCP validate tools.
- Frequent commits: 9 tasks, 9+ commits.
- Every task ends with a green test run (or, for Task 9, a green manual smoke).
- Prod-write invariant: preserved. `mcp/tools/*` does not import `patchRules` or `deleteRules` anywhere in M2.
