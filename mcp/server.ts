// TODO(M2+): migrate from deprecated low-level Server to McpServer.
// When we do, drop the zod-to-json-schema dep — McpServer.tool() accepts zod directly.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveContext, ServerContext } from "./context.js";
import { registerTools } from "./tools/index.js";
import { runStartupSecretsLint } from "./secrets-lint.js";
import { knownSecretsFromEnv, redactSecrets } from "../lib/secrets.js";

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

/**
 * Logs to stderr only (stdout is the MCP stdio transport), with secret values
 * from `env` and token-shaped strings redacted.
 */
export function logToStderr(
  message: unknown,
  env: Record<string, string | undefined> = process.env,
): void {
  const text =
    message instanceof Error ? (message.stack ?? message.message) : String(message);
  process.stderr.write(`${redactSecrets(text, knownSecretsFromEnv(env))}\n`);
}

export async function main(): Promise<void> {
  const env = process.env;
  // Lint runs before resolveContext so warnings surface even if config is invalid.
  const repoPath = env.REPO_PATH ?? process.cwd();
  for (const w of runStartupSecretsLint(repoPath, env)) {
    logToStderr(`tracking-plans-mcp: WARNING: ${w}`, env);
  }
  const ctx = resolveContext(env);
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logToStderr(
    `tracking-plans-mcp started (repo=${ctx.repoPath}, plans=${ctx.plans.map((p) => p.path).join(",")})`,
    env,
  );
}
