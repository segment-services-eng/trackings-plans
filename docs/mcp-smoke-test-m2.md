# Tracking Plans MCP — M2 Manual Smoke Test

## Prerequisites

- M1 smoke test passing (`docs/mcp-smoke-test.md`).
- `gh` CLI installed and authenticated (`gh auth status`) — needed for `pr` mode.

## Steps

### 1. Rebuild

```bash
npm ci && npm run build
```

### 2. Verify M2 tools appear

Ask Claude: "List every tool the tracking-plans MCP exposes."
Expected: 6 read tools + `validate_event` + `validate_plan` + `lint_rules` + `preview_markdown` + `preview_segment_payload` + `add_event` + `update_event` + `remove_event` + `bulk_rename_property` + `bulk_add_property` = 16 tools total.

### 3. Validate + preview

- "Lint the JavaScript prod plan."
- "Preview the markdown that would land in docs/JavaScript.md based on my current YAML."
- "Show me the Segment payload for the 'Product Viewed' event in the JS plan."

### 4. Author (files mode) — sandbox

On a throwaway branch:

- "Add a `Test Event` to the JavaScript plan with properties `test_id` (string, required). Use mode: files."
- Verify a new file appeared at `tracking-rules/javascript/Test_Event.yml`.
- "Delete the `Test Event` from the JavaScript plan."

### 5. Author (branch mode)

- Ensure your working tree is clean.
- "Add a `Sample Event` to the JavaScript plan (default mode)."
- Verify: MCP created branch `tp/javascript/add-sample-event-<timestamp>` with one commit, and your working tree is now on that branch.
- Verify `git log --oneline -n 1` shows the generated commit message.
- Delete the branch: `git checkout main && git branch -D tp/javascript/add-sample-event-<timestamp>`.

### 6. Author (pr mode)

- "Add a `PR Test Event` with mode: pr."
- Verify a PR is opened on GitHub. Close and delete.

### 7. Dirty-tree refusal

- Make an uncommitted change (e.g., `echo x >> README.md`).
- Ask Claude to add a new event (default mode: branch).
- Expected: `DIRTY_TREE` error, remediation includes the list of dirty files.

### 8. Bulk operations

- "Show me a dry-run of renaming `userId` to `user_id` across the JavaScript plan."
- Verify no files change.
- "Now execute that rename."
- Verify commit is created on a new branch.
