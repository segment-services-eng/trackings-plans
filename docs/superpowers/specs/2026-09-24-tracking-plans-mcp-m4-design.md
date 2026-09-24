# Tracking Plans MCP — Milestone 4 Design (agent-era workflows)

Status: approved 2026-09-24. Supersedes the M3 Segment-calling admin tools.

## Goals

- The MCP holds **no Segment token**. Every Segment API call runs in GitHub Actions.
- One agent session produces **one branch / one PR**, not one per edit.
- Prod writes gated by a GitHub `production` Environment with required reviewers.
- Shared Dev plan deploys are explicit (PR label or dispatch), serialized, and never commit back to feature branches.
- Git host access sits behind one small `ForgeClient` seam (GitHub only for now); default branch is configurable.

## 1. Responsibilities

| Layer | Owns | Credentials |
|---|---|---|
| MCP (local) | YAML edits, validate, preview, git branch/commit/push, PRs, dispatching workflows, reading committed state | User's GitHub auth only (`gh` or `GITHUB_TOKEN`) |
| GitHub Actions | All Segment calls: dev deploy, prod deploy, reset dev, nightly prod drift | `SEGMENT_PUBLIC_API_TOKEN` + plan-ID secrets; prod job in `production` Environment |
| Git (default branch) | Source of truth: `tracking-rules/**`, prod snapshot, generated docs | — |

Read tools: `env: "dev"` reads `tracking-rules/**` YAML from the current checkout; `env: "prod"` reads the committed prod snapshot. Results state which source was used. `plans/dev/**` is removed from the repo.

## 2. Workflows

| Workflow | Trigger | Does | Commits |
|---|---|---|---|
| `deploy-dev.yml` (replaces `update-dev-tracking-plans.yml`) | PR labeled `deploy-dev` (on label + subsequent pushes) or `workflow_dispatch` | YAML → Segment JSON → patch Dev; sticky PR comment | No |
| `deploy-prod.yml` (replaces `update-prod-tracking-plans.yml`) | push to default branch touching `tracking-rules/**` | `production` Environment; patch prod, save prod snapshot, render docs | Yes (snapshot + docs) |
| `reset-dev.yml` (converted) | `workflow_dispatch` | Reset Dev from the prod snapshot on the default branch | No |
| `prod-drift.yml` (new) | nightly cron + `workflow_dispatch` | Fetch prod; if it differs from the committed snapshot, open/update one PR on `tp/drift/prod` describing drift vs YAML | Via that PR |
| `generate-markdown.yml`, `initialize.yml` | converted to `workflow_dispatch` | unchanged | as today |

Common: deploy/reset share `concurrency: segment-<env>-<plan>`, `cancel-in-progress: false`. Every workflow uploads a `result` artifact containing `result.json` and writes a job summary.

### Dispatch contract (MCP ↔ workflows)

All dispatchable workflows accept these `workflow_dispatch` inputs (strings):

| Input | Workflows | Meaning |
|---|---|---|
| `request_id` | all | Opaque id from the MCP. Workflow sets `run-name: "<name> [${{ inputs.request_id }}]"` |
| `plan` | deploy-dev, reset-dev | Plan `path` (e.g. `javascript`) or `all` |
| `ref` | deploy-dev | Branch whose YAML to deploy |

The MCP always dispatches on the default branch (`ref` of the dispatch API = default branch); `deploy-dev` checks out `inputs.ref`.

`result.json` shape: `{ "ok": boolean, "workflow": string, "plans": [{ "plan": string, "env": "dev"|"prod", "rules_patched"?: number, "rules_deleted"?: number, "drift"?: unknown }], "errors"?: string[] }`.

One-time setup (README): create `production` Environment with reviewers; create `deploy-dev` label; allow Actions bot to push to a protected default branch.

## 3. MCP changes

### 3.1 Session branches

Write tools (`add_event`, `update_event`, `remove_event`, `bulk_rename_property`, `bulk_add_property`) accept optional `branch`.

- Omitted: unchanged — create `tp/<plan>/<verb>-<slug>-<ts>` off the default branch.
- Provided: check out the existing branch, apply, commit, restore the original branch. `pr` mode pushes; if an open PR exists for that branch (`forge.findOpenPullRequest`) return it instead of opening a new one.
- Refuse the default branch and nonexistent branches (`VALIDATION`). Non-fast-forward push → `GIT` with remediation to pull; never force-push. Dirty-tree rule unchanged. `files` mode ignores `branch` with a warning.

### 3.2 Workflow tools (replace M3 `reset_dev_from_prod`, `pull_from_segment`)

| Tool | Input | Workflow |
|---|---|---|
| `deploy_dev` | `{ plan?, branch, wait_seconds? }` | `deploy-dev.yml` (pushes `branch` first if it has no upstream / is ahead) |
| `reset_dev` | `{ plan?, confirm, wait_seconds? }` (`confirm: true` required) | `reset-dev.yml` |
| `check_prod_drift` | `{ wait_seconds? }` | `prod-drift.yml` |
| `get_workflow_run` | `{ run_id? , request_id?, workflow?, wait_seconds? }` | — |

Triggers return `{ request_id, workflow, run_id?, run_url?, status }`. `wait_seconds` default 0, max 45; on timeout return `status: "in_progress"` (not an error). New error code `WORKFLOW` (dispatch rejected or run concluded non-success; includes `run_url` and `result`).

### 3.3 ForgeClient (`lib/forge.ts`)

```ts
interface ForgeClient {
  findOpenPullRequest(branch: string): Promise<PullRequest | null>;
  openPullRequest(p: { branch: string; base: string; title: string; body: string }): Promise<PullRequest>;
  dispatchWorkflow(p: { workflow: string; ref: string; inputs: Record<string, string> }): Promise<void>;
  findRunByRequestId(workflow: string, requestId: string): Promise<WorkflowRun | null>;
  getRun(runId: number): Promise<WorkflowRun>;
  getRunResult(runId: number): Promise<unknown | null>;
}
```

GitHub impl: `gh` CLI first, Octokit + `GITHUB_TOKEN` fallback. Injected via `ctx.forge` so tests use a fake. PR code moves out of `lib/git-ops.ts`.

### 3.4 Config

`.tracking-plans-mcp.json` adds `default_branch` (default `"main"`) and `forge` (`"github"` only). `ctx.defaultBranch` replaces hardcoded `main`. Remove `SEGMENT_PUBLIC_API_TOKEN` / plan-ID env and `segmentClient` from the MCP context. Redaction + startup lint remain.

## Build order

1. MCP: session branches (3.1) and workflow tools + ForgeClient (3.2, 3.3) — tested against a fake forge.
2. Workflows (Section 2) implementing the dispatch contract.
3. Read-tool `env: "dev"` → YAML, remove `plans/dev/**`, README/migration notes.

## Testing

Unit tests with a fake `ForgeClient`; temp git repos (with bare `origin`) for branch reuse and push rejection. Workflow YAML validated with js-yaml; `actionlint` if available. No calls to real GitHub or Segment in tests.
