import type { Rule } from "./segment-api.js";

export interface RenderMarkdownOptions {
  title: string;
  rules: Rule[];
}

type Props = Record<string, any>;

function processProperties(
  properties: Props,
  requiredFields: string[],
  parentObj: Record<string, unknown>,
  parentKey: string,
  lines: string[],
): void {
  for (const propName in properties) {
    const propData = properties[propName] ?? {};
    const propType: string = propData.type ?? "unknown";
    const propDescription: string = propData.description ?? "No description";
    const isRequired = requiredFields.includes(propName);
    const requiredText = isRequired ? "✅" : "❌";
    const propFullName = parentKey ? `${parentKey}.${propName}` : propName;

    if (propType === "array" && propData.items?.properties) {
      lines.push(
        `| **${propFullName}** | \`array\` | ${propDescription} | ❌ |`,
      );
      lines.push(
        `| **${propFullName}.items** | \`object\` | Contains the structure for array items | ❌ |`,
      );
      parentObj[propName] = [{}];
      processProperties(
        propData.items.properties,
        [],
        (parentObj[propName] as [Record<string, unknown>])[0],
        `${propFullName}.items`,
        lines,
      );
    } else {
      lines.push(
        `| **${propFullName}** | \`${propType}\` | ${propDescription} | ${requiredText} |`,
      );
      parentObj[propName] = `<<type: ${propType}, required: ${isRequired}>>`;
      if (propType === "object" && propData.properties) {
        parentObj[propName] = {};
        processProperties(
          propData.properties,
          propData.required ?? [],
          parentObj[propName] as Record<string, unknown>,
          propFullName,
          lines,
        );
      }
    }
  }
}

export function renderMarkdown(opts: RenderMarkdownOptions): string {
  const { title, rules } = opts;
  const out: string[] = [`# ${title}\n`];

  for (const event of rules) {
    const schema = event.jsonSchema as any;
    const section: string[] = [];
    section.push(`\n## ${event.key}\n`);
    section.push("<!-- tabs:start -->");
    section.push("### **Details**\n");
    section.push("#### **Description**\n");
    section.push(schema?.description ?? "No description provided");
    section.push("#### **Properties**\n");
    section.push("| **Name** | `Type` | Description | Required? |");
    section.push("| :--- | :--- | :--- | :--- |");

    const jsSnippet: Record<string, unknown> = {};
    const props = schema?.properties?.properties?.properties;
    if (props) {
      processProperties(
        props,
        schema?.properties?.properties?.required ?? [],
        jsSnippet,
        "",
        section,
      );
    }

    section.push("#### **JS**\n");
    section.push("```javascript");
    section.push(
      `analytics.track("${event.key}", ${JSON.stringify(jsSnippet, null, 2)})`,
    );
    section.push("```" + "\n");
    section.push("<!-- tabs:end -->" + "\n");
    section.push("<!-- panels:end -->" + "\n");

    out.push(...section);
  }
  return out.join("\n");
}
