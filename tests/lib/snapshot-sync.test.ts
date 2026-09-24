import { describe, it, expect } from "vitest";
import {
  formatSnapshotFiles,
  resetRules,
} from "../../lib/snapshot-sync.js";
import type { Rule, RuleIdentifier, SegmentClient } from "../../lib/segment-api.js";

const rule = (key: string, version = 1): Rule => ({
  key,
  type: "TRACK",
  version,
  jsonSchema: { description: key },
});

describe("formatSnapshotFiles", () => {
  it("formats a single current-rules.json exactly like save-tracking-plan.js", () => {
    const rules = [rule("A"), rule("B")];
    const files = formatSnapshotFiles(rules);
    expect(files).toEqual([
      { name: "current-rules.json", content: JSON.stringify({ rules }, null, 2) },
    ]);
  });

  it("formats an empty plan as { rules: [] }", () => {
    expect(formatSnapshotFiles([])).toEqual([
      { name: "current-rules.json", content: JSON.stringify({ rules: [] }, null, 2) },
    ]);
  });

  it("splits into current-rules-N.json chunks when over the max size", () => {
    const rules = [rule("A"), rule("B"), rule("C")];
    const oneCompact = Buffer.byteLength(JSON.stringify({ rules: [rules[0]] }));
    // max below full size; chunk threshold reached after every 2 rules
    const files = formatSnapshotFiles(rules, {
      maxBytes: 10,
      chunkBytes: oneCompact + 10,
    });
    expect(files.map((f) => f.name)).toEqual([
      "current-rules-1.json",
      "current-rules-2.json",
    ]);
    expect(JSON.parse(files[0].content).rules.map((r: Rule) => r.key)).toEqual(["A", "B"]);
    expect(JSON.parse(files[1].content).rules.map((r: Rule) => r.key)).toEqual(["C"]);
    expect(files[0].content).toBe(JSON.stringify({ rules: [rules[0], rules[1]] }, null, 2));
  });
});

function fakeClient(existing: Rule[]) {
  const calls: { op: string; id: string; payload: unknown }[] = [];
  const client: SegmentClient = {
    async fetchAllRules(id) {
      calls.push({ op: "fetch", id, payload: null });
      return existing;
    },
    async patchRules(id, rules) {
      calls.push({ op: "patch", id, payload: rules });
    },
    async deleteRules(id, rules: RuleIdentifier[]) {
      calls.push({ op: "delete", id, payload: rules });
    },
  };
  return { client, calls };
}

describe("resetRules", () => {
  it("deletes every existing rule, then patches each non-empty source in order", async () => {
    const { client, calls } = fakeClient([rule("Old", 2), rule("A")]);
    const logs: string[] = [];
    const res = await resetRules(
      client,
      "tp_dev",
      [
        { label: "current-rules-1.json", rules: [rule("A"), rule("B")] },
        { label: "current-rules-2.json", rules: [] },
        { label: "current-rules-3.json", rules: [rule("C")] },
      ],
      (m) => logs.push(m),
    );
    expect(res).toEqual({ deleted: 2, patched: 3 });
    expect(calls.map((c) => c.op)).toEqual(["fetch", "delete", "patch", "patch"]);
    expect(calls.every((c) => c.id === "tp_dev")).toBe(true);
    expect(calls[1].payload).toEqual([
      { key: "Old", type: "TRACK", version: 2 },
      { key: "A", type: "TRACK", version: 1 },
    ]);
    expect(logs).toEqual([
      "Deleted 2 rules from tp_dev",
      "Uploaded 2 rules from current-rules-1.json",
      "Uploaded 1 rules from current-rules-3.json",
    ]);
  });

  it("skips delete when the target plan is already empty", async () => {
    const { client, calls } = fakeClient([]);
    const res = await resetRules(client, "tp_dev", [{ label: "x", rules: [rule("A")] }]);
    expect(res).toEqual({ deleted: 0, patched: 1 });
    expect(calls.map((c) => c.op)).toEqual(["fetch", "patch"]);
  });
});
