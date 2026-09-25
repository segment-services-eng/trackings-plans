import { describe, it, expect } from "vitest";
import { validateRule, validatePlan } from "../../lib/validate.js";
import type { YamlRule } from "../../lib/yaml-transform.js";

const good: YamlRule = {
  key: "Product Viewed",
  type: "TRACK",
  version: 1,
  description: "Fired on view",
  properties: {
    product_id: { type: "string", description: "the id", required: true },
  },
};

describe("validateRule", () => {
  it("returns empty for a fully-valid rule", () => {
    expect(validateRule(good)).toEqual([]);
  });

  it("flags missing_key", () => {
    const f = validateRule({ ...good, key: "" });
    expect(f.map((x) => x.code)).toContain("missing_key");
  });

  it("flags invalid_type", () => {
    const f = validateRule({ ...good, type: "BOGUS" } as any);
    expect(f.map((x) => x.code)).toContain("invalid_type");
  });

  it("flags invalid_version", () => {
    const f = validateRule({ ...good, version: 0 } as any);
    expect(f.map((x) => x.code)).toContain("invalid_version");
  });

  it("warns on missing description", () => {
    const f = validateRule({ ...good, description: "  " });
    expect(f.find((x) => x.code === "missing_description")?.severity).toBe("warning");
  });

  it("errors on property missing type", () => {
    const f = validateRule({
      ...good,
      properties: { product_id: { description: "no type" } as any },
    });
    expect(f.map((x) => x.code)).toContain("missing_property_type");
  });

  it("errors on invalid property type", () => {
    const f = validateRule({
      ...good,
      properties: { product_id: { type: "banana" } as any },
    });
    expect(f.map((x) => x.code)).toContain("invalid_property_type");
  });

  it("warns on property missing description", () => {
    const f = validateRule({
      ...good,
      properties: { product_id: { type: "string" } },
    });
    expect(f.find((x) => x.code === "missing_property_description")?.severity).toBe("warning");
  });

  it("path is dotted event.properties.propname", () => {
    const f = validateRule({
      ...good,
      properties: { product_id: { type: "string" } },
    });
    expect(f.find((x) => x.code === "missing_property_description")?.path).toBe(
      "Product Viewed.properties.product_id",
    );
  });
});

describe("validatePlan", () => {
  it("flags duplicate_event_key", () => {
    const findings = validatePlan([good, { ...good }]);
    expect(findings.map((f) => f.code)).toContain("duplicate_event_key");
  });

  it("flags inconsistent_property_type across events", () => {
    const other: YamlRule = {
      key: "Order Completed",
      type: "TRACK",
      version: 1,
      description: "d",
      properties: {
        product_id: { type: "number", description: "d" },
      },
    };
    const findings = validatePlan([good, other]);
    expect(findings.find((f) => f.code === "inconsistent_property_type")?.severity).toBe(
      "warning",
    );
  });
});
