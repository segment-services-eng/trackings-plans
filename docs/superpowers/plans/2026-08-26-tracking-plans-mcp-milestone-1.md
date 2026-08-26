# Tracking Plans MCP — Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a reusable `lib/` layer from the existing tracking-plans scripts, then scaffold a local stdio MCP server that exposes read-only tools (list/get/diff plans and events). At the end of M1, existing GitHub Actions still work unchanged, and a user can wire the MCP into Claude Desktop and query their tracking plans in natural language.

**Architecture:** TypeScript, Node 20+. Pure functions in `lib/` (no `process.env` access); both existing scripts and MCP tools call `lib/`. MCP server built on `@modelcontextprotocol/sdk`, distributed later as `@your-org/tracking-plans-mcp`. Vitest for tests, msw for HTTP mocking.

**Tech Stack:** TypeScript 5.x, Node 20+, `@modelcontextprotocol/sdk`, `axios` (already used), `js-yaml` (already used), `zod` (new — tool input schemas), Vitest, msw.

## Global Constraints

- Node 20+ (matches CI runner).
- All existing GitHub Actions workflows must keep passing after every task in this plan. Scripts keep their filenames and env-var contracts (`PLAN_DIR`, `SEGMENT_TRACKING_PLAN_ID`, `SEGMENT_API_KEY`, `SEGMENT_WORKSPACE`).
- `lib/*` modules must have zero `process.env` access and zero direct filesystem writes at import time — all I/O behind exported functions taking explicit args.
- No new secrets or config keys in M1. Reuse existing ones.
- Every task ends with a green test run and a commit.
- MCP tools in M1 are read-only. No writes to the Segment API. No writes to `tracking-rules/`, `plans/`, or `docs/`.

---

## File Structure Overview

```
tracking-plans/
├── lib/
│   ├── plans-config.ts        # Task 2
│   ├── segment-api.ts         # Task 3
│   ├── yaml-transform.ts      # Task 4
│   ├── render-markdown.ts     # Task 5
│   └── plan-snapshot.ts       # Task 6 — reads plans/<env>/<name>/current-rules*.json
├── mcp/
│   ├── server.ts              # Task 8
│   ├── context.ts             # Task 8
│   └── tools/
│       ├── read.ts            # Tasks 9, 10
│       └── index.ts           # Task 8 — registers tools with the server
├── scripts/                   # Refactored in Task 7 to thin wrappers over lib/
├── tests/
│   ├── lib/*.test.ts
│   └── mcp/*.test.ts
├── tsconfig.json              # Task 1
├── vitest.config.ts           # Task 1
└── package.json               # Task 1
```

---

## Task 1: Set up TypeScript + Vitest tooling

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore` entries for `dist/`, `node_modules/`, `coverage/`
- Create: `lib/.gitkeep`, `mcp/.gitkeep`, `tests/.gitkeep`

**Interfaces:**
- Produces: `npm run build`, `npm test`, `npm run typecheck` commands usable by later tasks.

- [ ] **Step 1: Add TypeScript, Vitest, msw, MCP SDK, zod, and types to package.json**

Modify `package.json`:

```json
{
  "name": "trackings-plans",
  "version": "1.0.0",
  "description": "",
  "main": "index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "mcp": "node dist/mcp/server.js"
  },
  "author": "",
  "license": "ISC",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "axios": "^0.21.1",
    "js-yaml": "^4.1.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.11.0",
    "msw": "^2.4.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": false,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["lib/**/*.ts", "mcp/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});
```

- [ ] **Step 4: Update `.gitignore`**

Append to `.gitignore` (create if missing):

```
node_modules/
dist/
coverage/
.env
.env.local
```

- [ ] **Step 5: Create empty directories and install**

```bash
mkdir -p lib mcp/tools tests/lib tests/mcp
touch lib/.gitkeep mcp/.gitkeep mcp/tools/.gitkeep tests/lib/.gitkeep tests/mcp/.gitkeep
npm install
```

- [ ] **Step 6: Verify tooling works**

Run: `npm run typecheck`
Expected: exits 0 with no output (no TS files yet).

Run: `npm test`
Expected: Vitest reports "No test files found" and exits 0 (or reports 0 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore lib mcp tests
git commit -m "chore: add TypeScript, Vitest, and MCP SDK tooling"
```

---

## Task 2: Extract `lib/plans-config.ts`

**Files:**
- Create: `lib/plans-config.ts`
- Create: `tests/lib/plans-config.test.ts`
- Reference: `config/tracking-plans-config.json` (unchanged)

**Interfaces:**
- Produces:
  - `type PlanConfig = { name: string; path: string; dev_secret: string; prod_secret: string; }`
  - `loadPlansConfig(repoPath: string): PlanConfig[]`
  - `resolvePlan(plans: PlanConfig[], nameOrPath: string): PlanConfig` — throws `Error` with `code: "NOT_FOUND"` if no match. Matches case-insensitively against `name` or `path`.
  - `getPlanIdEnvVar(plan: PlanConfig, env: "dev" | "prod"): string` — returns `plan.dev_secret` or `plan.prod_secret`.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/plans-config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPlansConfig,
  resolvePlan,
  getPlanIdEnvVar,
} from "../../lib/plans-config.js";

function makeRepo(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "tp-test-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    join(dir, "config", "tracking-plans-config.json"),
    JSON.stringify(config),
  );
  return dir;
}

describe("plans-config", () => {
  const sample = {
    plans: [
      { name: "JavaScript", path: "javascript", dev_secret: "DEV_JS", prod_secret: "PROD_JS" },
      { name: "Server", path: "server", dev_secret: "DEV_SRV", prod_secret: "PROD_SRV" },
    ],
  };

  it("loads plans from config file", () => {
    const repo = makeRepo(sample);
    const plans = loadPlansConfig(repo);
    expect(plans).toHaveLength(2);
    expect(plans[0].name).toBe("JavaScript");
  });

  it("resolves plan by name case-insensitively", () => {
    const plans = loadPlansConfig(makeRepo(sample));
    expect(resolvePlan(plans, "javascript").name).toBe("JavaScript");
    expect(resolvePlan(plans, "JAVASCRIPT").name).toBe("JavaScript");
  });

  it("resolves plan by path", () => {
    const plans = loadPlansConfig(makeRepo(sample));
    expect(resolvePlan(plans, "server").name).toBe("Server");
  });

  it("throws NOT_FOUND when no match", () => {
    const plans = loadPlansConfig(makeRepo(sample));
    expect(() => resolvePlan(plans, "nonexistent")).toThrow(/not found/i);
  });

  it("returns correct env var name for dev vs prod", () => {
    const plans = loadPlansConfig(makeRepo(sample));
    expect(getPlanIdEnvVar(plans[0], "dev")).toBe("DEV_JS");
    expect(getPlanIdEnvVar(plans[0], "prod")).toBe("PROD_JS");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module `lib/plans-config.js` does not exist.

- [ ] **Step 3: Implement `lib/plans-config.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PlanConfig {
  name: string;
  path: string;
  dev_secret: string;
  prod_secret: string;
}

export interface PlansConfigFile {
  plans: PlanConfig[];
}

export class PlanNotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
  constructor(nameOrPath: string, available: string[]) {
    super(
      `Plan "${nameOrPath}" not found. Available plans: ${available.join(", ")}`,
    );
  }
}

export function loadPlansConfig(repoPath: string): PlanConfig[] {
  const configPath = join(repoPath, "config", "tracking-plans-config.json");
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as PlansConfigFile;
  if (!parsed?.plans || !Array.isArray(parsed.plans)) {
    throw new Error(
      `Invalid tracking-plans-config.json at ${configPath}: missing "plans" array`,
    );
  }
  return parsed.plans;
}

export function resolvePlan(
  plans: PlanConfig[],
  nameOrPath: string,
): PlanConfig {
  const lower = nameOrPath.toLowerCase();
  const match = plans.find(
    (p) => p.name.toLowerCase() === lower || p.path.toLowerCase() === lower,
  );
  if (!match) {
    throw new PlanNotFoundError(
      nameOrPath,
      plans.map((p) => p.name),
    );
  }
  return match;
}

export function getPlanIdEnvVar(
  plan: PlanConfig,
  env: "dev" | "prod",
): string {
  return env === "dev" ? plan.dev_secret : plan.prod_secret;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 5/5 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/plans-config.ts tests/lib/plans-config.test.ts
git commit -m "feat(lib): add plans-config module"
```

---

## Task 3: Extract `lib/segment-api.ts`

**Files:**
- Create: `lib/segment-api.ts`
- Create: `tests/lib/segment-api.test.ts`

**Interfaces:**
- Produces:
  - `type Rule = { key: string; type: string; version: number; jsonSchema: Record<string, unknown>; }`
  - `type SegmentClient = { fetchAllRules(trackingPlanId: string): Promise<Rule[]>; patchRules(trackingPlanId: string, rules: Rule[]): Promise<void>; deleteRules(trackingPlanId: string, rules: Array<{key: string; type: string; version: number}>): Promise<void>; }`
  - `createSegmentClient(opts: { apiKey: string; baseUrl?: string; paginationCount?: number; }): SegmentClient`
  - `class SegmentApiError extends Error { code = "SEGMENT_API"; status?: number; body?: unknown; }`

Fetches paginate at 100 by default. Patches and deletes batch at 200 per request. `baseUrl` defaults to `"https://api.segmentapis.com"`.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/segment-api.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { createSegmentClient, SegmentApiError } from "../../lib/segment-api.js";

const BASE = "https://api.segmentapis.com";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("segment-api", () => {
  it("fetchAllRules paginates across multiple pages", async () => {
    const page1 = {
      data: {
        rules: [{ key: "A", type: "TRACK", version: 1, jsonSchema: {} }],
        pagination: { current: "0", next: "cursor2" },
      },
    };
    const page2 = {
      data: {
        rules: [{ key: "B", type: "TRACK", version: 1, jsonSchema: {} }],
        pagination: { current: "cursor2" },
      },
    };
    server.use(
      http.get(`${BASE}/tracking-plans/tp_1/rules`, ({ request }) => {
        const url = new URL(request.url);
        return HttpResponse.json(
          url.searchParams.get("pagination[cursor]") === "cursor2" ? page2 : page1,
        );
      }),
    );

    const client = createSegmentClient({ apiKey: "x" });
    const rules = await client.fetchAllRules("tp_1");
    expect(rules.map((r) => r.key)).toEqual(["A", "B"]);
  });

  it("fetchAllRules throws SegmentApiError on non-2xx", async () => {
    server.use(
      http.get(`${BASE}/tracking-plans/tp_1/rules`, () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );
    const client = createSegmentClient({ apiKey: "x" });
    await expect(client.fetchAllRules("tp_1")).rejects.toBeInstanceOf(
      SegmentApiError,
    );
  });

  it("patchRules batches at 200 per request", async () => {
    const bodies: Array<{ rules: unknown[] }> = [];
    server.use(
      http.patch(`${BASE}/tracking-plans/tp_1/rules`, async ({ request }) => {
        bodies.push((await request.json()) as { rules: unknown[] });
        return HttpResponse.json({ data: {} });
      }),
    );

    const rules = Array.from({ length: 450 }, (_, i) => ({
      key: `E${i}`,
      type: "TRACK",
      version: 1,
      jsonSchema: {},
    }));
    const client = createSegmentClient({ apiKey: "x" });
    await client.patchRules("tp_1", rules);
    expect(bodies).toHaveLength(3);
    expect(bodies[0].rules).toHaveLength(200);
    expect(bodies[2].rules).toHaveLength(50);
  });

  it("deleteRules batches at 200 per request", async () => {
    const bodies: Array<{ rules: unknown[] }> = [];
    server.use(
      http.delete(`${BASE}/tracking-plans/tp_1/rules`, async ({ request }) => {
        bodies.push((await request.json()) as { rules: unknown[] });
        return HttpResponse.json({ data: {} });
      }),
    );
    const rules = Array.from({ length: 250 }, (_, i) => ({
      key: `E${i}`,
      type: "TRACK",
      version: 1,
    }));
    const client = createSegmentClient({ apiKey: "x" });
    await client.deleteRules("tp_1", rules);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].rules).toHaveLength(50);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `lib/segment-api.ts`**

```ts
import axios, { AxiosError, AxiosInstance } from "axios";

export interface Rule {
  key: string;
  type: string;
  version: number;
  jsonSchema: Record<string, unknown>;
}

export interface RuleIdentifier {
  key: string;
  type: string;
  version: number;
}

export interface SegmentClient {
  fetchAllRules(trackingPlanId: string): Promise<Rule[]>;
  patchRules(trackingPlanId: string, rules: Rule[]): Promise<void>;
  deleteRules(
    trackingPlanId: string,
    rules: RuleIdentifier[],
  ): Promise<void>;
}

export interface SegmentClientOptions {
  apiKey: string;
  baseUrl?: string;
  paginationCount?: number;
  batchSize?: number;
}

export class SegmentApiError extends Error {
  readonly code = "SEGMENT_API" as const;
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
  }

  static fromAxios(err: unknown, context: string): SegmentApiError {
    if (err instanceof AxiosError) {
      return new SegmentApiError(
        `${context}: ${err.message}`,
        err.response?.status,
        err.response?.data,
      );
    }
    return new SegmentApiError(
      `${context}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function createSegmentClient(
  opts: SegmentClientOptions,
): SegmentClient {
  const baseUrl = opts.baseUrl ?? "https://api.segmentapis.com";
  const paginationCount = opts.paginationCount ?? 100;
  const batchSize = opts.batchSize ?? 200;
  const http: AxiosInstance = axios.create({
    baseURL: baseUrl,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
  });

  async function fetchAllRules(trackingPlanId: string): Promise<Rule[]> {
    const url = `/tracking-plans/${trackingPlanId}/rules`;
    const accumulated: Rule[] = [];
    let cursor: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = new URLSearchParams({
        "pagination[count]": String(paginationCount),
      });
      if (cursor) params.append("pagination[cursor]", cursor);
      try {
        const res = await http.get(`${url}?${params.toString()}`);
        const rules = (res.data?.data?.rules ?? []) as Rule[];
        accumulated.push(...rules);
        const next = res.data?.data?.pagination?.next as string | undefined;
        if (!next) return accumulated;
        cursor = next;
      } catch (err) {
        throw SegmentApiError.fromAxios(err, `fetchAllRules(${trackingPlanId})`);
      }
    }
  }

  async function patchRules(
    trackingPlanId: string,
    rules: Rule[],
  ): Promise<void> {
    const url = `/tracking-plans/${trackingPlanId}/rules`;
    for (let i = 0; i < rules.length; i += batchSize) {
      const chunk = rules.slice(i, i + batchSize);
      try {
        await http.patch(url, { rules: chunk });
      } catch (err) {
        throw SegmentApiError.fromAxios(
          err,
          `patchRules(${trackingPlanId}) batch ${i / batchSize + 1}`,
        );
      }
    }
  }

  async function deleteRules(
    trackingPlanId: string,
    rules: RuleIdentifier[],
  ): Promise<void> {
    const url = `/tracking-plans/${trackingPlanId}/rules`;
    for (let i = 0; i < rules.length; i += batchSize) {
      const chunk = rules.slice(i, i + batchSize);
      try {
        await http.delete(url, { data: { rules: chunk } });
      } catch (err) {
        throw SegmentApiError.fromAxios(
          err,
          `deleteRules(${trackingPlanId}) batch ${i / batchSize + 1}`,
        );
      }
    }
  }

  return { fetchAllRules, patchRules, deleteRules };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 4 new tests in `segment-api.test.ts` plus previous 5 = 9 total.

- [ ] **Step 5: Commit**

```bash
git add lib/segment-api.ts tests/lib/segment-api.test.ts
git commit -m "feat(lib): add segment-api client with pagination and batching"
```

---

## Task 4: Extract `lib/yaml-transform.ts`

**Files:**
- Create: `lib/yaml-transform.ts`
- Create: `tests/lib/yaml-transform.test.ts`

**Interfaces:**
- Produces:
  - `type YamlRule = { key: string; type: string; version: number; description?: string; labels?: Record<string, string>; properties: Record<string, YamlProperty>; }`
  - `type YamlProperty = { type?: string; description?: string; required?: boolean; properties?: Record<string, YamlProperty>; items?: unknown; enum?: unknown[]; [k: string]: unknown; }`
  - `yamlToRule(yaml: YamlRule): Rule` — matches transformation logic in existing `update-tracking-plan.js`.
  - `ruleToYaml(rule: Rule): YamlRule` — matches transformation logic in existing `generate-yaml-rules.js`.
  - `loadYamlRuleFile(filePath: string): YamlRule` — reads and parses a single tracking-rules YAML file, returns the first `rules[0]` entry.
  - `writeYamlRuleFile(filePath: string, yamlRule: YamlRule): void` — writes `{ rules: [yamlRule] }` shape used by existing tooling.

Round-trip guarantee: `yamlToRule(ruleToYaml(r))` produces the same Rule for any r produced by `ruleToYaml`.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/yaml-transform.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  yamlToRule,
  ruleToYaml,
  loadYamlRuleFile,
  writeYamlRuleFile,
  type YamlRule,
} from "../../lib/yaml-transform.js";
import type { Rule } from "../../lib/segment-api.js";

const sampleYaml: YamlRule = {
  key: "Product Viewed",
  type: "TRACK",
  version: 1,
  description: "Fired when a product is viewed",
  labels: { pii: "false" },
  properties: {
    product_id: { type: "string", description: "the product id", required: true },
    price: { type: "number", description: "the price" },
  },
};

describe("yaml-transform", () => {
  it("yamlToRule places required fields under jsonSchema.properties.properties.required", () => {
    const rule = yamlToRule(sampleYaml);
    expect(rule.key).toBe("Product Viewed");
    const schema = rule.jsonSchema as Record<string, any>;
    expect(schema.properties.properties.required).toEqual(["product_id"]);
    expect(schema.properties.properties.properties.product_id.required).toBeUndefined();
    expect(schema.description).toBe("Fired when a product is viewed");
    expect(schema.labels).toEqual({ pii: "false" });
  });

  it("yamlToRule omits description key when yaml description is empty string", () => {
    const rule = yamlToRule({ ...sampleYaml, description: "" });
    const schema = rule.jsonSchema as Record<string, any>;
    expect(schema.description).toBeUndefined();
  });

  it("ruleToYaml extracts labels and puts required back on properties", () => {
    const rule = yamlToRule(sampleYaml);
    const back = ruleToYaml(rule);
    expect(back.key).toBe("Product Viewed");
    expect(back.properties.product_id.required).toBe(true);
    expect(back.properties.price.required).toBeUndefined();
    expect(back.labels).toEqual({ pii: "false" });
  });

  it("round-trips yaml -> rule -> yaml preserving semantic content", () => {
    const rule = yamlToRule(sampleYaml);
    const back = ruleToYaml(rule);
    expect(back.key).toBe(sampleYaml.key);
    expect(back.type).toBe(sampleYaml.type);
    expect(back.version).toBe(sampleYaml.version);
    expect(back.properties.product_id.type).toBe("string");
    expect(back.properties.product_id.required).toBe(true);
  });

  it("loadYamlRuleFile and writeYamlRuleFile round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-yaml-"));
    const filePath = join(dir, "product_viewed.yml");
    writeYamlRuleFile(filePath, sampleYaml);
    const loaded = loadYamlRuleFile(filePath);
    expect(loaded.key).toBe("Product Viewed");
    expect(loaded.properties.product_id.required).toBe(true);
    // File must have the {rules: [...]} shape used by existing tooling
    const raw = readFileSync(filePath, "utf8");
    expect(raw).toMatch(/^rules:/m);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `lib/yaml-transform.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import yaml from "js-yaml";
import type { Rule } from "./segment-api.js";

export interface YamlProperty {
  type?: string;
  description?: string;
  required?: boolean;
  properties?: Record<string, YamlProperty>;
  items?: unknown;
  enum?: unknown[];
  [k: string]: unknown;
}

export interface YamlRule {
  key: string;
  type: string;
  version: number;
  description?: string;
  labels?: Record<string, string>;
  properties: Record<string, YamlProperty>;
}

interface FormattedProperties {
  properties: Record<string, Omit<YamlProperty, "required">>;
  required: string[];
}

function formatProperties(
  properties: Record<string, YamlProperty>,
): FormattedProperties {
  const out: Record<string, any> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const { required: req, properties: nested, ...rest } = value;
    out[key] = { ...rest };
    if (req === true) required.push(key);
    if (nested) {
      const nestedResult = formatProperties(nested);
      out[key].properties = nestedResult.properties;
      if (nestedResult.required.length > 0) {
        out[key].required = nestedResult.required;
      }
    }
  }
  return { properties: out, required };
}

export function yamlToRule(y: YamlRule): Rule {
  const { properties, required } = formatProperties(y.properties);
  const jsonSchema: Record<string, unknown> = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      context: { type: "object" },
      traits: { type: "object" },
      properties: {
        type: "object",
        properties,
        required: required.length > 0 ? required : undefined,
      },
    },
    required: ["properties"],
  };
  if (y.labels) jsonSchema.labels = y.labels;
  if (y.description && y.description.trim() !== "") {
    jsonSchema.description = y.description;
  }
  return {
    key: y.key,
    type: y.type,
    version: y.version,
    jsonSchema,
  };
}

function unformatProperties(
  properties: Record<string, any> | undefined,
  requiredFields: string[],
): Record<string, YamlProperty> {
  if (!properties) return {};
  const out: Record<string, YamlProperty> = {};
  for (const [key, value] of Object.entries(properties)) {
    const { properties: nested, required: nestedRequired, ...rest } = value;
    out[key] = { ...rest } as YamlProperty;
    if (requiredFields.includes(key)) out[key].required = true;
    if (nested) {
      out[key].properties = unformatProperties(nested, nestedRequired ?? []);
    }
  }
  return out;
}

export function ruleToYaml(rule: Rule): YamlRule {
  const schema = rule.jsonSchema as any;
  const labels = schema?.labels ?? undefined;
  const description = schema?.description ?? undefined;
  const props = schema?.properties?.properties?.properties ?? {};
  const required = schema?.properties?.properties?.required ?? [];
  const yamlRule: YamlRule = {
    key: rule.key,
    type: rule.type,
    version: rule.version,
    properties: unformatProperties(props, required),
  };
  if (description) yamlRule.description = description;
  if (labels) yamlRule.labels = labels;
  return yamlRule;
}

export function loadYamlRuleFile(filePath: string): YamlRule {
  const raw = readFileSync(filePath, "utf8");
  const parsed = yaml.load(raw) as { rules: YamlRule[] };
  if (!parsed?.rules?.[0]) {
    throw new Error(`Expected rules[0] in YAML file at ${filePath}`);
  }
  return parsed.rules[0];
}

export function writeYamlRuleFile(filePath: string, yamlRule: YamlRule): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const content = yaml.dump({ rules: [yamlRule] }, { noRefs: true });
  writeFileSync(filePath, content, "utf8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests green (5 new + 9 previous = 14).

- [ ] **Step 5: Commit**

```bash
git add lib/yaml-transform.ts tests/lib/yaml-transform.test.ts
git commit -m "feat(lib): add yaml-transform module for YAML <-> Segment JSON"
```

---

## Task 5: Extract `lib/render-markdown.ts`

**Files:**
- Create: `lib/render-markdown.ts`
- Create: `tests/lib/render-markdown.test.ts`

**Interfaces:**
- Produces: `renderMarkdown(opts: { title: string; rules: Rule[] }): string`

Output format matches existing `render-tp.js` behavior byte-for-byte where possible; testing captures the essential shape via snapshot rather than exact string comparison (existing script uses `os.EOL` — we normalize to `\n`).

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/render-markdown.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../../lib/render-markdown.js";
import type { Rule } from "../../lib/segment-api.js";
import { yamlToRule } from "../../lib/yaml-transform.js";

const rule: Rule = yamlToRule({
  key: "Product Viewed",
  type: "TRACK",
  version: 1,
  description: "Fired when a product is viewed",
  properties: {
    product_id: { type: "string", description: "product id", required: true },
    price: { type: "number", description: "price" },
  },
});

describe("render-markdown", () => {
  it("renders title heading", () => {
    const md = renderMarkdown({ title: "JavaScript", rules: [rule] });
    expect(md).toMatch(/^# JavaScript/);
  });

  it("renders event heading with key", () => {
    const md = renderMarkdown({ title: "JavaScript", rules: [rule] });
    expect(md).toContain("## Product Viewed");
  });

  it("renders description", () => {
    const md = renderMarkdown({ title: "JavaScript", rules: [rule] });
    expect(md).toContain("Fired when a product is viewed");
  });

  it("renders properties table with required flag", () => {
    const md = renderMarkdown({ title: "JavaScript", rules: [rule] });
    expect(md).toContain("| **product_id** | `string` | product id | ✅ |");
    expect(md).toContain("| **price** | `number` | price | ❌ |");
  });

  it("renders analytics.track code snippet", () => {
    const md = renderMarkdown({ title: "JavaScript", rules: [rule] });
    expect(md).toContain('analytics.track("Product Viewed"');
  });

  it("handles rules with no properties gracefully", () => {
    const bareRule: Rule = {
      key: "App Opened",
      type: "TRACK",
      version: 1,
      jsonSchema: {},
    };
    const md = renderMarkdown({ title: "JavaScript", rules: [bareRule] });
    expect(md).toContain("## App Opened");
    expect(md).toContain("No description provided");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `lib/render-markdown.ts`**

```ts
import type { Rule } from "./segment-api.js";

export interface RenderMarkdownOptions {
  title: string;
  rules: Rule[];
}

type Props = Record<string, any>;

function processProperties(
  properties: Props,
  requiredFields: string[],
  parentObj: Record<string, unknown>,
  parentKey: string,
  lines: string[],
): void {
  for (const propName in properties) {
    const propData = properties[propName] ?? {};
    const propType: string = propData.type ?? "unknown";
    const propDescription: string = propData.description ?? "No description";
    const isRequired = requiredFields.includes(propName);
    const requiredText = isRequired ? "✅" : "❌";
    const propFullName = parentKey ? `${parentKey}.${propName}` : propName;

    if (propType === "array" && propData.items?.properties) {
      lines.push(
        `| **${propFullName}** | \`array\` | ${propDescription} | ❌ |`,
      );
      lines.push(
        `| **${propFullName}.items** | \`object\` | Contains the structure for array items | ❌ |`,
      );
      parentObj[propName] = [{}];
      processProperties(
        propData.items.properties,
        [],
        (parentObj[propName] as [Record<string, unknown>])[0],
        `${propFullName}.items`,
        lines,
      );
    } else {
      lines.push(
        `| **${propFullName}** | \`${propType}\` | ${propDescription} | ${requiredText} |`,
      );
      parentObj[propName] = `<<type: ${propType}, required: ${isRequired}>>`;
      if (propType === "object" && propData.properties) {
        parentObj[propName] = {};
        processProperties(
          propData.properties,
          propData.required ?? [],
          parentObj[propName] as Record<string, unknown>,
          propFullName,
          lines,
        );
      }
    }
  }
}

export function renderMarkdown(opts: RenderMarkdownOptions): string {
  const { title, rules } = opts;
  const out: string[] = [`# ${title}\n`];

  for (const event of rules) {
    const schema = event.jsonSchema as any;
    const section: string[] = [];
    section.push(`\n## ${event.key}\n`);
    section.push("<!-- tabs:start -->");
    section.push("### **Details**\n");
    section.push("#### **Description**\n");
    section.push(schema?.description ?? "No description provided");
    section.push("#### **Properties**\n");
    section.push("| **Name** | `Type` | Description | Required? |");
    section.push("| :--- | :--- | :--- | :--- |");

    const jsSnippet: Record<string, unknown> = {};
    const props = schema?.properties?.properties?.properties;
    if (props) {
      processProperties(
        props,
        schema?.properties?.properties?.required ?? [],
        jsSnippet,
        "",
        section,
      );
    }

    section.push("#### **JS**\n");
    section.push("```javascript");
    section.push(
      `analytics.track("${event.key}", ${JSON.stringify(jsSnippet, null, 2)})`,
    );
    section.push("```" + "\n");
    section.push("<!-- tabs:end -->" + "\n");
    section.push("<!-- panels:end -->" + "\n");

    out.push(...section);
  }
  return out.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 6 new tests + 14 previous = 20.

- [ ] **Step 5: Commit**

```bash
git add lib/render-markdown.ts tests/lib/render-markdown.test.ts
git commit -m "feat(lib): add render-markdown module"
```

---

## Task 6: Add `lib/plan-snapshot.ts` for reading local JSON snapshots

**Files:**
- Create: `lib/plan-snapshot.ts`
- Create: `tests/lib/plan-snapshot.test.ts`

**Interfaces:**
- Produces:
  - `readPlanSnapshot(repoPath: string, env: "dev" | "prod", planPath: string): Rule[]` — reads `plans/<env>/<planPath>/current-rules*.json` and returns a merged `Rule[]`. Handles both single-file (`current-rules.json`) and chunked (`current-rules-1.json`, `current-rules-2.json`, ...) forms produced by the existing save-tracking-plan script.
  - `hasPlanSnapshot(repoPath: string, env: "dev" | "prod", planPath: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/plan-snapshot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPlanSnapshot, hasPlanSnapshot } from "../../lib/plan-snapshot.js";

function makePlanDir(files: Record<string, unknown>): string {
  const repo = mkdtempSync(join(tmpdir(), "tp-snap-"));
  const dir = join(repo, "plans", "dev", "javascript");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(content));
  }
  return repo;
}

describe("plan-snapshot", () => {
  it("reads a single current-rules.json", () => {
    const repo = makePlanDir({
      "current-rules.json": {
        rules: [{ key: "A", type: "TRACK", version: 1, jsonSchema: {} }],
      },
    });
    const rules = readPlanSnapshot(repo, "dev", "javascript");
    expect(rules.map((r) => r.key)).toEqual(["A"]);
  });

  it("merges chunked current-rules-*.json files in sorted order", () => {
    const repo = makePlanDir({
      "current-rules-2.json": {
        rules: [{ key: "B", type: "TRACK", version: 1, jsonSchema: {} }],
      },
      "current-rules-1.json": {
        rules: [{ key: "A", type: "TRACK", version: 1, jsonSchema: {} }],
      },
    });
    const rules = readPlanSnapshot(repo, "dev", "javascript");
    expect(rules.map((r) => r.key)).toEqual(["A", "B"]);
  });

  it("returns empty array when directory does not exist", () => {
    const repo = mkdtempSync(join(tmpdir(), "tp-snap-"));
    expect(readPlanSnapshot(repo, "dev", "javascript")).toEqual([]);
    expect(hasPlanSnapshot(repo, "dev", "javascript")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `lib/plan-snapshot.ts`**

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "./segment-api.js";

function planDir(
  repoPath: string,
  env: "dev" | "prod",
  planPath: string,
): string {
  return join(repoPath, "plans", env, planPath);
}

export function hasPlanSnapshot(
  repoPath: string,
  env: "dev" | "prod",
  planPath: string,
): boolean {
  const dir = planDir(repoPath, env, planPath);
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some(
    (f) => f.startsWith("current-rules") && f.endsWith(".json"),
  );
}

export function readPlanSnapshot(
  repoPath: string,
  env: "dev" | "prod",
  planPath: string,
): Rule[] {
  const dir = planDir(repoPath, env, planPath);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("current-rules") && f.endsWith(".json"))
    .sort();
  const rules: Rule[] = [];
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    const parsed = JSON.parse(raw) as { rules?: Rule[] };
    if (Array.isArray(parsed.rules)) rules.push(...parsed.rules);
  }
  return rules;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 3 new tests + 20 previous = 23.

- [ ] **Step 5: Commit**

```bash
git add lib/plan-snapshot.ts tests/lib/plan-snapshot.test.ts
git commit -m "feat(lib): add plan-snapshot module for reading local JSON"
```

---

## Task 7: Refactor existing scripts to use `lib/`

**Files:**
- Modify: `scripts/save-tracking-plan.js`
- Modify: `scripts/update-tracking-plan.js`
- Modify: `scripts/reset-tracking-plan.js`
- Modify: `scripts/generate-yaml-rules.js`
- Modify: `scripts/render-tp.js`
- Modify: `package.json` — add `build:lib` script if needed for scripts to consume compiled output.

**Interfaces:**
- Consumes: everything from `lib/`.
- Produces: scripts keep their exact env-var contracts and CLI signatures. GitHub Actions workflows are unmodified.

Because the workflows execute `node scripts/foo.js` directly (no build step), we import the compiled TS output. Add a `prebuild` hook so `npm run build` produces `dist/lib/*.js`, and scripts import from `dist/lib/*.js`. Also add `build` invocation to each workflow before script execution — this is the ONE workflow change in M1.

- [ ] **Step 1: Add build step and script updates in `package.json`**

Modify `package.json` scripts:

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "mcp": "node dist/mcp/server.js",
  "prestart": "npm run build",
  "prepack": "npm run build"
}
```

- [ ] **Step 2: Refactor `scripts/save-tracking-plan.js`**

Replace file contents with:

```js
const path = require('path');
const fs = require('fs');
const { createSegmentClient } = require('../dist/lib/segment-api.js');

async function main() {
  const planDir = process.env.PLAN_DIR;
  const trackingPlanId = process.env.SEGMENT_TRACKING_PLAN_ID;
  const apiKey = process.env.SEGMENT_API_KEY;
  if (!planDir || !trackingPlanId || !apiKey) {
    console.error('Missing PLAN_DIR, SEGMENT_TRACKING_PLAN_ID, or SEGMENT_API_KEY');
    process.exit(1);
  }
  const client = createSegmentClient({ apiKey });
  const rules = await client.fetchAllRules(trackingPlanId);
  fs.mkdirSync(planDir, { recursive: true });
  const filePath = path.join(planDir, 'current-rules.json');
  fs.writeFileSync(filePath, JSON.stringify({ rules }, null, 2));
  console.log(`Saved ${rules.length} rules to ${filePath}`);
  splitFileIfLarge(filePath, planDir);
}

function splitFileIfLarge(filePath, planDir) {
  const MAX = 100 * 1024 * 1024;
  const CHUNK = 90 * 1024 * 1024;
  const size = fs.statSync(filePath).size;
  if (size <= MAX) return;
  const { rules } = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  let idx = 1;
  let cur = [];
  for (const rule of rules) {
    cur.push(rule);
    if (Buffer.byteLength(JSON.stringify({ rules: cur }), 'utf-8') >= CHUNK) {
      fs.writeFileSync(
        path.join(planDir, `current-rules-${idx}.json`),
        JSON.stringify({ rules: cur }, null, 2),
      );
      idx++;
      cur = [];
    }
  }
  if (cur.length) {
    fs.writeFileSync(
      path.join(planDir, `current-rules-${idx}.json`),
      JSON.stringify({ rules: cur }, null, 2),
    );
  }
  fs.unlinkSync(filePath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Refactor `scripts/update-tracking-plan.js`**

Replace file contents with:

```js
const { execSync } = require('child_process');
const { createSegmentClient } = require('../dist/lib/segment-api.js');
const { loadYamlRuleFile, yamlToRule } = require('../dist/lib/yaml-transform.js');

function getChangedFiles(directory) {
  const files = execSync('git diff --name-only HEAD^ HEAD').toString().split('\n');
  return files.filter((f) => f.startsWith(directory) && f.endsWith('.yml'));
}

async function main() {
  const planDir = process.env.PLAN_DIR;
  const trackingPlanId = process.env.SEGMENT_TRACKING_PLAN_ID;
  const apiKey = process.env.SEGMENT_API_KEY;
  if (!planDir || !trackingPlanId || !apiKey) {
    console.error('Missing PLAN_DIR, SEGMENT_TRACKING_PLAN_ID, or SEGMENT_API_KEY');
    process.exit(1);
  }
  const changed = getChangedFiles(planDir);
  const rules = changed.map((f) => yamlToRule(loadYamlRuleFile(f)));
  if (rules.length === 0) {
    console.log('No changed YAML rules to update.');
    return;
  }
  const client = createSegmentClient({ apiKey });
  await client.patchRules(trackingPlanId, rules);
  console.log(`Updated ${rules.length} rules on plan ${trackingPlanId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Refactor `scripts/reset-tracking-plan.js`**

Replace file contents with:

```js
const path = require('path');
const fs = require('fs');
const { createSegmentClient } = require('../dist/lib/segment-api.js');

async function main() {
  const planDir = process.env.PLAN_DIR;
  const trackingPlanId = process.env.SEGMENT_TRACKING_PLAN_ID;
  const apiKey = process.env.SEGMENT_API_KEY;
  if (!planDir || !trackingPlanId || !apiKey) {
    console.error('Missing PLAN_DIR, SEGMENT_TRACKING_PLAN_ID, or SEGMENT_API_KEY');
    process.exit(1);
  }
  const client = createSegmentClient({ apiKey });
  const existing = await client.fetchAllRules(trackingPlanId);
  if (existing.length > 0) {
    await client.deleteRules(
      trackingPlanId,
      existing.map((r) => ({ key: r.key, type: r.type, version: r.version })),
    );
    console.log(`Deleted ${existing.length} rules from ${trackingPlanId}`);
  }
  const files = fs
    .readdirSync(planDir)
    .filter((f) => f.startsWith('current-rules') && f.endsWith('.json'))
    .sort();
  for (const f of files) {
    const { rules } = JSON.parse(fs.readFileSync(path.join(planDir, f), 'utf-8'));
    if (Array.isArray(rules) && rules.length > 0) {
      await client.patchRules(trackingPlanId, rules);
      console.log(`Uploaded ${rules.length} rules from ${f}`);
    }
  }
  console.log('Tracking plan reset complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Refactor `scripts/generate-yaml-rules.js`**

Replace file contents with:

```js
const path = require('path');
const fs = require('fs');
const { ruleToYaml, writeYamlRuleFile } = require('../dist/lib/yaml-transform.js');

const [planDir, saveDir] = process.argv.slice(2);
if (!planDir || !saveDir) {
  console.error('Usage: node scripts/generate-yaml-rules.js <planDir> <saveDir>');
  process.exit(1);
}
const jsonFilePath = path.join(planDir, 'current-rules.json');
const { rules } = JSON.parse(fs.readFileSync(jsonFilePath, 'utf-8'));
for (const rule of rules) {
  const y = ruleToYaml(rule);
  const fileName = `${rule.key.replace(/ /g, '_')}.yml`;
  writeYamlRuleFile(path.join(saveDir, fileName), y);
  console.log(`Generated ${fileName}`);
}
```

- [ ] **Step 6: Refactor `scripts/render-tp.js`**

Replace file contents with:

```js
const path = require('path');
const fs = require('fs');
const { renderMarkdown } = require('../dist/lib/render-markdown.js');

const [title, jsonSourcePath, markdownTargetPath] = process.argv.slice(2);
if (!title || !jsonSourcePath || !markdownTargetPath) {
  console.error('Usage: node scripts/render-tp.js <title> <jsonSourcePath> <markdownTargetPath>');
  process.exit(1);
}
const json = JSON.parse(fs.readFileSync(path.resolve(jsonSourcePath), 'utf8'));
const md = renderMarkdown({ title, rules: json.rules });
fs.mkdirSync(path.dirname(markdownTargetPath), { recursive: true });
fs.writeFileSync(markdownTargetPath, md, 'utf-8');
console.log(`Wrote ${markdownTargetPath}`);
```

- [ ] **Step 7: Update every workflow that calls a script to run `npm run build` first**

Modify `.github/workflows/*.yml` — every workflow step that runs `node scripts/*.js` must be preceded by a build step. Add this stanza before the first script invocation in each workflow (`initialize.yml`, `update-dev-tracking-plans.yml`, `update-prod-tracking-plans.yml`, `reset-dev-tracking-plans.yml`, `generate-markdown.yml`):

```yaml
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install dependencies
        run: npm ci
      - name: Build lib/
        run: npm run build
```

If a Setup Node / Install step already exists, ensure `node-version` is `20` and add the "Build lib/" step immediately after install.

- [ ] **Step 8: Build and verify locally**

```bash
npm run build
ls dist/lib/
```

Expected: `plans-config.js`, `segment-api.js`, `yaml-transform.js`, `render-markdown.js`, `plan-snapshot.js` all present.

- [ ] **Step 9: Sanity-run one script offline**

Write a fixture and run generate-yaml-rules against it (offline, no Segment call):

```bash
mkdir -p /tmp/tp-fixture
cat > /tmp/tp-fixture/current-rules.json <<'EOF'
{"rules":[{"key":"Product Viewed","type":"TRACK","version":1,"jsonSchema":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"context":{"type":"object"},"traits":{"type":"object"},"properties":{"type":"object","properties":{"product_id":{"type":"string","description":"id"}},"required":["product_id"]}},"required":["properties"],"description":"desc"}}]}
EOF
node scripts/generate-yaml-rules.js /tmp/tp-fixture /tmp/tp-fixture-out
cat /tmp/tp-fixture-out/Product_Viewed.yml
```

Expected: A YAML file listing `Product Viewed` with `product_id` and `required: true`.

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: all 23 tests still pass.

- [ ] **Step 11: Commit**

```bash
git add scripts/ .github/workflows/ package.json
git commit -m "refactor(scripts): consume lib/ instead of duplicating logic"
```

- [ ] **Step 12: Verify workflows still pass**

Push branch, watch GitHub Actions for at least one workflow run (e.g., trigger the markdown regeneration workflow manually or on next merge). If any workflow fails, do not proceed to Task 8 — debug and fix.

---

## Task 8: Scaffold MCP server

**Files:**
- Create: `mcp/server.ts`
- Create: `mcp/context.ts`
- Create: `mcp/tools/index.ts`
- Create: `tests/mcp/server.test.ts`
- Modify: `package.json` — add `bin` entry.

**Interfaces:**
- Produces:
  - `type ServerContext = { repoPath: string; segmentApiKey?: string; planIdEnv: (planPath: string, env: "dev" | "prod") => string | undefined; segmentClient: () => SegmentClient; }`
  - `resolveContext(): ServerContext` — reads `REPO_PATH` (default CWD), `SEGMENT_PUBLIC_API_TOKEN`, and plan-ID env vars.
  - `createServer(ctx: ServerContext): Server` — configures the MCP server with all registered tools.
  - `registerTools(server: Server, ctx: ServerContext): void`
  - Binary entry point starts stdio transport.

- [ ] **Step 1: Add bin entry to package.json**

Modify `package.json`:

```json
{
  "bin": {
    "tracking-plans-mcp": "dist/mcp/server.js"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/mcp/server.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContext, createServer } from "../../mcp/server.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tp-mcp-"));
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
  return dir;
}

describe("mcp/server", () => {
  it("resolveContext reads REPO_PATH from env or falls back to CWD", () => {
    const repo = makeRepo();
    const ctx = resolveContext({ REPO_PATH: repo });
    expect(ctx.repoPath).toBe(repo);
  });

  it("resolveContext exposes planIdEnv lookup that returns undefined if unset", () => {
    const repo = makeRepo();
    const ctx = resolveContext({ REPO_PATH: repo });
    expect(ctx.planIdEnv("javascript", "dev")).toBeUndefined();
  });

  it("resolveContext exposes planIdEnv lookup that returns value from env", () => {
    const repo = makeRepo();
    const ctx = resolveContext({ REPO_PATH: repo, DEV_JS: "rs_abc" });
    expect(ctx.planIdEnv("javascript", "dev")).toBe("rs_abc");
  });

  it("createServer registers at least one tool", async () => {
    const repo = makeRepo();
    const ctx = resolveContext({ REPO_PATH: repo });
    const server = createServer(ctx);
    // Access the server's registered tools via its internal method
    const tools = await server.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
  });
});
```

Note: The MCP SDK's `Server` class API for listing registered tools is version-dependent. If `server.listTools()` isn't available, add a small helper in `mcp/server.ts` that exposes a `listRegisteredToolNames()` method and adjust the test accordingly.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `mcp/context.ts`**

```ts
import { resolve } from "node:path";
import { createSegmentClient, SegmentClient } from "../lib/segment-api.js";
import {
  loadPlansConfig,
  PlanConfig,
  resolvePlan,
  getPlanIdEnvVar,
} from "../lib/plans-config.js";

export interface ServerContext {
  repoPath: string;
  env: Record<string, string | undefined>;
  plans: PlanConfig[];
  segmentApiKey?: string;
  planIdEnv: (planPath: string, env: "dev" | "prod") => string | undefined;
  resolvePlanOrThrow: (nameOrPath: string) => PlanConfig;
  segmentClient: () => SegmentClient;
}

export function resolveContext(
  env: Record<string, string | undefined> = process.env,
): ServerContext {
  const repoPath = resolve(env.REPO_PATH ?? process.cwd());
  const plans = loadPlansConfig(repoPath);
  const segmentApiKey = env.SEGMENT_PUBLIC_API_TOKEN;

  return {
    repoPath,
    env,
    plans,
    segmentApiKey,
    planIdEnv: (planPath, envKind) => {
      const plan = plans.find(
        (p) => p.path.toLowerCase() === planPath.toLowerCase(),
      );
      if (!plan) return undefined;
      return env[getPlanIdEnvVar(plan, envKind)];
    },
    resolvePlanOrThrow: (nameOrPath) => resolvePlan(plans, nameOrPath),
    segmentClient: () => {
      if (!segmentApiKey) {
        throw new Error(
          "SEGMENT_PUBLIC_API_TOKEN is not set in the MCP server env",
        );
      }
      return createSegmentClient({ apiKey: segmentApiKey });
    },
  };
}
```

- [ ] **Step 5: Implement `mcp/server.ts`**

```ts
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveContext, ServerContext } from "./context.js";
import { registerTools } from "./tools/index.js";

export { resolveContext } from "./context.js";

export function createServer(ctx: ServerContext): Server {
  const server = new Server(
    { name: "tracking-plans-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, ctx);
  return server;
}

async function main() {
  const ctx = resolveContext();
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `tracking-plans-mcp started (repo=${ctx.repoPath}, plans=${ctx.plans.map((p) => p.path).join(",")})`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 6: Implement `mcp/tools/index.ts` (empty placeholder + one heartbeat tool)**

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ServerContext } from "../context.js";

export function registerTools(server: Server, ctx: ServerContext): void {
  server.setRequestHandler(
    { method: "tools/list" } as any,
    async () => ({
      tools: [
        {
          name: "ping",
          description: "Returns 'pong' with the configured repo path — sanity check.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    }),
  );
  server.setRequestHandler(
    { method: "tools/call" } as any,
    async (req: any) => {
      if (req.params?.name === "ping") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, data: { pong: ctx.repoPath } }),
            },
          ],
        };
      }
      throw new Error(`Unknown tool: ${req.params?.name}`);
    },
  );
}
```

Note: The `setRequestHandler` signature and request-schema types depend on the MCP SDK version. Consult the SDK's README on install to swap in the correct schema objects (typically `ListToolsRequestSchema` and `CallToolRequestSchema`). Adjust imports and cast to `any` only if necessary during scaffolding — remove `as any` when the correct types are wired in. This scaffolding will be replaced in Task 9.

- [ ] **Step 7: Build and run the test**

Run: `npm run build && npm test`
Expected: PASS — 4 new tests + 23 previous = 27.

- [ ] **Step 8: Smoke-test the binary locally**

```bash
npm run build
REPO_PATH=$(pwd) node dist/mcp/server.js < /dev/null
```

Expected: server starts (prints startup line to stderr) and exits when stdin closes. No stack trace.

- [ ] **Step 9: Commit**

```bash
git add mcp/ tests/mcp/ package.json
git commit -m "feat(mcp): scaffold MCP server with ping tool"
```

---

## Task 9: Read-only tools — `list_plans`, `list_events`, `get_event`

**Files:**
- Create: `mcp/tools/read.ts`
- Modify: `mcp/tools/index.ts` — replace the `ping` placeholder with real tool registration that imports from `read.ts`.
- Create: `tests/mcp/tools-read.test.ts`

**Interfaces:**
- Consumes: `ServerContext` from Task 8; `readPlanSnapshot` from Task 6.
- Produces:
  - Registered tool `list_plans` — no args. Returns `{ plans: [{ name, path }] }`.
  - Registered tool `list_events` — args `{ plan: string; env: "dev" | "prod"; filter?: string; missing_description?: boolean; has_property?: string }`. Returns `{ events: [{ key, description, property_count }] }`.
  - Registered tool `get_event` — args `{ plan: string; env: "dev" | "prod"; key: string }`. Returns full `{ event: { key, type, version, description, labels, properties } }` (the YamlRule shape from Task 4).

All tools return the `ToolResult<T>` envelope from the spec.

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp/tools-read.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContext } from "../../mcp/context.js";
import { listPlans, listEvents, getEvent } from "../../mcp/tools/read.js";

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "tp-tools-"));
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
                required: ["product_id"],
              },
            },
          },
        },
        {
          key: "Order Completed",
          type: "TRACK",
          version: 1,
          jsonSchema: {
            properties: {
              properties: {
                type: "object",
                properties: { order_id: { type: "string" } },
              },
            },
          },
        },
      ],
    }),
  );
  return repo;
}

describe("mcp/tools/read", () => {
  let ctx: ReturnType<typeof resolveContext>;
  beforeEach(() => {
    ctx = resolveContext({ REPO_PATH: makeRepo() });
  });

  it("listPlans returns configured plans", async () => {
    const res = await listPlans(ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    expect(res.data.plans).toEqual([{ name: "JavaScript", path: "javascript" }]);
  });

  it("listEvents returns events from dev snapshot", async () => {
    const res = await listEvents(ctx, { plan: "javascript", env: "dev" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    expect(res.data.events.map((e) => e.key).sort()).toEqual([
      "Order Completed",
      "Product Viewed",
    ]);
  });

  it("listEvents filter matches by regex on key", async () => {
    const res = await listEvents(ctx, {
      plan: "javascript",
      env: "dev",
      filter: "^Order",
    });
    if (!res.ok) throw new Error();
    expect(res.data.events).toHaveLength(1);
    expect(res.data.events[0].key).toBe("Order Completed");
  });

  it("listEvents missing_description flag", async () => {
    const res = await listEvents(ctx, {
      plan: "javascript",
      env: "dev",
      missing_description: true,
    });
    if (!res.ok) throw new Error();
    expect(res.data.events.map((e) => e.key)).toEqual(["Order Completed"]);
  });

  it("listEvents has_property flag", async () => {
    const res = await listEvents(ctx, {
      plan: "javascript",
      env: "dev",
      has_property: "product_id",
    });
    if (!res.ok) throw new Error();
    expect(res.data.events.map((e) => e.key)).toEqual(["Product Viewed"]);
  });

  it("getEvent returns full yaml-shaped event", async () => {
    const res = await getEvent(ctx, {
      plan: "javascript",
      env: "dev",
      key: "Product Viewed",
    });
    if (!res.ok) throw new Error();
    expect(res.data.event.description).toBe("Fired on view");
    expect(res.data.event.properties.product_id.required).toBe(true);
  });

  it("getEvent returns NOT_FOUND error for missing key", async () => {
    const res = await getEvent(ctx, {
      plan: "javascript",
      env: "dev",
      key: "Bogus",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.error.code).toBe("NOT_FOUND");
  });

  it("listEvents returns NOT_FOUND for unknown plan", async () => {
    const res = await listEvents(ctx, { plan: "nope", env: "dev" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.error.code).toBe("NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `mcp/tools/read` does not exist.

- [ ] **Step 3: Add shared `ToolResult` type to a small helper**

Create `mcp/tools/result.ts`:

```ts
export type ToolResult<T> =
  | { ok: true; data: T; warnings?: string[] }
  | {
      ok: false;
      error: {
        code:
          | "DIRTY_TREE"
          | "SEGMENT_API"
          | "GIT"
          | "VALIDATION"
          | "CONFIG"
          | "NOT_FOUND"
          | "PROD_WRITE_BLOCKED"
          | "UNKNOWN";
        message: string;
        details?: unknown;
        remediation?: string;
      };
    };

export function ok<T>(data: T, warnings?: string[]): ToolResult<T> {
  return warnings ? { ok: true, data, warnings } : { ok: true, data };
}

export function err(
  code: Extract<ToolResult<unknown>, { ok: false }>["error"]["code"],
  message: string,
  extras?: { details?: unknown; remediation?: string },
): ToolResult<never> {
  return { ok: false, error: { code, message, ...extras } };
}
```

- [ ] **Step 4: Implement `mcp/tools/read.ts`**

```ts
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { readPlanSnapshot } from "../../lib/plan-snapshot.js";
import { ruleToYaml } from "../../lib/yaml-transform.js";
import { PlanNotFoundError } from "../../lib/plans-config.js";
import { err, ok, ToolResult } from "./result.js";

export const listPlansInput = z.object({}).strict();
export const listEventsInput = z
  .object({
    plan: z.string(),
    env: z.enum(["dev", "prod"]),
    filter: z.string().optional(),
    missing_description: z.boolean().optional(),
    has_property: z.string().optional(),
  })
  .strict();
export const getEventInput = z
  .object({
    plan: z.string(),
    env: z.enum(["dev", "prod"]),
    key: z.string(),
  })
  .strict();

export async function listPlans(
  ctx: ServerContext,
  _args: z.infer<typeof listPlansInput>,
): Promise<ToolResult<{ plans: Array<{ name: string; path: string }> }>> {
  return ok({
    plans: ctx.plans.map((p) => ({ name: p.name, path: p.path })),
  });
}

export async function listEvents(
  ctx: ServerContext,
  args: z.infer<typeof listEventsInput>,
): Promise<
  ToolResult<{
    events: Array<{ key: string; description: string | null; property_count: number }>;
  }>
> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) {
      return err("NOT_FOUND", e.message);
    }
    throw e;
  }
  const rules = readPlanSnapshot(ctx.repoPath, args.env, plan.path);
  const filterRegex = args.filter ? new RegExp(args.filter) : null;
  const events = rules
    .map((r) => {
      const schema = r.jsonSchema as any;
      const props = schema?.properties?.properties?.properties ?? {};
      return {
        key: r.key,
        description: (schema?.description ?? null) as string | null,
        property_count: Object.keys(props).length,
        _props: props as Record<string, unknown>,
      };
    })
    .filter((e) => (filterRegex ? filterRegex.test(e.key) : true))
    .filter((e) =>
      args.missing_description ? !e.description : true,
    )
    .filter((e) =>
      args.has_property ? args.has_property in e._props : true,
    )
    .map(({ _props, ...rest }) => rest);
  return ok({ events });
}

export async function getEvent(
  ctx: ServerContext,
  args: z.infer<typeof getEventInput>,
): Promise<ToolResult<{ event: ReturnType<typeof ruleToYaml> }>> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) {
      return err("NOT_FOUND", e.message);
    }
    throw e;
  }
  const rules = readPlanSnapshot(ctx.repoPath, args.env, plan.path);
  const match = rules.find((r) => r.key === args.key);
  if (!match) {
    return err(
      "NOT_FOUND",
      `Event "${args.key}" not found in ${plan.name} (${args.env})`,
    );
  }
  return ok({ event: ruleToYaml(match) });
}
```

- [ ] **Step 5: Wire tools into `mcp/tools/index.ts`**

Replace `mcp/tools/index.ts` with:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ServerContext } from "../context.js";
import {
  listPlans,
  listPlansInput,
  listEvents,
  listEventsInput,
  getEvent,
  getEventInput,
} from "./read.js";

type Handler = (ctx: ServerContext, args: any) => Promise<unknown>;

interface ToolDef {
  name: string;
  description: string;
  schema: any;
  handler: Handler;
}

function makeTool<S extends { parse: (v: unknown) => any }>(
  name: string,
  description: string,
  schema: S,
  handler: (ctx: ServerContext, args: any) => Promise<unknown>,
): ToolDef {
  return {
    name,
    description,
    schema,
    handler: async (ctx, args) => handler(ctx, schema.parse(args ?? {})),
  };
}

export function registerTools(server: Server, ctx: ServerContext): void {
  const tools: ToolDef[] = [
    makeTool("list_plans", "List all configured tracking plans.", listPlansInput, listPlans),
    makeTool(
      "list_events",
      "List events in a plan snapshot. Supports filter (regex), missing_description, has_property.",
      listEventsInput,
      listEvents,
    ),
    makeTool(
      "get_event",
      "Get a single event's full definition (yaml shape) from a plan snapshot.",
      getEventInput,
      getEvent,
    ),
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema, { target: "openApi3" }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
    const result = await tool.handler(ctx, req.params.arguments);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  });
}
```

- [ ] **Step 6: Add zod-to-json-schema dependency**

```bash
npm install zod-to-json-schema
```

- [ ] **Step 7: Run tests**

Run: `npm run build && npm test`
Expected: PASS — 8 new tests + 27 previous = 35.

- [ ] **Step 8: Commit**

```bash
git add mcp/ tests/mcp/tools-read.test.ts package.json package-lock.json
git commit -m "feat(mcp): add list_plans, list_events, get_event tools"
```

---

## Task 10: Read-only tools — `diff_plans`, `find_property_usage`, `list_recent_changes`

**Files:**
- Modify: `mcp/tools/read.ts` — add three functions and export.
- Modify: `mcp/tools/index.ts` — register the three new tools.
- Create: `tests/mcp/tools-read-advanced.test.ts`

**Interfaces:**
- Consumes: everything from Task 9.
- Produces:
  - `diffPlans(ctx, { planA, envA, planB, envB })` — returns `{ added: string[]; removed: string[]; modified: Array<{ key: string; changes: string[] }> }`. `added` = keys in B but not A; `removed` = keys in A but not B; `modified` = keys in both whose property sets differ. `changes` is a list of `"added property X"`, `"removed property Y"`, `"changed property Z type from string to number"`.
  - `findPropertyUsage(ctx, { property, plan?, env })` — returns `{ usages: Array<{ plan: string; event: string }> }`. If `plan` omitted, searches all plans.
  - `listRecentChanges(ctx, { plan, limit? })` — shells to `git log --oneline -n <limit> -- tracking-rules/<planPath>/`. Returns `{ commits: Array<{ sha: string; subject: string }> }`. Defaults `limit` to 20.

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp/tools-read-advanced.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — three new imports don't exist yet.

- [ ] **Step 3: Extend `mcp/tools/read.ts` with the three new tools**

Append to `mcp/tools/read.ts`:

```ts
import { execFileSync } from "node:child_process";

export const diffPlansInput = z
  .object({
    planA: z.string(),
    envA: z.enum(["dev", "prod"]),
    planB: z.string(),
    envB: z.enum(["dev", "prod"]),
  })
  .strict();
export const findPropertyUsageInput = z
  .object({
    property: z.string(),
    plan: z.string().optional(),
    env: z.enum(["dev", "prod"]),
  })
  .strict();
export const listRecentChangesInput = z
  .object({
    plan: z.string(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

function propsOf(rule: any): Record<string, any> {
  return rule?.jsonSchema?.properties?.properties?.properties ?? {};
}

export async function diffPlans(
  ctx: ServerContext,
  args: z.infer<typeof diffPlansInput>,
): Promise<
  ToolResult<{
    added: string[];
    removed: string[];
    modified: Array<{ key: string; changes: string[] }>;
  }>
> {
  let a, b;
  try {
    a = ctx.resolvePlanOrThrow(args.planA);
    b = ctx.resolvePlanOrThrow(args.planB);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const rulesA = readPlanSnapshot(ctx.repoPath, args.envA, a.path);
  const rulesB = readPlanSnapshot(ctx.repoPath, args.envB, b.path);
  const mapA = new Map(rulesA.map((r) => [r.key, r]));
  const mapB = new Map(rulesB.map((r) => [r.key, r]));

  const added: string[] = [];
  const removed: string[] = [];
  const modified: Array<{ key: string; changes: string[] }> = [];

  for (const key of mapB.keys()) if (!mapA.has(key)) added.push(key);
  for (const key of mapA.keys()) if (!mapB.has(key)) removed.push(key);
  for (const [key, ruleA] of mapA) {
    const ruleB = mapB.get(key);
    if (!ruleB) continue;
    const propsA = propsOf(ruleA);
    const propsB = propsOf(ruleB);
    const changes: string[] = [];
    for (const p of Object.keys(propsB)) {
      if (!(p in propsA)) changes.push(`added property ${p}`);
      else if ((propsA[p]?.type ?? "unknown") !== (propsB[p]?.type ?? "unknown")) {
        changes.push(
          `changed property ${p} type from ${propsA[p]?.type} to ${propsB[p]?.type}`,
        );
      }
    }
    for (const p of Object.keys(propsA)) {
      if (!(p in propsB)) changes.push(`removed property ${p}`);
    }
    if (changes.length) modified.push({ key, changes });
  }
  return ok({ added, removed, modified });
}

export async function findPropertyUsage(
  ctx: ServerContext,
  args: z.infer<typeof findPropertyUsageInput>,
): Promise<ToolResult<{ usages: Array<{ plan: string; event: string }> }>> {
  const plansToSearch = args.plan
    ? [(() => {
        try {
          return ctx.resolvePlanOrThrow(args.plan);
        } catch (e) {
          if (e instanceof PlanNotFoundError) throw e;
          throw e;
        }
      })()]
    : ctx.plans;
  const usages: Array<{ plan: string; event: string }> = [];
  for (const p of plansToSearch) {
    const rules = readPlanSnapshot(ctx.repoPath, args.env, p.path);
    for (const r of rules) {
      if (args.property in propsOf(r)) {
        usages.push({ plan: p.path, event: r.key });
      }
    }
  }
  return ok({ usages });
}

export async function listRecentChanges(
  ctx: ServerContext,
  args: z.infer<typeof listRecentChangesInput>,
): Promise<ToolResult<{ commits: Array<{ sha: string; subject: string }> }>> {
  let plan;
  try {
    plan = ctx.resolvePlanOrThrow(args.plan);
  } catch (e) {
    if (e instanceof PlanNotFoundError) return err("NOT_FOUND", e.message);
    throw e;
  }
  const limit = args.limit ?? 20;
  const out = execFileSync(
    "git",
    [
      "log",
      `--max-count=${limit}`,
      "--pretty=format:%H%x1f%s",
      "--",
      `tracking-rules/${plan.path}/`,
    ],
    { cwd: ctx.repoPath, encoding: "utf8" },
  );
  const commits = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split("\x1f");
      return { sha, subject };
    });
  return ok({ commits });
}
```

- [ ] **Step 4: Register the three new tools in `mcp/tools/index.ts`**

Add these entries to the `tools` array:

```ts
makeTool(
  "diff_plans",
  "Semantic diff between two (plan, env) pairs — added/removed/modified events.",
  diffPlansInput,
  diffPlans,
),
makeTool(
  "find_property_usage",
  "List every event that uses a given property. If plan is omitted, searches all plans.",
  findPropertyUsageInput,
  findPropertyUsage,
),
makeTool(
  "list_recent_changes",
  "Git log for tracking-rules/<plan>/ over the last N commits (default 20).",
  listRecentChangesInput,
  listRecentChanges,
),
```

And add the imports at the top:

```ts
import {
  ...,
  diffPlans,
  diffPlansInput,
  findPropertyUsage,
  findPropertyUsageInput,
  listRecentChanges,
  listRecentChangesInput,
} from "./read.js";
```

- [ ] **Step 5: Run tests**

Run: `npm run build && npm test`
Expected: PASS — 3 new tests + 35 previous = 38.

- [ ] **Step 6: Commit**

```bash
git add mcp/tools/read.ts mcp/tools/index.ts tests/mcp/tools-read-advanced.test.ts
git commit -m "feat(mcp): add diff_plans, find_property_usage, list_recent_changes"
```

---

## Task 11: Manual smoke test and Claude Desktop wiring

**Files:**
- Create: `docs/mcp-smoke-test.md`
- Modify: `README.md` — add MCP section.

**Interfaces:**
- Produces: manual verification recipe + wiring instructions any teammate can follow.

- [ ] **Step 1: Create `docs/mcp-smoke-test.md`**

```markdown
# Tracking Plans MCP — Manual Smoke Test (Milestone 1)

## Prerequisites

- Node 20+ installed.
- Local clone of this repo at `~/code/trackings-plans` (or wherever).
- Segment API token and tracking plan IDs available (same values used by GitHub Actions secrets).

## Steps

### 1. Build

```bash
cd ~/code/trackings-plans
npm ci
npm run build
```

Expected: `dist/mcp/server.js` and `dist/lib/*.js` exist.

### 2. Run once locally

```bash
REPO_PATH=$(pwd) \
SEGMENT_PUBLIC_API_TOKEN=sgp_... \
DEV_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT=rs_... \
PROD_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT=rs_... \
DEV_SEGMENT_TRACKING_PLAN_ID_SERVER=rs_... \
PROD_SEGMENT_TRACKING_PLAN_ID_SERVER=rs_... \
node dist/mcp/server.js < /dev/null
```

Expected: prints startup line to stderr, exits cleanly.

### 3. Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tracking-plans": {
      "command": "node",
      "args": ["/absolute/path/to/trackings-plans/dist/mcp/server.js"],
      "env": {
        "REPO_PATH": "/absolute/path/to/trackings-plans",
        "SEGMENT_PUBLIC_API_TOKEN": "sgp_...",
        "DEV_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT": "rs_...",
        "PROD_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT": "rs_...",
        "DEV_SEGMENT_TRACKING_PLAN_ID_SERVER": "rs_...",
        "PROD_SEGMENT_TRACKING_PLAN_ID_SERVER": "rs_..."
      }
    }
  }
}
```

Restart Claude Desktop.

### 4. Verify each tool through Claude

Ask Claude Desktop:

1. **`list_plans`** — "What tracking plans are configured?"
   - Expected: JavaScript, Server (or whatever is in `config/tracking-plans-config.json`).

2. **`list_events`** — "List all events in the JavaScript dev plan."
   - Expected: matches `plans/dev/javascript/current-rules.json`.

3. **`list_events` with filter** — "List events in the JavaScript prod plan whose names start with 'Product'."
   - Expected: filtered list.

4. **`list_events` missing_description** — "Which events in server prod are missing descriptions?"
   - Expected: only events without a `description`.

5. **`get_event`** — "Show me the full definition for 'Product Viewed' in the JavaScript dev plan."
   - Expected: yaml-shape with properties and required flags.

6. **`diff_plans`** — "Diff JavaScript dev vs prod."
   - Expected: added/removed/modified lists.

7. **`find_property_usage`** — "Which events use the `user_id` property?"
   - Expected: usage list, possibly across both plans.

8. **`list_recent_changes`** — "Show me the last 10 commits touching JavaScript tracking rules."
   - Expected: recent git commits.

### 5. Regression check on Actions

Trigger a workflow that runs the refactored scripts (e.g., merge a small YAML change to a dev branch and ensure `update-dev-tracking-plans.yml` still succeeds). If the workflow fails on `npm run build`, add the Setup Node / Install / Build steps as described in Task 7.
```

- [ ] **Step 2: Add MCP section to README**

Append to `README.md`:

```markdown

---

## 🤖 MCP Server (Milestone 1: read-only)

This repo also ships an MCP server that lets you query your tracking plans in natural language via Claude Desktop, Cursor, or any MCP-compatible client.

### Setup

```bash
npm ci
npm run build
```

Then add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`) — see [`docs/mcp-smoke-test.md`](docs/mcp-smoke-test.md) for the full recipe.

### Available tools (M1)

- `list_plans` — enumerate configured plans
- `list_events` — list events with optional regex filter, `missing_description`, `has_property`
- `get_event` — full YAML-shape definition of a single event
- `diff_plans` — semantic diff between two `(plan, env)` pairs
- `find_property_usage` — every event that uses a given property
- `list_recent_changes` — git log limited to `tracking-rules/<plan>/`

Authoring, validation, and preview tools land in Milestone 2.
```

- [ ] **Step 3: Commit**

```bash
git add docs/mcp-smoke-test.md README.md
git commit -m "docs: MCP smoke test and README section"
```

- [ ] **Step 4: Execute the manual smoke test**

Follow every step in `docs/mcp-smoke-test.md`. If any tool call fails or returns something unexpected, do not mark M1 complete — file a note in the checklist and fix.

---

## Self-review

- Spec coverage: All M1-relevant tools from the spec are covered — `list_plans`, `list_events`, `get_event`, `diff_plans`, `find_property_usage`, `list_recent_changes`. Validate/author/preview/admin tools are correctly deferred to M2/M3.
- All existing script behavior preserved: pagination count (100), batch size (200), file-splitting at 90MB, YAML shape, markdown emoji rendering, env-var names.
- No placeholders: every step has code or a concrete command; the two SDK-version caveats in Task 8 (Step 6 and Step 2) name the exact adjustment needed if the SDK signature differs.
- Type consistency: `Rule` is defined once in `lib/segment-api.ts` and consumed by every other module; `YamlRule` in `lib/yaml-transform.ts`; `ToolResult` in `mcp/tools/result.ts`; `ServerContext` in `mcp/context.ts`.
- Frequent commits: 11 commits, one per task.
- Every task ends with a green test run.
