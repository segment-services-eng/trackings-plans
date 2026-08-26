import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContext } from "../../mcp/context.js";
import {
  previewMarkdown,
  previewSegmentPayload,
} from "../../mcp/tools/preview.js";

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "tp-prev-"));
  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(
    join(repo, "config", "tracking-plans-config.json"),
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
  const yamlDir = join(repo, "tracking-rules", "javascript");
  mkdirSync(yamlDir, { recursive: true });
  writeFileSync(
    join(yamlDir, "Product_Viewed.yml"),
    "rules:\n  - key: Product Viewed\n    type: TRACK\n    version: 1\n    description: Fired on view\n    properties:\n      product_id:\n        type: string\n        description: id\n        required: true\n",
  );
  return repo;
}

describe("preview MCP tools", () => {
  it("previewMarkdown renders from local YAML", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await previewMarkdown(ctx, { plan: "javascript" });
    if (!res.ok) throw new Error();
    expect(res.data.markdown).toContain("# JavaScript");
    expect(res.data.markdown).toContain("## Product Viewed");
    expect(res.data.markdown).toContain("| **product_id** | `string`");
  });

  it("previewSegmentPayload returns Segment JSON for an event", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await previewSegmentPayload(ctx, {
      plan: "javascript",
      key: "Product Viewed",
    });
    if (!res.ok) throw new Error();
    expect(res.data.payload.key).toBe("Product Viewed");
    const schema = res.data.payload.jsonSchema as any;
    expect(schema.properties.properties.required).toContain("product_id");
  });

  it("previewSegmentPayload NOT_FOUND for missing event", async () => {
    const ctx = resolveContext({ REPO_PATH: makeRepo() });
    const res = await previewSegmentPayload(ctx, {
      plan: "javascript",
      key: "Bogus",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.error.code).toBe("NOT_FOUND");
  });
});
