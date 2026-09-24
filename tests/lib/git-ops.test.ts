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
    createBranch(repo, "feat/new-branch", "main");
    const s = getWorkingTreeStatus(repo);
    expect(s.current_branch).toBe("feat/new-branch");
  });

  it("commitPaths stages and commits given files and returns SHA", () => {
    const repo = initRepo();
    createBranch(repo, "feat/edit", "main");
    const filePath = join(repo, "hello.txt");
    writeFileSync(filePath, "world");
    const sha = commitPaths(repo, ["hello.txt"], "feat: add hello");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const log = execSync("git log --oneline -n 1", { cwd: repo, encoding: "utf8" });
    expect(log).toContain("feat: add hello");
  });
});
