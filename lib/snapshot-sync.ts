import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule, SegmentClient } from "./segment-api.js";

/**
 * Shared logic for the snapshot scripts (scripts/save-tracking-plan.js,
 * scripts/reset-tracking-plan.js) and the MCP admin tools. Pure: no env
 * access, no I/O at import.
 */

export interface SnapshotFile {
  name: string;
  content: string;
}

export interface SnapshotSource {
  label: string;
  rules: Rule[];
}

export interface FormatOptions {
  /** Split when the pretty-printed file exceeds this size. Default 100 MiB. */
  maxBytes?: number;
  /** Target chunk size (compact JSON) when splitting. Default 90 MiB. */
  chunkBytes?: number;
}

const MAX_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 90 * 1024 * 1024;

export function isSnapshotFileName(name: string): boolean {
  return name.startsWith("current-rules") && name.endsWith(".json");
}

/**
 * Produce the snapshot file(s) exactly as save-tracking-plan.js writes them:
 * a single pretty-printed `current-rules.json`, or — when that exceeds
 * `maxBytes` — `current-rules-<n>.json` chunks.
 */
export function formatSnapshotFiles(
  rules: Rule[],
  opts: FormatOptions = {},
): SnapshotFile[] {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const whole = JSON.stringify({ rules }, null, 2);
  if (Buffer.byteLength(whole, "utf-8") <= maxBytes) {
    return [{ name: "current-rules.json", content: whole }];
  }
  const files: SnapshotFile[] = [];
  let cur: Rule[] = [];
  const flush = () => {
    files.push({
      name: `current-rules-${files.length + 1}.json`,
      content: JSON.stringify({ rules: cur }, null, 2),
    });
    cur = [];
  };
  for (const rule of rules) {
    cur.push(rule);
    if (Buffer.byteLength(JSON.stringify({ rules: cur }), "utf-8") >= chunkBytes) {
      flush();
    }
  }
  if (cur.length) flush();
  return files;
}

/** Read every current-rules*.json in `dir` (sorted) as patch sources. */
export function readSnapshotSources(dir: string): SnapshotSource[] {
  return readdirSync(dir)
    .filter(isSnapshotFileName)
    .sort()
    .map((f) => {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf-8")) as {
        rules?: Rule[];
      };
      return { label: f, rules: Array.isArray(parsed.rules) ? parsed.rules : [] };
    });
}

/**
 * Make `trackingPlanId` match `sources`, mirroring reset-tracking-plan.js:
 * delete every existing rule, then patch each non-empty source in order.
 */
export async function resetRules(
  client: SegmentClient,
  trackingPlanId: string,
  sources: SnapshotSource[],
  log: (msg: string) => void = () => {},
): Promise<{ deleted: number; patched: number }> {
  const existing = await client.fetchAllRules(trackingPlanId);
  if (existing.length > 0) {
    await client.deleteRules(
      trackingPlanId,
      existing.map((r) => ({ key: r.key, type: r.type, version: r.version })),
    );
    log(`Deleted ${existing.length} rules from ${trackingPlanId}`);
  }
  let patched = 0;
  for (const src of sources) {
    if (src.rules.length > 0) {
      await client.patchRules(trackingPlanId, src.rules);
      patched += src.rules.length;
      log(`Uploaded ${src.rules.length} rules from ${src.label}`);
    }
  }
  return { deleted: existing.length, patched };
}
