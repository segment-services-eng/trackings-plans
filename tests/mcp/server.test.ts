import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContext, createServer } from "../../mcp/server.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tp-mcp-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    join(dir, "config", "tracking-plans-config.json"),
    JSON.stringify({
      plans: [
        {
          name: "JavaScript",
          path: "javascript",
          dev_secret: "DEV_JS",
          prod_secret: "PROD_JS",
        },
      ],
    }),
  );
  return dir;
}

describe("mcp/server", () => {
  it("resolveContext reads REPO_PATH from env or falls back to CWD", () => {
    const repo = makeRepo();
    const ctx = resolveContext({ REPO_PATH: repo });
    expect(ctx.repoPath).toBe(repo);
  });

  it("resolveContext holds no Segment credentials or client", () => {
    const repo = makeRepo();
    const ctx: any = resolveContext({ REPO_PATH: repo, SEGMENT_PUBLIC_API_TOKEN: "sgp_x", DEV_JS: "rs_abc" });
    expect(ctx.segmentApiKey).toBeUndefined();
    expect(ctx.segmentClient).toBeUndefined();
    expect(ctx.planIdEnv).toBeUndefined();
  });

  it("createServer registers at least one tool", () => {
    const repo = makeRepo();
    const ctx = resolveContext({ REPO_PATH: repo });
    const server = createServer(ctx);
    // server.listTools() is not on the low-level Server class (SDK v1.30.0).
    // createServer augments the Server instance with listRegisteredToolNames().
    expect(server.listRegisteredToolNames().length).toBeGreaterThan(0);
  });
});

describe("mcp/server tools/list", () => {
  it("lists the M4 workflow tools and not the removed M3 Segment tools", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createServer(resolveContext({ REPO_PATH: makeRepo() }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["deploy_dev", "reset_dev", "check_prod_drift", "get_workflow_run"]) {
      expect(names).toContain(n);
      expect(tools.find((t) => t.name === n)!.description).toContain("GitHub Actions");
    }
    expect(names).not.toContain("reset_dev_from_prod");
    expect(names).not.toContain("pull_from_segment");
  });
});

describe("mcp/server response redaction", () => {
  const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

  async function connect(env: Record<string, string>, planName: string) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const dir = mkdtempSync(join(tmpdir(), "tp-mcp-redact-"));
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(
      join(dir, "config", "tracking-plans-config.json"),
      JSON.stringify({
        plans: [{ name: planName, path: "javascript", dev_secret: "D", prod_secret: "P" }],
      }),
    );
    const server = createServer(resolveContext({ REPO_PATH: dir, ...env }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it("redacts the configured SEGMENT_PUBLIC_API_TOKEN value from tool results", async () => {
    const secret = "custom-segment-token-value";
    const client = await connect({ SEGMENT_PUBLIC_API_TOKEN: secret }, secret);
    const res: any = await client.callTool({ name: "list_plans", arguments: {} });
    const text = res.content[0].text as string;
    expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED]");
  });

  it("redacts token patterns from tool results even when not in env", async () => {
    const client = await connect({}, `Plan ${TOKEN}`);
    const res: any = await client.callTool({ name: "list_plans", arguments: {} });
    expect(res.content[0].text).not.toContain(TOKEN);
  });

  it("redacts tokens from thrown tool errors", async () => {
    const client = await connect({ GITHUB_TOKEN: TOKEN }, "JavaScript");
    let message = "";
    try {
      const res: any = await client.callTool({
        name: "list_plans",
        arguments: { [TOKEN]: 1 },
      });
      message = JSON.stringify(res);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(TOKEN);
  });
});
