import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
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

  // Fix 3: zero-affected short-circuit
  it("bulkAddProperty with filter matching zero events returns ok with warning in branch mode (Fix 3)", async () => {
    const repo = await seed();
    const ctx = resolveContext({ REPO_PATH: repo });
    const res = await bulkAddProperty(ctx, {
      plan: "javascript",
      property_name: "new_prop",
      property: { type: "string" },
      filter: "^NONEXISTENT_PATTERN_XYZ",
      dry_run: false,
      mode: "branch",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    expect(res.data.files_changed).toEqual([]);
    // Should have a warning
    expect(res.warnings).toBeDefined();
    expect(res.warnings![0]).toMatch(/no files matched/i);
    // Must be back on original branch
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(branch).toBe("main");
  });

  // Fix 5: collision detection in bulkRenameProperty
  describe("bulkRenameProperty collision detection (Fix 5)", () => {
    async function seedWithCollision(): Promise<string> {
      const repo = await seed();
      const ctx = resolveContext({ REPO_PATH: repo });
      // Add user_id to Product Viewed so it collides with a rename userId→user_id
      await addEvent(ctx, {
        plan: "javascript",
        key: "Cart Added",
        description: "d",
        properties: {
          userId: { type: "string", description: "u" },
          user_id: { type: "string", description: "already exists" },
        },
        mode: "files",
      });
      execSync("git add . && git commit -qm 'add Cart Added'", { cwd: repo });
      return repo;
    }

    it("dry_run always includes collisions field", async () => {
      const repo = await seedWithCollision();
      const ctx = resolveContext({ REPO_PATH: repo });
      const res = await bulkRenameProperty(ctx, {
        plan: "javascript",
        from: "userId",
        to: "user_id",
        dry_run: true,
      });
      if (!res.ok) throw new Error();
      expect(res.data.collisions).toBeDefined();
      expect(res.data.collisions!.length).toBe(1);
      expect(res.data.collisions![0].event).toBe("Cart Added");
    });

    it("default (on_collision:fail) blocks rename when collisions exist", async () => {
      const repo = await seedWithCollision();
      const ctx = resolveContext({ REPO_PATH: repo });
      const res = await bulkRenameProperty(ctx, {
        plan: "javascript",
        from: "userId",
        to: "user_id",
        dry_run: false,
        mode: "files",
      });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error();
      expect(res.error.code).toBe("VALIDATION");
      expect(res.error.message).toMatch(/user_id/);
    });

    it("on_collision:skip skips colliding events and renames the rest", async () => {
      const repo = await seedWithCollision();
      const ctx = resolveContext({ REPO_PATH: repo });
      const res = await bulkRenameProperty(ctx, {
        plan: "javascript",
        from: "userId",
        to: "user_id",
        dry_run: false,
        mode: "files",
        on_collision: "skip",
      });
      if (!res.ok) throw new Error(JSON.stringify(res.error));
      // Cart Added should be skipped (it had a collision)
      expect(res.data.affected_events).not.toContain("Cart Added");
      // Product Viewed and Order Completed should be renamed
      expect(res.data.affected_events).toContain("Product Viewed");
      expect(res.data.affected_events).toContain("Order Completed");
      // Cart Added should still have userId untouched
      const cartParsed = yaml.load(
        readFileSync(join(repo, "tracking-rules/javascript/Cart_Added.yml"), "utf8"),
      ) as any;
      expect(cartParsed.rules[0].properties.userId).toBeDefined();
    });

    it("on_collision:overwrite renames all events including collisions", async () => {
      const repo = await seedWithCollision();
      const ctx = resolveContext({ REPO_PATH: repo });
      const res = await bulkRenameProperty(ctx, {
        plan: "javascript",
        from: "userId",
        to: "user_id",
        dry_run: false,
        mode: "files",
        on_collision: "overwrite",
      });
      if (!res.ok) throw new Error(JSON.stringify(res.error));
      expect(res.data.affected_events).toContain("Cart Added");
      const cartParsed = yaml.load(
        readFileSync(join(repo, "tracking-rules/javascript/Cart_Added.yml"), "utf8"),
      ) as any;
      expect(cartParsed.rules[0].properties.user_id).toBeDefined();
      expect(cartParsed.rules[0].properties.userId).toBeUndefined();
    });
  });
});
