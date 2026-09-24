import type { ForgeClient } from "./forge.js";
import { ForgeError } from "./forge.js";

export interface GitHubForgeOptions {
  repoPath: string;
  /** GITHUB_TOKEN / GH_TOKEN for the Octokit fallback when `gh` is unavailable. */
  token?: string;
}

/**
 * GitHub ForgeClient: `gh` CLI first, Octokit + token fallback.
 * M4 foundation stub — methods are implemented in the M4 workflow-tools task.
 */
export function createGitHubForge(_opts: GitHubForgeOptions): ForgeClient {
  const notYet = (m: string) => async (): Promise<never> => {
    throw new ForgeError("GITHUB_API", `GitHub forge: ${m} not implemented yet`);
  };
  return {
    kind: "github",
    findOpenPullRequest: notYet("findOpenPullRequest"),
    openPullRequest: notYet("openPullRequest"),
    dispatchWorkflow: notYet("dispatchWorkflow"),
    findRunByRequestId: notYet("findRunByRequestId"),
    getRun: notYet("getRun"),
    getRunResult: notYet("getRunResult"),
  };
}
