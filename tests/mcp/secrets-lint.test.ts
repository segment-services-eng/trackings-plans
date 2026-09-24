import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSecretsLintInput, runStartupSecretsLint } from "../../mcp/secrets-lint.js";

const TOKEN = "sgp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

function makeRepo(opts: { gitignore?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "tp-lint-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: dir });
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "tracking-plans-config.json"), '{"plans":[]}');
  if (opts.gitignore !== undefined) writeFileSync(join(dir, ".gitignore"), opts.gitignore);
  execSync("git add . && git commit -qm init", { cwd: dir });
  return dir;
}

describe("mcp/secrets-lint", () => {
  it("classifies .env files by git status", () => {
    const dir = makeRepo({ gitignore: ".env\n" });
    writeFileSync(join(dir, ".env"), `SEGMENT_PUBLIC_API_TOKEN=${TOKEN}\n`);
    writeFileSync(join(dir, ".env.local"), `SEGMENT_PUBLIC_API_TOKEN=${TOKEN}\n`);
    writeFileSync(join(dir, ".env.prod"), `SEGMENT_PUBLIC_API_TOKEN=${TOKEN}\n`);
    execSync("git add -f .env.prod && git commit -qm oops", { cwd: dir });
    const input = collectSecretsLintInput(dir, {});
    const byPath = Object.fromEntries(input.envFiles.map((f) => [f.path, f.gitStatus]));
    expect(byPath).toEqual({ ".env": "ignored", ".env.local": "untracked", ".env.prod": "tracked" });
  });

  it("warns for tracked and un-ignored .env files, never printing the token", () => {
    const dir = makeRepo({ gitignore: ".env\n" });
    writeFileSync(join(dir, ".env"), `SEGMENT_PUBLIC_API_TOKEN=${TOKEN}\n`);
    writeFileSync(join(dir, ".env.local"), `SEGMENT_PUBLIC_API_TOKEN=${TOKEN}\n`);
    const warnings = runStartupSecretsLint(dir, { SEGMENT_PUBLIC_API_TOKEN: TOKEN });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(".env.local");
    expect(warnings.join("\n")).not.toContain(TOKEN);
  });

  it("warns when .tracking-plans-mcp.json contains the live token", () => {
    const dir = makeRepo({ gitignore: ".env\n" });
    writeFileSync(join(dir, ".tracking-plans-mcp.json"), `{"x":"my-live-token-value-1"}`);
    const warnings = runStartupSecretsLint(dir, {
      SEGMENT_PUBLIC_API_TOKEN: "my-live-token-value-1",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("my-live-token-value-1");
  });

  it("clean repo yields no warnings; non-git dir does not throw", () => {
    expect(runStartupSecretsLint(makeRepo(), {})).toEqual([]);
    const plain = mkdtempSync(join(tmpdir(), "tp-lint-nogit-"));
    writeFileSync(join(plain, ".env"), `SEGMENT_PUBLIC_API_TOKEN=${TOKEN}\n`);
    expect(() => runStartupSecretsLint(plain, {})).not.toThrow();
  });
});
