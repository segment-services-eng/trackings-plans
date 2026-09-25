/**
 * Git-host ("forge") seam. Everything that talks to GitHub (PRs, workflow
 * dispatch, run status, run artifacts) goes through this interface so tools
 * can be tested with a fake and other hosts can be added later.
 *
 * Implementations: GitHub (`lib/forge-github.ts`), fake (`tests/helpers/fake-forge.ts`).
 */

export type ForgeKind = "github";

export interface PullRequest {
  number: number;
  url: string;
  branch: string;
  base: string;
}

export type WorkflowRunStatus = "queued" | "in_progress" | "completed";

export interface WorkflowRun {
  id: number;
  workflow: string;
  url: string;
  status: WorkflowRunStatus;
  /** Set when status is "completed" (e.g. "success", "failure", "cancelled"). */
  conclusion?: string;
  /** The run-name, which embeds the MCP request_id. */
  name: string;
}

export interface ForgeClient {
  readonly kind: ForgeKind;
  findOpenPullRequest(branch: string): Promise<PullRequest | null>;
  openPullRequest(p: {
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest>;
  addLabels(prNumber: number, labels: string[]): Promise<void>;
  dispatchWorkflow(p: {
    workflow: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<void>;
  findRunByRequestId(workflow: string, requestId: string): Promise<WorkflowRun | null>;
  getRun(runId: number): Promise<WorkflowRun>;
  /** Parsed result.json from the run's `result` artifact, or null if absent. */
  getRunResult(runId: number): Promise<unknown | null>;
}

export type ForgeErrorCode = "GH_CLI" | "GITHUB_API";

export class ForgeError extends Error {
  constructor(
    readonly code: ForgeErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ForgeError";
    Object.setPrototypeOf(this, ForgeError.prototype);
  }
}
