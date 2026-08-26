import type { YamlRule, YamlProperty } from "./yaml-transform.js";

export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  code: string;
  path: string;
  message: string;
}

const VALID_TYPES = new Set(["TRACK", "IDENTIFY", "GROUP", "PAGE", "SCREEN"]);
const VALID_PROP_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
]);

function err(code: string, path: string, message: string): Finding {
  return { severity: "error", code, path, message };
}
function warn(code: string, path: string, message: string): Finding {
  return { severity: "warning", code, path, message };
}

function checkProperty(
  eventKey: string,
  propName: string,
  prop: YamlProperty,
): Finding[] {
  const path = `${eventKey}.properties.${propName}`;
  const out: Finding[] = [];
  if (!prop.type) {
    out.push(err("missing_property_type", path, `Property "${propName}" has no type`));
  } else if (!VALID_PROP_TYPES.has(prop.type)) {
    out.push(
      err(
        "invalid_property_type",
        path,
        `Property "${propName}" has invalid type "${prop.type}"`,
      ),
    );
  }
  if (!prop.description || !prop.description.trim()) {
    out.push(
      warn(
        "missing_property_description",
        path,
        `Property "${propName}" is missing a description`,
      ),
    );
  }
  if (prop.properties) {
    for (const [nested, nestedProp] of Object.entries(prop.properties)) {
      out.push(...checkProperty(eventKey, `${propName}.${nested}`, nestedProp));
    }
  }
  return out;
}

export function validateRule(rule: YamlRule): Finding[] {
  const path = rule.key || "<unknown>";
  const out: Finding[] = [];
  if (!rule.key || !rule.key.trim()) {
    out.push(err("missing_key", path, "Rule is missing a key"));
  }
  if (!rule.type || !VALID_TYPES.has(rule.type)) {
    out.push(
      err(
        "invalid_type",
        path,
        `Rule "${path}" has invalid type "${rule.type}" (allowed: ${[...VALID_TYPES].join(", ")})`,
      ),
    );
  }
  if (!Number.isInteger(rule.version) || rule.version <= 0) {
    out.push(
      err("invalid_version", path, `Rule "${path}" has invalid version "${rule.version}"`),
    );
  }
  if (!rule.description || !rule.description.trim()) {
    out.push(warn("missing_description", path, `Rule "${path}" is missing a description`));
  }
  for (const [name, prop] of Object.entries(rule.properties ?? {})) {
    out.push(...checkProperty(rule.key, name, prop));
  }
  return out;
}

export function validatePlan(rules: YamlRule[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    out.push(...validateRule(rule));
    if (rule.key) {
      if (seen.has(rule.key)) {
        out.push(
          err(
            "duplicate_event_key",
            rule.key,
            `Duplicate event key "${rule.key}" — event keys must be unique within a plan`,
          ),
        );
      }
      seen.add(rule.key);
    }
  }
  const propertyTypes = new Map<string, Set<string>>();
  for (const rule of rules) {
    for (const [name, prop] of Object.entries(rule.properties ?? {})) {
      if (!prop.type) continue;
      if (!propertyTypes.has(name)) propertyTypes.set(name, new Set());
      propertyTypes.get(name)!.add(prop.type);
    }
  }
  for (const [name, types] of propertyTypes) {
    if (types.size > 1) {
      out.push(
        warn(
          "inconsistent_property_type",
          name,
          `Property "${name}" is defined with different types across events: ${[...types].join(", ")}`,
        ),
      );
    }
  }
  return out;
}
