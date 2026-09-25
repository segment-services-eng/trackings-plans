import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPlansConfig,
  resolvePlan,
  getPlanIdEnvVar,
} from "../../lib/plans-config.js";

function makeRepo(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "tp-test-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    join(dir, "config", "tracking-plans-config.json"),
    JSON.stringify(config),
  );
  return dir;
}

describe("plans-config", () => {
  const sample = {
    plans: [
      { name: "JavaScript", path: "javascript", dev_secret: "DEV_JS", prod_secret: "PROD_JS" },
      { name: "Server", path: "server", dev_secret: "DEV_SRV", prod_secret: "PROD_SRV" },
    ],
  };

  it("loads plans from config file", () => {
    const repo = makeRepo(sample);
    const plans = loadPlansConfig(repo);
    expect(plans).toHaveLength(2);
    expect(plans[0].name).toBe("JavaScript");
  });

  it("resolves plan by name case-insensitively", () => {
    const plans = loadPlansConfig(makeRepo(sample));
    expect(resolvePlan(plans, "javascript").name).toBe("JavaScript");
    expect(resolvePlan(plans, "JAVASCRIPT").name).toBe("JavaScript");
  });

  it("resolves plan by path", () => {
    const plans = loadPlansConfig(makeRepo(sample));
    expect(resolvePlan(plans, "server").name).toBe("Server");
  });

  it("throws NOT_FOUND when no match", () => {
    const plans = loadPlansConfig(makeRepo(sample));
    expect(() => resolvePlan(plans, "nonexistent")).toThrow(/not found/i);
  });

  it("returns correct env var name for dev vs prod", () => {
    const plans = loadPlansConfig(makeRepo(sample));
    expect(getPlanIdEnvVar(plans[0], "dev")).toBe("DEV_JS");
    expect(getPlanIdEnvVar(plans[0], "prod")).toBe("PROD_JS");
  });
});
