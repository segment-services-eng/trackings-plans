import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ServerContext } from "../context.js";
import {
  listPlans,
  listPlansInput,
  listEvents,
  listEventsInput,
  getEvent,
  getEventInput,
  diffPlans,
  diffPlansInput,
  findPropertyUsage,
  findPropertyUsageInput,
  listRecentChanges,
  listRecentChangesInput,
} from "./read.js";
import {
  validateEvent,
  validateEventInput,
  validatePlan,
  validatePlanInput,
  lintRules,
  lintRulesInput,
} from "./validate.js";
import {
  previewMarkdown,
  previewMarkdownInput,
  previewSegmentPayload,
  previewSegmentPayloadInput,
} from "./preview.js";
import {
  addEvent,
  addEventInput,
  updateEvent,
  updateEventInput,
  removeEvent,
  removeEventInput,
} from "./author.js";
import {
  bulkRenameProperty,
  bulkRenamePropertyInput,
  bulkAddProperty,
  bulkAddPropertyInput,
} from "./bulk.js";

type Handler = (ctx: ServerContext, args: any) => Promise<unknown>;

interface ToolDef {
  name: string;
  description: string;
  schema: any;
  handler: Handler;
}

function makeTool<S extends { parse: (v: unknown) => any }>(
  name: string,
  description: string,
  schema: S,
  handler: (ctx: ServerContext, args: any) => Promise<unknown>,
): ToolDef {
  return {
    name,
    description,
    schema,
    handler: async (ctx, args) => handler(ctx, schema.parse(args ?? {})),
  };
}

export function registerTools(server: Server, ctx: ServerContext): string[] {
  const tools: ToolDef[] = [
    makeTool("list_plans", "List all configured tracking plans.", listPlansInput, listPlans),
    makeTool(
      "list_events",
      "List events in a plan snapshot. Supports filter (regex), missing_description, has_property.",
      listEventsInput,
      listEvents,
    ),
    makeTool(
      "get_event",
      "Get a single event's full definition (yaml shape) from a plan snapshot.",
      getEventInput,
      getEvent,
    ),
    makeTool(
      "diff_plans",
      "Semantic diff between two (plan, env) pairs — added/removed/modified events.",
      diffPlansInput,
      diffPlans,
    ),
    makeTool(
      "find_property_usage",
      "List every event that uses a given property. If plan is omitted, searches all plans.",
      findPropertyUsageInput,
      findPropertyUsage,
    ),
    makeTool(
      "list_recent_changes",
      "Git log for tracking-rules/<plan>/ over the last N commits (default 20).",
      listRecentChangesInput,
      listRecentChanges,
    ),
    makeTool(
      "validate_event",
      "Validate a single event's schema, types, and required descriptions.",
      validateEventInput,
      validateEvent,
    ),
    makeTool(
      "validate_plan",
      "Validate all events in a plan snapshot; returns findings and a severity summary.",
      validatePlanInput,
      validatePlan,
    ),
    makeTool(
      "lint_rules",
      "Deep lint of a plan: schema errors, warnings, and orphan events between yaml and snapshot.",
      lintRulesInput,
      lintRules,
    ),
    makeTool(
      "preview_markdown",
      "Render the markdown data dictionary from local YAML (or snapshot). Returns markdown + diff vs committed docs/<plan>.md.",
      previewMarkdownInput,
      previewMarkdown,
    ),
    makeTool(
      "preview_segment_payload",
      "Show the exact Segment JSON payload for one event based on local YAML. Never touches Segment.",
      previewSegmentPayloadInput,
      previewSegmentPayload,
    ),
    makeTool(
      "add_event",
      "Add a new event to a tracking plan by writing a YAML rule file (files mode).",
      addEventInput,
      addEvent,
    ),
    makeTool(
      "update_event",
      "Update an existing event's description or properties in a tracking plan (files mode).",
      updateEventInput,
      updateEvent,
    ),
    makeTool(
      "remove_event",
      "Remove an event from a tracking plan by deleting its YAML rule file (files mode). Requires confirm: true.",
      removeEventInput,
      removeEvent,
    ),
    makeTool(
      "bulk_rename_property",
      "Rename a property across every event in a plan. Default dry_run: true — must explicitly set false to execute.",
      bulkRenamePropertyInput,
      bulkRenameProperty,
    ),
    makeTool(
      "bulk_add_property",
      "Add a property to every event matching an optional filter. Default dry_run: true.",
      bulkAddPropertyInput,
      bulkAddProperty,
    ),
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
    const result = await tool.handler(ctx, req.params.arguments);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  });

  return tools.map((t) => t.name);
}
