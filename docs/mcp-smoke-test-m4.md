# Tracking Plans MCP: M4 Manual Smoke Test (Workflow Tools)

Covers the M4 changes: 20 tools total, session branches through `add_event`, the four workflow tools (`deploy_dev` / `reset_dev` / `check_prod_drift` / `get_workflow_run`), and secrets redaction. The MCP no longer holds Segment credentials — every Segment call runs in a GitHub Actions workflow.

## Prerequisites

- A **throwaway Dev tracking plan** in Segment. Never point this test at a Dev plan other people depend on.
- The four M4 workflows exist on the default branch: `deploy-dev.yml`, `deploy-prod.yml`, `reset-dev.yml`, `prod-drift.yml`. The `deploy-dev` label exists on the repo.
- GitHub Actions secrets are set: `SEGMENT_PUBLIC_API_TOKEN` and matching `DEV_/PROD_SEGMENT_TRACKING_PLAN_ID_<NAME>` for the plan under test. **These are NOT in the MCP client env.**
- `gh auth status` shows you authenticated, or `GITHUB_TOKEN` / `GH_TOKEN` is set for the MCP process.
- Working tree clean; you're on the default branch.

## 1. Build and stdio-launch the server

```bash
npm ci && npm run build
```

Sanity-launch over stdio (the MCP client will use the same entry point):

```bash
REPO_PATH=$PWD node dist/mcp/bin.js < /dev/null
```

The process should stay up waiting for JSON-RPC on stdin; kill it with Ctrl-C.

## 2. `tools/list` returns 20 tools

From your MCP client (Claude Desktop / Claude Code):

> "List every tool the tracking-plans MCP exposes."

Expected — exactly **20** tools:

- **Read (6):** `list_plans`, `list_events`, `get_event`, `diff_plans`, `find_property_usage`, `list_recent_changes`
- **Validate (3):** `validate_event`, `validate_plan`, `lint_rules`
- **Preview (2):** `preview_markdown`, `preview_segment_payload`
- **Author (3):** `add_event`, `update_event`, `remove_event`
- **Bulk (2):** `bulk_rename_property`, `bulk_add_property`
- **Workflow (4):** `deploy_dev`, `reset_dev`, `check_prod_drift`, `get_workflow_run`

The M3 admin tools `pull_from_segment` and `reset_dev_from_prod` must NOT appear.

## 3. `add_event` with a session branch → PR (author sets up ref for step 4)

```
add_event({
  plan: "javascript",
  key: "MCP Smoke M4",
  description: "temp event for the M4 smoke test",
  mode: "pr",
  branch: "tp/session/smoke"
})
```

Expected response fields:

- `mode: "pr"`
- `branch: "tp/session/smoke"`
- `commit_sha`: a real sha
- `pr_url`, `pr_number`
- `pr_reused: false` on the first call, `true` if you re-run
- `files_changed` lists exactly one YAML under `tracking-rules/javascript/`

Apply the `deploy-dev` label to that PR in the GitHub UI. Now dispatch via MCP:

## 4. `deploy_dev` for that PR's ref

```
deploy_dev({
  branch: "tp/session/smoke",
  plan: "javascript",
  wait_seconds: 30
})
```

Expected response shape (per `mcp/tools/workflows.ts`):

- `request_id: "mcp-<ms>-<6 base36>"`
- `workflow: "deploy-dev.yml"`
- `run_id`: positive integer (once GitHub lists it)
- `run_url`: `https://github.com/.../actions/runs/<id>`
- `status`: `queued` | `in_progress` | `completed`
- `conclusion`: only present when `status === "completed"` — should be `"success"` for a clean deploy
- `result`: only present when the run completed AND uploaded the `result` artifact. Shape:
  ```json
  { "ok": true, "workflow": "deploy-dev.yml",
    "plans": [{ "plan": "javascript", "env": "dev", "rules_patched": <n> }] }
  ```
- `pushed`: `true` if `deploy_dev` had to push `tp/session/smoke` first (only on the first call after a purely local commit)

If the run does not finish within 30s, `status` stays `in_progress` / `queued` and there is no `conclusion` or `result` — proceed to step 5 to poll.

**Refusal check:** `deploy_dev({ branch: "main" })` must return a `VALIDATION` error refusing the default branch.

## 5. `get_workflow_run` polls the same run

Using the `run_id` from step 4:

```
get_workflow_run({ run_id: <run_id>, wait_seconds: 45 })
```

Expected:

- Same `run_id`, `run_url`, `workflow`
- `status: "completed"`, `conclusion: "success"`
- `result`: the same `result.json` contents as above (`ok: true`, `plans: [...]`)

Non-success conclusion returns an error with `code: "WORKFLOW"`, the run URL, the conclusion, and the `result` payload (which lists any per-plan errors). This is the exact shape `deploy_dev`'s `awaitRun` also returns on failure.

## 6. `check_prod_drift`

```
check_prod_drift({ wait_seconds: 30 })
```

Expected `request_id`, `run_id`, `run_url`, and (if it finishes in time) a `result` shaped like `{ ok, workflow: "prod-drift.yml", plans: [{ plan, env: "prod", drift: <bool> }] }`. If drift is detected the workflow opens/updates a PR on the fixed branch `tp/drift/prod` — verify in the GitHub UI.

If you get a `queued` / `in_progress` response, follow up with:

```
get_workflow_run({ run_id: <run_id>, wait_seconds: 45 })
```

## 7. `reset_dev` requires confirm

```
reset_dev({ plan: "javascript" })
```

Expected: `VALIDATION` error (`confirm: true` required, remediation names the shared Dev plan).

Then, only if you actually want to reset the throwaway Dev plan:

```
reset_dev({ plan: "javascript", confirm: true, wait_seconds: 30 })
```

Expected: `request_id`, `run_id`, and — once complete — `conclusion: "success"` with a `result` listing rules replaced.

## 8. Redaction test — `GITHUB_TOKEN` never appears in responses

Set the MCP process's `GITHUB_TOKEN` to a **fake bearer-shaped value with 12+ chars and at least one digit**, e.g. `ghp_faketoken123456789abcdef` (does not need to be real).

Restart the MCP so it picks up the new env.

Call any tool that references auth in an error — an easy way is to point at a nonexistent workflow, or simply run `deploy_dev` again. Then search the full JSON-RPC response for the literal token value.

Expected: the fake token string does NOT appear anywhere in the response. Anything matching a `Bearer <12+ chars w/ digit>` shape shows as `Bearer [REDACTED]`, and the explicit env value is replaced by `[REDACTED]` (see `lib/secrets.ts`).

Reset `GITHUB_TOKEN` to your real value (or unset it and rely on `gh` CLI auth) once done.

## 9. Cleanup

- Close the smoke PR from step 3 without merging, and delete the `tp/session/smoke` branch.
- If step 7 actually reset the throwaway Dev plan, restore it however you normally would (usually `reset_dev` from Prod is the recovery too).
