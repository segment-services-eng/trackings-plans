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

describe("author tools (branch mode)", () => {
  it("addEvent creates branch and commits when mode=branch", async () => {
    const repo = makeRepo();
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
