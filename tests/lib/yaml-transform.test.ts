import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  yamlToRule,
  ruleToYaml,
  loadYamlRuleFile,
  writeYamlRuleFile,
  type YamlRule,
} from "../../lib/yaml-transform.js";
import type { Rule } from "../../lib/segment-api.js";

const sampleYaml: YamlRule = {
  key: "Product Viewed",
  type: "TRACK",
  version: 1,
  description: "Fired when a product is viewed",
  labels: { pii: "false" },
  properties: {
    product_id: { type: "string", description: "the product id", required: true },
    price: { type: "number", description: "the price" },
  },
};

describe("yaml-transform", () => {
  it("yamlToRule places required fields under jsonSchema.properties.properties.required", () => {
    const rule = yamlToRule(sampleYaml);
    expect(rule.key).toBe("Product Viewed");
    const schema = rule.jsonSchema as Record<string, any>;
    expect(schema.properties.properties.required).toEqual(["product_id"]);
    expect(schema.properties.properties.properties.product_id.required).toBeUndefined();
    expect(schema.description).toBe("Fired when a product is viewed");
    expect(schema.labels).toEqual({ pii: "false" });
  });

  it("yamlToRule omits description key when yaml description is empty string", () => {
    const rule = yamlToRule({ ...sampleYaml, description: "" });
    const schema = rule.jsonSchema as Record<string, any>;
    expect(schema.description).toBeUndefined();
  });

  it("ruleToYaml extracts labels and puts required back on properties", () => {
    const rule = yamlToRule(sampleYaml);
    const back = ruleToYaml(rule);
    expect(back.key).toBe("Product Viewed");
    expect(back.properties.product_id.required).toBe(true);
    expect(back.properties.price.required).toBeUndefined();
    expect(back.labels).toEqual({ pii: "false" });
  });

  it("round-trips yaml -> rule -> yaml preserving semantic content", () => {
    const rule = yamlToRule(sampleYaml);
    const back = ruleToYaml(rule);
    expect(back.key).toBe(sampleYaml.key);
    expect(back.type).toBe(sampleYaml.type);
    expect(back.version).toBe(sampleYaml.version);
    expect(back.properties.product_id.type).toBe("string");
    expect(back.properties.product_id.required).toBe(true);
  });

  it("loadYamlRuleFile and writeYamlRuleFile round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-yaml-"));
    const filePath = join(dir, "product_viewed.yml");
    writeYamlRuleFile(filePath, sampleYaml);
    const loaded = loadYamlRuleFile(filePath);
    expect(loaded.key).toBe("Product Viewed");
    expect(loaded.properties.product_id.required).toBe(true);
    // File must have the {rules: [...]} shape used by existing tooling
    const raw = readFileSync(filePath, "utf8");
    expect(raw).toMatch(/^rules:/m);
  });
});
