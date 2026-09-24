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

describe("context .tracking-plans-mcp.json precedence", () => {
  function withProjectConfig(contents: string): string {
    const dir = makeRepo();
    writeFileSync(join(dir, ".tracking-plans-mcp.json"), contents);
    return dir;
  }

  it("absent file: behavior unchanged (branch default, no projectConfig)", () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    expect(ctx.defaultWriteMode).toBe("branch");
    expect(ctx.projectConfig).toBeUndefined();
  });

  it("file write_mode overrides built-in default", () => {
    const ctx = resolveContext({ REPO_PATH: withProjectConfig('{"write_mode":"files"}') });
    expect(ctx.defaultWriteMode).toBe("files");
    expect(ctx.projectConfig).toEqual({ write_mode: "files" });
  });

  it("env MCP_WRITE_MODE overrides file", () => {
    const ctx = resolveContext({
      REPO_PATH: withProjectConfig('{"write_mode":"files"}'),
      MCP_WRITE_MODE: "pr",
    });
    expect(ctx.defaultWriteMode).toBe("pr");
  });

  it("tool arg overrides env and file", () => {
    const ctx = resolveContext({
      REPO_PATH: withProjectConfig('{"write_mode":"files"}'),
      MCP_WRITE_MODE: "pr",
    });
    expect(ctx.resolveWriteMode("branch")).toBe("branch");
    expect(ctx.resolveWriteMode(undefined)).toBe("pr");
  });

  it("invalid file throws a CONFIG error naming the file", () => {
    const dir = withProjectConfig('{"write_mode":"sometimes"}');
    expect(() => resolveContext({ REPO_PATH: dir })).toThrow(/\.tracking-plans-mcp\.json/);
    try {
      resolveContext({ REPO_PATH: dir });
    } catch (e) {
      expect((e as { code?: string }).code).toBe("CONFIG");
    }
  });

  it("file containing a token is rejected without echoing it", () => {
    const tok = "sgp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const dir = withProjectConfig(JSON.stringify({ SEGMENT_PUBLIC_API_TOKEN: tok }));
    try {
      resolveContext({ REPO_PATH: dir });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toMatch(/secret/i);
      expect((e as Error).message).not.toContain(tok);
    }
  });
});
