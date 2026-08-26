import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerContext } from "../context.js";

const TOOLS = [
  {
    name: "ping",
    description:
      "Returns 'pong' with the configured repo path — sanity check.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
];

export function registerTools(server: Server, ctx: ServerContext): string[] {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (name === "ping") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, data: { pong: ctx.repoPath } }),
          },
        ],
      };
    }
    throw new Error(`Unknown tool: ${name}`);
  });

  return TOOLS.map((t) => t.name);
}
