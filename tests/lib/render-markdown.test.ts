import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../../lib/render-markdown.js";
import type { Rule } from "../../lib/segment-api.js";
import { yamlToRule } from "../../lib/yaml-transform.js";

const rule: Rule = yamlToRule({
  key: "Product Viewed",
  type: "TRACK",
  version: 1,
  description: "Fired when a product is viewed",
  properties: {
    product_id: { type: "string", description: "product id", required: true },
    price: { type: "number", description: "price" },
  },
});

describe("render-markdown", () => {
  it("renders title heading", () => {
    const md = renderMarkdown({ title: "JavaScript", rules: [rule] });
    expect(md).toMatch(/^# JavaScript/);
  });

  it("renders event heading with key", () => {
    const md = renderMarkdown({ title: "JavaScript", rules: [rule] });
    expect(md).toContain("## Product Viewed");
  });

  it("renders description", () => {
    const md = renderMarkdown({ title: "JavaScript", rules: [rule] });
    expect(md).toContain("Fired when a product is viewed");
  });

  it("renders properties table with required flag", () => {
    const md = renderMarkdown({ title: "JavaScript", rules: [rule] });
    expect(md).toContain("| **product_id** | `string` | product id | ✅ |");
    expect(md).toContain("| **price** | `number` | price | ❌ |");
  });

  it("renders analytics.track code snippet", () => {
    const md = renderMarkdown({ title: "JavaScript", rules: [rule] });
    expect(md).toContain('analytics.track("Product Viewed"');
  });

  it("handles rules with no properties gracefully", () => {
    const bareRule: Rule = {
      key: "App Opened",
      type: "TRACK",
      version: 1,
      jsonSchema: {},
    };
    const md = renderMarkdown({ title: "JavaScript", rules: [bareRule] });
    expect(md).toContain("## App Opened");
    expect(md).toContain("No description provided");
  });
});
