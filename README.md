# 📌 Segment Tracking Plans Automation 🚀  

*A repository demonstrating the power of GitHub Workflows for automated Segment Tracking Plan management.*

![Tracking Plans Automation](https://github.com/user-attachments/assets/83d617e5-8f52-40b1-afd8-956010b4d662)

---

## 📖 Table of Contents  

- [🔧 Setup Instructions](#-setup-instructions)  
- [⚙️ How It Works](#️-how-it-works)  
  - [Step 1: Updating Dev Tracking Plan](#step-1-updating-dev-tracking-plan)  
  - [Step 2: Merging to Main & Updating Prod](#step-2-merging-to-main--updating-prod)  
- [🔹 Advanced Features](#-advanced-features)  
  - [Resetting Dev from Prod](#resetting-dev-from-prod)  
  - [Markdown Auto-Update](#markdown-auto-update)  
- [Segment API References](#segment-api-references)  
- [🤖 MCP Server](#-mcp-server)  
  - [Workflow dispatch contract](#workflow-dispatch-contract)  

---

## 🔧 Setup Instructions  

### 1️⃣ Clone the Repository  

```bash
git clone https://github.com/YOUR_USERNAME/trackings-plans.git
cd trackings-plans
```

### 2️⃣ Configure GitHub Secrets  

This project requires **GitHub repository secrets** for authentication with the Segment API. These are used only by GitHub Actions — the MCP server does not need them.

| Secret Name  | Description |
|-------------|-------------|
| `SEGMENT_PUBLIC_API_TOKEN`  | API Token for Segment Public API |
| `DEV_SEGMENT_TRACKING_PLAN_ID_<TP_NAME>`  | Segment Tracking Plan ID for **Dev** |
| `PROD_SEGMENT_TRACKING_PLAN_ID_<TP_NAME>` | Segment Tracking Plan ID for **Prod** |

**Hint**:
`https://app.segment.com/<your_workspace>/protocols/tracking-plans/<tracking_plan_id>`

#### Example

This repository manages **two tracking plans**:  
✅ JavaScript  
✅ Server  

So, it requires **5 GitHub Secrets**:  

- **1** API token (`SEGMENT_PUBLIC_API_TOKEN`)  
- **2** JavaScript tracking plan IDs (Dev & Prod)  
- **2** Server tracking plan IDs (Dev & Prod)  

---

## ⚙️ How It Works  

### Setup & Initialize

1. Configure your tracking plans in `config/tracking-plans-config.json`
2. Create a **GitHub release** with the title **"initialize"**
   - This triggers the `initialize-tracking-plans` workflow
   - It pulls tracking plans from Segment, saves them as JSON, generates YAML, and creates the markdown dictionary.

### **Step 1: Updating Dev Tracking Plan**

🔹 **Trigger**:

- Open a PR touching `tracking-rules/**` on any branch and add the `deploy-dev` label
- Or dispatch `deploy-dev.yml` from the Actions tab / via the MCP's `deploy_dev` tool

🔹 **What Happens?**

1. Converts the YAML rules on the PR's branch to Segment JSON
2. Updates the **Dev** tracking plan using a `PATCH` request
3. Posts a sticky comment on the PR with the deploy result
4. **Does not commit back to the branch** — YAML in `tracking-rules/**` is the source of truth for dev

The pre-M4 flow (auto-deploy on push, commit `plans/dev/**` snapshots) has been retired. Dev deploys are now explicit, and dev state lives on the branch.  

---

### **Step 2: Merging to Main & Updating Prod**  

🔹 **Trigger**:  

- Merging a branch with tracking rule updates into `main`  
- This triggers the **Prod workflow** (`Update Production Tracking Plans and Generate Markdown`)

🔹 **What Happens?**  

1. Converts the updated YAML to JSON  
2. Updates the **Prod** tracking plan using a `PATCH` request  
3. Fetches updated rules from Segment & saves to `plans/prod/<TP_NAME>/current-rules.json`  
4. Generates a **Markdown data dictionary** (`docs/<TP_NAME>.md`)  
5. Commits & pushes updates to `main`  

---

## 🔹 Advanced Features  

### **Resetting Dev from Prod**

Dev can be reset from the committed Prod snapshot at any time. There are two entry points, both hitting the same `reset-dev.yml` workflow:

```bash
# CLI
gh workflow run reset-dev.yml -f plan=<plan-name-or-all> -f request_id=$(uuidgen)

# or via the MCP
# reset_dev({ plan: "<plan-name>", confirm: true })
```

The workflow reads `plans/prod/<TP_NAME>/current-rules.json` from `main` and PATCHes the Dev tracking plan in Segment. The old "create a GitHub release named `RESET_DEV`" trigger is gone.

---

### **Markdown Auto-Update**  

- Ensures **docs stay up to date**  
- Fetches latest `PROD` rules  
- Runs `render-tp.js` to regenerate Markdown  

---

## **Segment API References**

This project interacts with Segment's Tracking Plan API for managing tracking plans. Below are the key API endpoints used:

### **Saving Tracking Plans**

The `save-tracking-plans.js` script retrieves the latest rules from the Segment API and saves them to the repository.

🔗 [List Rules from Tracking Plan API](https://docs.segmentapis.com/tag/Tracking-Plans#operation/listRulesFromTrackingPlan)  
*Used in:* `scripts/save-tracking-plans.js`

### **Updating Tracking Plans**

The `update-tracking-plan.js` script updates tracking plan rules in Segment using the API.

🔗 [Update Rules in Tracking Plan API](https://docs.segmentapis.com/tag/Tracking-Plans#operation/updateRulesInTrackingPlan)  
*Used in:* `scripts/update-tracking-plan.js`

These endpoints ensure that the tracking plans stay in sync between Segment and this repository.

✅ **This setup automates the full tracking plan lifecycle from YAML to Segment to Markdown!** 🎯  

---

## 🤖 MCP Server

This repo also ships **`tracking-plans-mcp`**, a [Model Context Protocol](https://modelcontextprotocol.io) server. It lets Claude Desktop, Claude Code, Cursor, or any other MCP client read, validate, preview, and author these tracking plans in natural language.

The MCP server is a second way to write the same YAML. It doesn't replace the workflows above. Every change it makes lands as YAML in `tracking-rules/` and goes through the usual branch, Dev workflow, merge to `main`, and Prod workflow path. **The MCP never calls Segment directly.** All Segment API calls happen inside GitHub Actions, where the Segment token lives; the MCP dispatches those workflows and reports on their runs.

### Install

The server runs against a **local clone** of this repo (`REPO_PATH`). That clone is where it reads `config/tracking-plans-config.json`, `tracking-rules/`, and `plans/`, and where it writes changes.

**Option A: npx (once published)**

```bash
npx -y @your-org/tracking-plans-mcp
```

> `@your-org` is a placeholder scope. Replace it with your npm org before publishing.

**Option B: from a local clone**

```bash
git clone https://github.com/YOUR_USERNAME/trackings-plans.git
cd trackings-plans
npm ci
npm run build          # emits dist/mcp/bin.js
```

Requires Node 20 or later.

### Client configuration

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tracking-plans": {
      "command": "npx",
      "args": ["-y", "@your-org/tracking-plans-mcp"],
      "env": {
        "REPO_PATH": "/Users/you/code/trackings-plans",
        "MCP_WRITE_MODE": "pr"
      }
    }
  }
}
```

If you're using a local clone, set `"command": "node"` and `"args": ["/Users/you/code/trackings-plans/dist/mcp/bin.js"]`.

**Claude Code:**

```bash
claude mcp add tracking-plans \
  -e REPO_PATH=/Users/you/code/trackings-plans \
  -e MCP_WRITE_MODE=pr \
  -- npx -y @your-org/tracking-plans-mcp
```

(Or `-- node /Users/you/code/trackings-plans/dist/mcp/bin.js` for a local clone.) Check it with `claude mcp list`.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `REPO_PATH` | Yes | Absolute path to your clone of this repo. All reads and writes happen here. |
| `GITHUB_TOKEN` / `GH_TOKEN` | No | Used by workflow tools and `pr` mode. If unset, the server falls back to the `gh` CLI (`gh auth login`). |
| `MCP_WRITE_MODE` | No | Default write mode: `files`, `branch`, or `pr`. Falls back to `.tracking-plans-mcp.json`'s `write_mode`, then `branch`. |

**Segment credentials are no longer needed by the MCP.** All Segment API calls run inside GitHub Actions; the `SEGMENT_PUBLIC_API_TOKEN` and `*_SEGMENT_TRACKING_PLAN_ID_*` values live only as GitHub Actions secrets.

### Write modes

Every tool that writes accepts an optional `mode`:

| Mode | What happens |
|------|--------------|
| `files` | Edits YAML in your working tree. You review, commit, and push yourself. |
| `branch` | Creates a `tp/<plan>/<verb>-<slug>-<timestamp>` branch, commits, and leaves you on it. |
| `pr` | Same as `branch`, then pushes and opens (or reuses) a GitHub PR against the default branch. |

**Dirty-tree rule:** `branch` and `pr` modes refuse to run while your working tree has uncommitted changes. They return a `DIRTY_TREE` error that lists the dirty paths. Stash or commit those changes, or re-run with `mode: "files"`. If a git step fails, the server always restores your original branch.

### Session branches

Every author and bulk tool accepts an optional `branch` argument. It's validated against a safe branch-name regex (no `..`, no leading `-`).

- **First write of a session** — omit `branch`; the tool creates a fresh `tp/<plan>/<verb>-<slug>-<ts>` branch and returns it.
- **Subsequent writes** — pass the same `branch` back so every edit lands on one branch, and (in `pr` mode) one PR. If a PR is already open for that head branch it is reused; otherwise a new one is opened against the default branch. One MCP session per PR.
- Writing directly to the default branch is refused.

### Tool catalogue

The server exposes **20 tools**, grouped as follows. The M3 admin tools (`pull_from_segment`, `reset_dev_from_prod`) are gone — the workflow tools replace them, and the MCP no longer holds any Segment credentials.

**Read** (6)
- `list_plans`: list the plans configured in `config/tracking-plans-config.json`.
- `list_events`: list the events in a plan. Options: `filter` (regex), `missing_description`, and `has_property`.
- `get_event`: return one event's full YAML-shape definition.
- `diff_plans`: semantic diff between two `(plan, env)` pairs, showing added, removed, and modified events.
- `find_property_usage`: list every event that uses a given property, in one plan or across all plans.
- `list_recent_changes`: git log limited to `tracking-rules/<plan>/`.

**Validate** (3)
- `validate_event`: check one event's schema, types, and required descriptions.
- `validate_plan`: validate every event in a plan. Returns a severity summary.
- `lint_rules`: deep lint, including orphan events (YAML that isn't in the snapshot, and the reverse).

**Preview** (2) — never touches Segment
- `preview_markdown`: render `docs/<plan>.md` from local YAML and diff it against the committed file.
- `preview_segment_payload`: show the exact JSON that a deploy workflow would PATCH to Segment.

**Author** (3) — `files` / `branch` / `pr`
- `add_event`: create a new event YAML.
- `update_event`: patch an event's description, labels, or properties.
- `remove_event`: delete an event's YAML. Requires `confirm: true`.

**Bulk** (2) — `files` / `branch` / `pr`; defaults to `dry_run: true`
- `bulk_rename_property`: rename a property across every event in a plan.
- `bulk_add_property`: add a property to every event that matches an optional filter.

**Workflow** (4) — dispatch GitHub Actions; the MCP never calls Segment itself
- `deploy_dev({ branch, plan?, wait_seconds? })`: dispatch `deploy-dev.yml` to patch the shared **Dev** Segment tracking plan from `branch`'s YAML. Pushes `branch` first if it has no upstream or is ahead of origin. Refuses the default branch.
- `reset_dev({ plan?, confirm, wait_seconds? })`: dispatch `reset-dev.yml` to reset Dev from the committed prod snapshot on the default branch. Requires `confirm: true`.
- `check_prod_drift({ wait_seconds? })`: dispatch `prod-drift.yml`; drift is reported via a PR on the fixed branch `tp/drift/prod`.
- `get_workflow_run({ run_id? | request_id? + workflow?, wait_seconds? })`: poll a dispatched run's status/conclusion and read its `result.json` artifact.

All four accept `wait_seconds` (0–45). If the run doesn't complete in time they return status `queued` / `in_progress` with a `request_id`; poll with `get_workflow_run`.

### Project config: `.tracking-plans-mcp.json`

You can check an optional `.tracking-plans-mcp.json` into the root of `REPO_PATH` to set team-wide defaults, for example:

```json
{
  "write_mode": "pr",
  "default_branch": "main",
  "forge": "github"
}
```

Supported keys:

| Key | Values | Default | Meaning |
|-----|--------|---------|---------|
| `write_mode` | `files` \| `branch` \| `pr` | `branch` | Default write mode when a tool call omits `mode`. |
| `default_branch` | valid branch name | `main` | Base branch that `tp/…` session branches are cut from and that PRs target. Workflow tools always dispatch on this ref. |
| `forge` | `github` | `github` | Which forge backend to use. `github` is the only value today; reserved for future backends. |

The file is strictly validated: unknown keys, invalid values, or anything that looks like a secret (token/plan-ID keys, `rs_...` or token-shaped values) fail startup with a `CONFIG` error. Never put tokens in it. Settings are resolved in this order, highest first:

1. Tool-call arguments (for example `mode: "files"`)
2. Environment variables passed to the MCP process
3. `.tracking-plans-mcp.json` in `REPO_PATH`
4. `config/tracking-plans-config.json` (the plan list)
5. Built-in defaults

### Workflow dispatch contract

The MCP holds no Segment credentials. Every Segment API call runs inside GitHub Actions. The MCP dispatches workflows on the default branch and polls for their result via the `get_workflow_run` tool. Every dispatchable workflow follows the same contract.

**Inputs**

All dispatchable workflows accept these `workflow_dispatch` inputs (strings):

| Input | Workflows | Meaning |
|---|---|---|
| `request_id` | all | Opaque id supplied by the MCP. Workflows embed it in `run-name` (`"<name> [${{ inputs.request_id }}]"`) so the MCP can resolve the run by request id when the dispatch API doesn't return one. |
| `plan` | `deploy-dev`, `reset-dev` | Plan `path` (e.g. `javascript`) or `all` to target every configured plan. |
| `ref` | `deploy-dev` | Branch whose YAML to deploy. The MCP always dispatches on the default branch; `deploy-dev` checks out `inputs.ref` internally. |

**Result shape**

Every workflow uploads a `result` artifact containing `result.json`:

```json
{
  "ok": true,
  "workflow": "deploy-dev",
  "plans": [
    { "plan": "javascript", "env": "dev", "rules_patched": 3 }
  ],
  "errors": []
}
```

Per-plan objects may also include `rules_deleted` (deploy-dev, deploy-prod) or `drift` (prod-drift).

**Concurrency**

Deploy and reset workflows share `concurrency: segment-<env>-<plan>` with `cancel-in-progress: false`. This serializes Segment PATCHes per (env, plan) — two dispatches for the same plan never overlap.

**Finding a run**

`get_workflow_run` accepts either:

- `run_id` (numeric), or
- `request_id` + `workflow` — the tool looks up the run by matching `run-name`.

`wait_seconds` (0–45) blocks until the run completes; on timeout the tool returns `status: "in_progress"` without erroring.

**Prod safety**

`deploy-prod.yml` uses the `production` GitHub Environment with required reviewers. The MCP does not have a `deploy_prod` tool; production is only patched by push-to-default-branch, gated by the Environment.

**Prod drift detection**

`prod-drift.yml` runs nightly (and on dispatch). When Segment prod diverges from the committed snapshot, the workflow:

1. Pushes the fresh snapshot to `tp/drift/prod` (force-with-lease).
2. Opens (or updates) an issue labeled `prod-drift` titled "Prod tracking plan drift" with a compare link.
3. A human reviews the compare view and opens a PR from `tp/drift/prod` → `main` (or reconciles via `tracking-rules/` YAML edits).
4. When a subsequent run detects no drift, the open drift issue is closed and the branch deleted (unless a human PR is still open on it).

The workflow opens an issue rather than a PR because the org disallows GitHub Actions from creating pull requests.

**Secrets, restated**

`SEGMENT_PUBLIC_API_TOKEN` and `*_SEGMENT_TRACKING_PLAN_ID_*` live only as GitHub Actions secrets, never in the MCP client env.

### Security notes

- **No Prod writes from the MCP.** The MCP never holds Segment credentials and never talks to Segment. Prod writes only happen inside `deploy-prod.yml`, gated by the `production` Environment reviewers.
- **Tokens stay in Actions.** `SEGMENT_PUBLIC_API_TOKEN` and plan-ID secrets are GitHub Actions secrets. The MCP only needs `REPO_PATH` and (optionally) a GitHub token.
- **Redaction.** Tool responses and logs redact anything that looks like a token before it reaches the model.
- **Startup lint.** At startup the server warns about common mistakes, such as a token committed to a `.env` inside the repo.
- **Destructive guardrails.** `remove_event` and `reset_dev` require `confirm: true`. `bulk_*` tools default to `dry_run: true`.

### Smoke tests and CI

- Manual smoke test: [`docs/mcp-smoke-test-m4.md`](docs/mcp-smoke-test-m4.md) covers read, validate, preview, author, bulk, workflow tools, and redaction end-to-end.
- `.github/workflows/mcp-ci.yml` runs on PRs that touch `lib/`, `mcp/`, `tests/`, or the build config. It runs typecheck, tests, build, `npm pack --dry-run`, and a stdio smoke check that sends `initialize` and `tools/list` to the built server.
