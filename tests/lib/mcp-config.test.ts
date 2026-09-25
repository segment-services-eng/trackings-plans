import { describe, it, expect } from "vitest";
import {
  parseMcpConfig,
  resolveWriteModeSetting,
  McpConfigError,
  MCP_CONFIG_FILENAME,
} from "../../lib/mcp-config.js";

describe("lib/mcp-config parseMcpConfig", () => {
  it("exposes the canonical filename", () => {
    expect(MCP_CONFIG_FILENAME).toBe(".tracking-plans-mcp.json");
  });

  it("parses a valid file with write_mode", () => {
    expect(parseMcpConfig('{"write_mode":"files"}', "x.json")).toEqual({
      write_mode: "files",
    });
  });

  it("accepts an empty object and $schema", () => {
    expect(parseMcpConfig("{}", "x.json")).toEqual({});
    expect(parseMcpConfig('{"$schema":"./s.json"}', "x.json")).toEqual({
      $schema: "./s.json",
    });
  });

  it("throws CONFIG error on invalid JSON, naming the file", () => {
    try {
      parseMcpConfig("{not json", "/repo/.tracking-plans-mcp.json");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(McpConfigError);
      expect((e as McpConfigError).code).toBe("CONFIG");
      expect((e as Error).message).toContain("/repo/.tracking-plans-mcp.json");
      expect((e as Error).message).toMatch(/JSON/);
    }
  });

  it("throws CONFIG error when the top level is not an object", () => {
    expect(() => parseMcpConfig("[]", "x.json")).toThrow(McpConfigError);
    expect(() => parseMcpConfig('"files"', "x.json")).toThrow(McpConfigError);
  });

  it("throws CONFIG error on invalid write_mode, listing allowed values", () => {
    expect(() => parseMcpConfig('{"write_mode":"yolo"}', "x.json")).toThrow(
      /write_mode.*(files|branch|pr)/s,
    );
  });

  it("throws CONFIG error on unknown keys", () => {
    expect(() => parseMcpConfig('{"writeMode":"files"}', "x.json")).toThrow(
      /writeMode/,
    );
  });

  it("rejects secret-like keys without echoing their values", () => {
    const raw = JSON.stringify({
      write_mode: "files",
      SEGMENT_PUBLIC_API_TOKEN: "sgp_supersecretvalue1234567890",
    });
    try {
      parseMcpConfig(raw, "x.json");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(McpConfigError);
      const msg = (e as Error).message;
      expect(msg).toContain("SEGMENT_PUBLIC_API_TOKEN");
      expect(msg).toMatch(/secret/i);
      expect(msg).not.toContain("sgp_supersecretvalue1234567890");
    }
  });

  it("rejects plan-id keys and plan-id-looking values", () => {
    expect(() =>
      parseMcpConfig('{"DEV_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT":"rs_abc"}', "x.json"),
    ).toThrow(/secret/i);
    expect(() => parseMcpConfig('{"nested":{"id":"rs_2abcDEF123"}}', "x.json")).toThrow(
      /secret/i,
    );
  });

  it("rejects token-looking values under innocent keys", () => {
    expect(() =>
      parseMcpConfig('{"note":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}', "x.json"),
    ).toThrow(/secret/i);
  });
});

describe("lib/mcp-config resolveWriteModeSetting", () => {
  it("defaults to branch with no env and no file", () => {
    expect(resolveWriteModeSetting({ env: {}, file: undefined })).toEqual({
      mode: "branch",
      source: "default",
    });
  });

  it("file overrides default", () => {
    expect(
      resolveWriteModeSetting({ env: {}, file: { write_mode: "files" } }),
    ).toEqual({ mode: "files", source: "file" });
  });

  it("env overrides file", () => {
    expect(
      resolveWriteModeSetting({
        env: { MCP_WRITE_MODE: "pr" },
        file: { write_mode: "files" },
      }),
    ).toEqual({ mode: "pr", source: "env" });
  });

  it("invalid env value falls through to file", () => {
    expect(
      resolveWriteModeSetting({
        env: { MCP_WRITE_MODE: "bogus" },
        file: { write_mode: "files" },
      }),
    ).toEqual({ mode: "files", source: "file" });
  });
});
