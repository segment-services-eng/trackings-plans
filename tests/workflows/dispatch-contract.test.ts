import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { load as parse } from "js-yaml";

const WORKFLOWS_DIR = join(__dirname, "..", "..", ".github", "workflows");

type WorkflowFile = { name: string; raw: string; doc: any };

function loadWorkflow(file: string): WorkflowFile {
  const raw = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
  return { name: file, raw, doc: parse(raw) };
}

function collectSteps(doc: any): any[] {
  const jobs = doc?.jobs ?? {};
  const steps: any[] = [];
  for (const jobName of Object.keys(jobs)) {
    const jobSteps = jobs[jobName]?.steps;
    if (Array.isArray(jobSteps)) steps.push(...jobSteps);
  }
  return steps;
}

// Every workflow the MCP can dispatch by request_id must honor the contract
// documented in docs/superpowers/specs/2026-09-24-tracking-plans-mcp-m4-design.md:
// (1) run-name embeds the request_id so the MCP can locate the run;
// (2) an artifact named "result" is uploaded on every outcome (if: always());
// (3) workflow_dispatch inputs include request_id: string, required.
const MCP_DISPATCHABLE = [
  "deploy-dev.yml",
  "deploy-prod.yml",
  "reset-dev.yml",
  "prod-drift.yml",
];

describe("MCP dispatchable workflow contract", () => {
  for (const file of MCP_DISPATCHABLE) {
    describe(file, () => {
      const wf = loadWorkflow(file);

      it("run-name embeds ${{ inputs.request_id ...", () => {
        const runName = wf.doc["run-name"];
        expect(typeof runName).toBe("string");
        // Tolerate any whitespace inside the expression.
        expect(runName).toMatch(/\$\{\{\s*inputs\.request_id/);
      });

      it("declares workflow_dispatch with required request_id string input", () => {
        // js-yaml 4.x is YAML 1.2 so "on" stays a string key; guard for the
        // 1.1 boolean interpretation too in case the parser default changes.
        const onNode = wf.doc.on ?? wf.doc["on"] ?? wf.doc[true as any];
        expect(onNode, "workflow needs an 'on:' trigger block").toBeTruthy();
        const dispatch = onNode.workflow_dispatch;
        expect(dispatch, "workflow_dispatch trigger is required").toBeTruthy();
        const requestId = dispatch.inputs?.request_id;
        expect(requestId, "request_id input is required").toBeTruthy();
        expect(requestId.required).toBe(true);
        expect(requestId.type).toBe("string");
      });

      it("uploads a 'result' artifact with if: always()", () => {
        const uploads = collectSteps(wf.doc).filter(
          (s) => typeof s?.uses === "string" && s.uses.startsWith("actions/upload-artifact@"),
        );
        const resultStep = uploads.find((s) => s.with?.name === "result");
        expect(resultStep, "must upload an artifact named 'result'").toBeTruthy();
        expect(resultStep!.if).toBe("always()");
      });
    });
  }
});
