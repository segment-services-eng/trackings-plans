// TODO(M2+): migrate from deprecated low-level Server to McpServer.
// When we do, drop the zod-to-json-schema dep — McpServer.tool() accepts zod directly.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveContext, ServerContext } from "./context.js";
import { registerTools } from "./tools/index.js";

export { resolveContext } from "./context.js";

export type ManagedServer = Server & {
  listRegisteredToolNames: () => string[];
};

export function createServer(ctx: ServerContext): ManagedServer {
  const server = new Server(
    { name: "tracking-plans-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  ) as ManagedServer;

  const toolNames = registerTools(server, ctx);
  server.listRegisteredToolNames = () => toolNames;

  return server;
}

export async function main(): Promise<void> {
  const ctx = resolveContext();
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `tracking-plans-mcp started (repo=${ctx.repoPath}, plans=${ctx.plans.map((p) => p.path).join(",")})`,
  );
}
