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

  it("createServer registers at least one tool", () => {
    const repo = makeRepo();
    const ctx = resolveContext({ REPO_PATH: repo });
    const server = createServer(ctx);
    // server.listTools() is not on the low-level Server class (SDK v1.30.0).
    // createServer augments the Server instance with listRegisteredToolNames().
    expect(server.listRegisteredToolNames().length).toBeGreaterThan(0);
  });
});
