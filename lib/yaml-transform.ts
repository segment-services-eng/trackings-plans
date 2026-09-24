import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import yaml from "js-yaml";
import type { Rule } from "./segment-api.js";

export interface YamlProperty {
  type?: string;
  description?: string;
  required?: boolean;
  properties?: Record<string, YamlProperty>;
  items?: unknown;
  enum?: unknown[];
  [k: string]: unknown;
}

export interface YamlRule {
  key: string;
  type: string;
  version: number;
  description?: string;
  labels?: Record<string, string>;
  properties: Record<string, YamlProperty>;
}

interface FormattedProperties {
  properties: Record<string, Omit<YamlProperty, "required">>;
  required: string[];
}

function formatProperties(
  properties: Record<string, YamlProperty>,
): FormattedProperties {
  const out: Record<string, any> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const { required: req, properties: nested, ...rest } = value;
    out[key] = { ...rest };
    if (req === true) required.push(key);
    if (nested) {
      const nestedResult = formatProperties(nested);
      out[key].properties = nestedResult.properties;
      if (nestedResult.required.length > 0) {
        out[key].required = nestedResult.required;
      }
    }
  }
  return { properties: out, required };
}

export function yamlToRule(y: YamlRule): Rule {
  const { properties, required } = formatProperties(y.properties);
  const jsonSchema: Record<string, unknown> = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      context: { type: "object" },
      traits: { type: "object" },
      properties: {
        type: "object",
        properties,
        required: required.length > 0 ? required : undefined,
      },
    },
    required: ["properties"],
  };
  if (y.labels) jsonSchema.labels = y.labels;
  if (y.description && y.description.trim() !== "") {
    jsonSchema.description = y.description;
  }
  return {
    key: y.key,
    type: y.type,
    version: y.version,
    jsonSchema,
  };
}

function unformatProperties(
  properties: Record<string, any> | undefined,
  requiredFields: string[],
): Record<string, YamlProperty> {
  if (!properties) return {};
  const out: Record<string, YamlProperty> = {};
  for (const [key, value] of Object.entries(properties)) {
    const { properties: nested, required: nestedRequired, ...rest } = value;
    out[key] = { ...rest } as YamlProperty;
    if (requiredFields.includes(key)) out[key].required = true;
    if (nested) {
      out[key].properties = unformatProperties(nested, nestedRequired ?? []);
    }
  }
  return out;
}

export function ruleToYaml(rule: Rule): YamlRule {
  const schema = rule.jsonSchema as any;
  const labels = schema?.labels ?? undefined;
  const description = schema?.description ?? undefined;
  const props = schema?.properties?.properties?.properties ?? {};
  const required = schema?.properties?.properties?.required ?? [];
  const yamlRule: YamlRule = {
    key: rule.key,
    type: rule.type,
    version: rule.version,
    properties: unformatProperties(props, required),
  };
  if (description) yamlRule.description = description;
  if (labels) yamlRule.labels = labels;
  return yamlRule;
}

/** Parses one rule-file's YAML text; `source` names it in errors. */
export function parseYamlRule(raw: string, source: string): YamlRule {
  const parsed = yaml.load(raw) as { rules: YamlRule[] };
  if (!parsed?.rules?.[0]) {
    throw new Error(`Expected rules[0] in YAML file at ${source}`);
  }
  return parsed.rules[0];
}

export function loadYamlRuleFile(filePath: string): YamlRule {
  return parseYamlRule(readFileSync(filePath, "utf8"), filePath);
}

export function writeYamlRuleFile(filePath: string, yamlRule: YamlRule): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const content = yaml.dump({ rules: [yamlRule] }, { noRefs: true });
  writeFileSync(filePath, content, "utf8");
}
