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

  it("listEvents returns VALIDATION error for invalid filter regex", async () => {
    const res = await listEvents(ctx, {
      plan: "javascript",
      env: "dev",
      filter: "[abc",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.error.code).toBe("VALIDATION");
  });
});
