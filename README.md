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
  - [RESET_DEV Workflow](#reset_dev-workflow)  
  - [Markdown Auto-Update](#markdown-auto-update)  
- [Segment API References](#segment-api-references)  
- [🤖 MCP Server](#-mcp-server)  

---

## 🔧 Setup Instructions  

### 1️⃣ Clone the Repository  

```bash
git clone https://github.com/YOUR_USERNAME/trackings-plans.git
cd trackings-plans
```

### 2️⃣ Configure GitHub Secrets  

This project requires **GitHub repository secrets** for authentication with the Segment API.

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

- Pushing changes to `tracking-rules/javascript/**.yml` or `tracking-rules/server/**.yml` on a **new branch**  
- This triggers the **Dev workflow** (`Update Development Tracking Plans`)

🔹 **What Happens?**  

1. Converts the modified YAML rule(s) to JSON
2. Updates the **Dev** tracking plan using a `PATCH` request  
3. Fetches the updated rules from Segment & saves to `plans/dev/<TP_NAME>/current-rules.json`  
4. Adds, commits, and pushes the changes  

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

### **RESET_DEV Workflow**  

- Triggered by creating a **release** named `RESET_DEV`  
- Fetches rules from **Prod**  
- Replaces **all** rules in **Dev** tracking plan with **Prod**
- Updates `plans/dev/<TP_NAME>/current-rules.json`  

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

The MCP server is a second way to write the same YAML. It doesn't replace the workflows above. Every change it makes lands as YAML in `tracking-rules/` and goes through the usual branch, Dev workflow, merge to `main`, and Prod workflow path. **The server never writes to a Prod tracking plan in Segment.**

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
        "SEGMENT_PUBLIC_API_TOKEN": "sgp_...",
        "DEV_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT": "rs_...",
        "PROD_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT": "rs_...",
        "DEV_SEGMENT_TRACKING_PLAN_ID_SERVER": "rs_...",
        "PROD_SEGMENT_TRACKING_PLAN_ID_SERVER": "rs_...",
        "MCP_WRITE_MODE": "branch"
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
  -e SEGMENT_PUBLIC_API_TOKEN=sgp_... \
  -e DEV_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT=rs_... \
  -e PROD_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT=rs_... \
  -e DEV_SEGMENT_TRACKING_PLAN_ID_SERVER=rs_... \
  -e PROD_SEGMENT_TRACKING_PLAN_ID_SERVER=rs_... \
  -- npx -y @your-org/tracking-plans-mcp
```

(Or `-- node /Users/you/code/trackings-plans/dist/mcp/bin.js` for a local clone.) Check it with `claude mcp list`.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SEGMENT_PUBLIC_API_TOKEN` | For Segment-backed tools | Segment Public API token. This is the same value as the GitHub secret of the same name. |
| `DEV_SEGMENT_TRACKING_PLAN_ID_<NAME>` | For Segment-backed tools | Dev tracking plan ID for each plan in `config/tracking-plans-config.json`. |
| `PROD_SEGMENT_TRACKING_PLAN_ID_<NAME>` | For Segment-backed tools | Prod tracking plan ID. **Only ever read**, never written. |
| `REPO_PATH` | No (default: CWD) | Absolute path to your clone of this repo. |
| `MCP_WRITE_MODE` | No (default: `branch`) | Default write mode: `files`, `branch`, or `pr`. |
| `GITHUB_TOKEN` | No | Used by `pr` mode only when the `gh` CLI is missing or unauthenticated. |

The variable names match the GitHub Actions secrets, so a single `.env` works for both. Keep that `.env` **outside** the repo, or at least keep it gitignored.

### Write modes

Every tool that writes accepts an optional `mode`:

| Mode | What happens |
|------|--------------|
| `files` | Edits YAML in your working tree. You review, commit, and push yourself. |
| `branch` (default) | Creates a `tp/<plan>/<verb>-<slug>-<timestamp>` branch, commits, and leaves you on it. |
| `pr` | Same as `branch`, then pushes and opens a GitHub PR with `gh` (falling back to `GITHUB_TOKEN`). Merging the PR runs the existing Prod workflow. |

**Dirty-tree rule:** `branch` and `pr` modes refuse to run while your working tree has uncommitted changes. They return a `DIRTY_TREE` error that lists the dirty paths. Stash or commit those changes, or re-run with `mode: "files"`. If a git step fails, the server always restores your original branch.

### Tool catalogue

**Read**
- `list_plans`: list the plans configured in `config/tracking-plans-config.json`.
- `list_events`: list the events in a plan snapshot. Options: `filter` (regex), `missing_description`, and `has_property`.
- `get_event`: return one event's full YAML-shape definition.
- `diff_plans`: semantic diff between two `(plan, env)` pairs, showing added, removed, and modified events.
- `find_property_usage`: list every event that uses a given property, in one plan or across all plans.
- `list_recent_changes`: git log limited to `tracking-rules/<plan>/`.

**Validate**
- `validate_event`: check one event's schema, types, and required descriptions.
- `validate_plan`: validate every event in a plan snapshot. Returns a severity summary.
- `lint_rules`: deep lint, including orphan events (YAML that isn't in the snapshot, and the reverse).

**Preview** (never touches Segment)
- `preview_markdown`: render `docs/<plan>.md` from local YAML and diff it against the committed file.
- `preview_segment_payload`: show the exact JSON that the workflow would PATCH to Segment.

**Author** (`files` / `branch` / `pr`)
- `add_event`: create a new event YAML.
- `update_event`: patch an event's description, labels, or properties.
- `remove_event`: delete an event's YAML. Requires `confirm: true`.

**Bulk** (`files` / `branch` / `pr`; defaults to `dry_run: true`)
- `bulk_rename_property`: rename a property across every event in a plan.
- `bulk_add_property`: add a property to every event that matches an optional filter.

**Admin**
- `reset_dev_from_prod({ plan, confirm, mode? })`: the MCP equivalent of the `RESET_DEV` release. It replaces the **Dev** plan's rules in Segment with Prod's, then refreshes `plans/dev/<plan>/current-rules.json` through the write flow. It works on Dev only and requires `confirm: true`.
- `pull_from_segment({ plan, env, mode? })`: refresh `plans/<env>/<plan>/current-rules.json` from Segment, the same as `save-tracking-plan.js`. The refreshed snapshot is committed through the normal `files` / `branch` / `pr` flow. It reads from Segment and never writes to it.

### Project config: `.tracking-plans-mcp.json`

You can check an optional `.tracking-plans-mcp.json` into the root of `REPO_PATH` to set team-wide defaults, for example:

```json
{ "write_mode": "pr" }
```

This file is for non-secret values only. Never put tokens in it. Settings are resolved in this order, highest first:

1. Tool-call arguments (for example `mode: "files"`)
2. Environment variables passed to the MCP process
3. `.tracking-plans-mcp.json` in `REPO_PATH`
4. `config/tracking-plans-config.json` (the plan list)
5. Built-in defaults

### Security notes

- **No Prod writes to Segment.** No tool writes to a Prod tracking plan. Prod changes only happen when a merge to `main` triggers the existing workflow. `reset_dev_from_prod` *reads* Prod and writes Dev. The audit is in [`docs/mcp-prod-write-audit.md`](docs/mcp-prod-write-audit.md).
- **Tokens stay in your client config.** Secrets live only in your MCP client's `env` block (or your shell). The server sends them only to Segment's API and, in `pr` mode, to GitHub.
- **Redaction.** Tool responses and logs redact anything that looks like a token before it reaches the model.
- **Startup lint.** At startup the server warns about common mistakes, such as a token committed to a `.env` inside the repo.
- **Destructive guardrails.** `remove_event` and `reset_dev_from_prod` require `confirm: true`. `bulk_*` tools default to `dry_run: true`.

### Smoke tests and CI

- Manual smoke scripts: [`docs/mcp-smoke-test.md`](docs/mcp-smoke-test.md) (read), [`docs/mcp-smoke-test-m2.md`](docs/mcp-smoke-test-m2.md) (validate, preview, author, and bulk), [`docs/mcp-smoke-test-m3.md`](docs/mcp-smoke-test-m3.md) (admin).
- `.github/workflows/mcp-ci.yml` runs on PRs that touch `lib/`, `mcp/`, `tests/`, or the build config. It runs typecheck, tests, build, `npm pack --dry-run`, and a stdio smoke check that sends `initialize` and `tools/list` to the built server.
