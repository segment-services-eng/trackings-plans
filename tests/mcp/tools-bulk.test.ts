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
