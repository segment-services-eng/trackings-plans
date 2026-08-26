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
