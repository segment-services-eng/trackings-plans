import { describe, it, expect } from "vitest";
import {
  redactSecrets,
  knownSecretsFromEnv,
  lintSecrets,
  REDACTED,
} from "../../lib/secrets.js";

const SEG = "sgp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef";
const GHP = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

describe("lib/secrets redactSecrets", () => {
  it("redacts known secret values anywhere in a string", () => {
    const secret = "my-custom-segment-token-value";
    expect(redactSecrets(`token is ${secret}!`, [secret])).toBe(
      `token is ${REDACTED}!`,
    );
  });

  it("ignores empty / very short known secrets (avoid over-redaction)", () => {
    expect(redactSecrets("abc main", ["", "abc"])).toBe("abc main");
  });

  it("redacts Bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-123_XYZ", [])).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it("redacts GitHub token prefixes", () => {
    expect(redactSecrets(`x ${GHP} y`, [])).toBe(`x ${REDACTED} y`);
    expect(redactSecrets("gho_abcdefghijklmnopqrstuvwxyz0123", [])).toBe(REDACTED);
    expect(
      redactSecrets("github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", []),
    ).toBe(REDACTED);
  });

  it("redacts Segment public API tokens (sgp_)", () => {
    expect(redactSecrets(`key=${SEG}`, [])).toBe(`key=${REDACTED}`);
  });

  it("does not redact plan IDs, event names, or ordinary text", () => {
    const s = "rs_2abcDEF123 Product Viewed ghp_short tp/javascript/add-x-1712";
    expect(redactSecrets(s, [])).toBe(s);
  });

  it("deep-walks objects and arrays without mutating input", () => {
    const input = {
      ok: false,
      error: { message: `failed with ${SEG}`, details: [{ h: `Bearer ${GHP}` }, 42, null] },
      plan_id: "rs_abc123",
    };
    const out = redactSecrets(input, []) as any;
    expect(out.error.message).toBe(`failed with ${REDACTED}`);
    expect(out.error.details[0].h).toBe(`Bearer ${REDACTED}`);
    expect(out.error.details[1]).toBe(42);
    expect(out.error.details[2]).toBeNull();
    expect(out.plan_id).toBe("rs_abc123");
    expect(input.error.message).toContain(SEG);
  });

  it("serializes toJSON values (e.g. Date) like JSON.stringify", () => {
    const d = new Date("2026-01-02T03:04:05.000Z");
    expect(redactSecrets({ at: d }, [])).toEqual({ at: "2026-01-02T03:04:05.000Z" });
  });

  it("handles cyclic structures", () => {
    const a: any = { s: GHP };
    a.self = a;
    const out = redactSecrets(a, []) as any;
    expect(out.s).toBe(REDACTED);
  });

  it("escapes regex metacharacters in known secrets", () => {
    const secret = "a.b*c+d?e(f)g[h]";
    expect(redactSecrets(`x${secret}y axbxcxd`, [secret])).toBe(`x${REDACTED}y axbxcxd`);
  });
});

describe("lib/secrets knownSecretsFromEnv", () => {
  it("returns set token values from env", () => {
    expect(
      knownSecretsFromEnv({
        SEGMENT_PUBLIC_API_TOKEN: "seg-value-123",
        GITHUB_TOKEN: "gh-value-456",
        GH_TOKEN: undefined,
        OTHER: "x",
      }).sort(),
    ).toEqual(["gh-value-456", "seg-value-123"]);
  });
});

describe("lib/secrets lintSecrets", () => {
  it("returns no warnings for a clean setup", () => {
    expect(
      lintSecrets({
        envFiles: [
          { path: ".env", contents: `SEGMENT_PUBLIC_API_TOKEN=${SEG}\n`, gitStatus: "ignored" },
        ],
        mcpConfigRaw: '{"write_mode":"files"}',
        knownSecrets: [SEG],
      }),
    ).toEqual([]);
  });

  it("warns when a .env with the token is tracked by git", () => {
    const w = lintSecrets({
      envFiles: [
        { path: ".env", contents: `SEGMENT_PUBLIC_API_TOKEN=${SEG}\n`, gitStatus: "tracked" },
      ],
      knownSecrets: [],
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/\.env/);
    expect(w[0]).toMatch(/tracked|committed/i);
    expect(w[0]).toContain("SEGMENT_PUBLIC_API_TOKEN");
    expect(w[0]).not.toContain(SEG);
  });

  it("warns when a .env with a token is untracked but not gitignored", () => {
    const w = lintSecrets({
      envFiles: [
        { path: ".env.local", contents: `export GITHUB_TOKEN="${GHP}"\n`, gitStatus: "untracked" },
      ],
      knownSecrets: [],
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/gitignore/i);
    expect(w[0]).not.toContain(GHP);
  });

  it("does not warn for .env files where the token key is empty or commented out", () => {
    expect(
      lintSecrets({
        envFiles: [
          {
            path: ".env",
            contents: "# SEGMENT_PUBLIC_API_TOKEN=xyz\nSEGMENT_PUBLIC_API_TOKEN=\n",
            gitStatus: "tracked",
          },
        ],
        knownSecrets: [],
      }),
    ).toEqual([]);
  });

  it("warns when the project config contains a known secret or token pattern", () => {
    const known = "custom-seg-token-abcdef";
    const w1 = lintSecrets({
      envFiles: [],
      mcpConfigRaw: `{"note":"${known}"}`,
      knownSecrets: [known],
    });
    expect(w1).toHaveLength(1);
    expect(w1[0]).toContain(".tracking-plans-mcp.json");
    expect(w1[0]).not.toContain(known);

    const w2 = lintSecrets({
      envFiles: [],
      mcpConfigRaw: `{"SEGMENT_PUBLIC_API_TOKEN":"${SEG}"}`,
      knownSecrets: [],
    });
    expect(w2).toHaveLength(1);
    expect(w2[0]).not.toContain(SEG);
  });
});
