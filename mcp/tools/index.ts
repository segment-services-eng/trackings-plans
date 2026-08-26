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
} from "./read.js";

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
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema, { target: "openApi3" }),
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
