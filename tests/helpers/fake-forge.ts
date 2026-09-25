import type {
  ForgeClient,
  PullRequest,
  WorkflowRun,
} from "../../lib/forge.js";

/** In-memory ForgeClient for tests. Inspect `calls`, seed `prs` / `runs` / `results`. */
export class FakeForge implements ForgeClient {
  readonly kind = "github" as const;
  prs: PullRequest[] = [];
  runs: WorkflowRun[] = [];
  results = new Map<number, unknown>();
  labels = new Map<number, string[]>();
  dispatches: { workflow: string; ref: string; inputs: Record<string, string> }[] = [];
  /** When set, dispatchWorkflow creates a queued run named `<workflow> [<request_id>]`. */
  autoCreateRuns = true;
  private nextId = 1000;

  async findOpenPullRequest(branch: string): Promise<PullRequest | null> {
    return this.prs.find((p) => p.branch === branch) ?? null;
  }

  async openPullRequest(p: {
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest> {
    const number = this.prs.length + 1;
    const pr = {
      number,
      url: `https://github.com/acme/tp/pull/${number}`,
      branch: p.branch,
      base: p.base,
    };
    this.prs.push(pr);
    return pr;
  }

  async addLabels(prNumber: number, labels: string[]): Promise<void> {
    const existing = this.labels.get(prNumber) ?? [];
    this.labels.set(prNumber, [...new Set([...existing, ...labels])]);
  }

  async dispatchWorkflow(p: {
    workflow: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<void> {
    this.dispatches.push(p);
    if (this.autoCreateRuns) {
      const id = this.nextId++;
      this.runs.push({
        id,
        workflow: p.workflow,
        url: `https://github.com/acme/tp/actions/runs/${id}`,
        status: "queued",
        name: `${p.workflow} [${p.inputs.request_id ?? ""}]`,
      });
    }
  }

  async findRunByRequestId(workflow: string, requestId: string): Promise<WorkflowRun | null> {
    return (
      this.runs.find((r) => r.workflow === workflow && r.name.includes(`[${requestId}]`)) ?? null
    );
  }

  async getRun(runId: number): Promise<WorkflowRun> {
    const run = this.runs.find((r) => r.id === runId);
    if (!run) throw new Error(`run ${runId} not found`);
    return run;
  }

  async getRunResult(runId: number): Promise<unknown | null> {
    return this.results.get(runId) ?? null;
  }

  /** Test helper: mark a run completed with a conclusion and optional result. */
  complete(runId: number, conclusion: string, result?: unknown): void {
    const run = this.runs.find((r) => r.id === runId);
    if (!run) throw new Error(`run ${runId} not found`);
    run.status = "completed";
    run.conclusion = conclusion;
    if (result !== undefined) this.results.set(runId, result);
  }
}
