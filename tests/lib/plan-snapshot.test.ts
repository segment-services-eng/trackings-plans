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
