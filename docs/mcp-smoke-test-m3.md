# Tracking Plans MCP: M3 Manual Smoke Test (Admin Tools)

## Prerequisites

- The M1 and M2 smoke tests pass (`docs/mcp-smoke-test.md`, `docs/mcp-smoke-test-m2.md`).
- A **throwaway Dev tracking plan** in Segment. Never use a Dev plan that other people depend on.
  For this test, point `DEV_SEGMENT_TRACKING_PLAN_ID_<NAME>` in your MCP client config at the throwaway plan's ID.
- `PROD_SEGMENT_TRACKING_PLAN_ID_<NAME>` points at a Prod plan that you can read. It is only read, never written.
- Your working tree is clean, on a scratch branch (`git checkout -b smoke/m3`).

## Steps

### 1. Rebuild

```bash
npm ci && npm run build
```

### 2. Verify the admin tools appear

Ask Claude: "List every tool the tracking-plans MCP exposes."
Expected: the 16 M2 tools plus `reset_dev_from_prod` and `pull_from_segment`, 18 in total.

### 3. `pull_from_segment` (files mode)

- In the Segment UI, make a small, harmless edit to the throwaway **Dev** plan, for example changing an event description.
- "Pull the JavaScript dev plan from Segment. Use mode: files."
- Expected: `plans/dev/javascript/current-rules.json` changes, and `git diff` shows your edit. No commit or branch is created.
- Discard the change: `git checkout -- plans/dev/javascript/current-rules.json`.

### 4. `pull_from_segment` (branch mode, prod env)

- "Pull the JavaScript prod plan from Segment."
- Expected: either a `tp/javascript/...` branch with one commit touching only `plans/prod/javascript/current-rules.json`, or a no-op if the snapshot is already current.
- Confirm that nothing changed on the Prod plan in Segment. Pulling is read-only against Segment.
- Clean up: `git checkout smoke/m3 && git branch -D <tp/... branch>`.

### 5. `reset_dev_from_prod` refuses without confirm

- "Reset the JavaScript dev plan from prod."
- Expected: an error saying `confirm: true` is required. The Dev plan in Segment is unchanged, and no files or branches are created.

### 6. `reset_dev_from_prod` (files mode)

- "Reset the JavaScript dev plan from prod with confirm: true, mode: files."
- Expected: in Segment, the throwaway Dev plan's rules now match Prod, and the edit from step 3 is gone.
  `plans/dev/javascript/current-rules.json` is refreshed in the working tree.
- Verify: `diff <(jq -S . plans/dev/javascript/current-rules.json) <(jq -S . plans/prod/javascript/current-rules.json)` shows no rule differences (IDs and timestamps may differ).
- Discard: `git checkout -- plans/`.

### 7. `reset_dev_from_prod` is Dev-only

- "Reset the JavaScript **prod** plan from dev with confirm: true."
- Expected: the request is refused (for example `PROD_WRITE_BLOCKED`, or no parameter exists for the target env). The Prod plan in Segment is unchanged.

### 8. Dirty-tree refusal

- `echo x >> README.md`
- "Pull the JavaScript dev plan from Segment." (default mode: branch)
- Expected: a `DIRTY_TREE` error that lists `README.md`.
- `git checkout -- README.md`.

### 9. Secrets never leak

- Look over the tool responses from steps 3–8 in the Claude transcript.
- Expected: no `sgp_...` token appears anywhere. Any token-shaped string shows as redacted.

### 10. Clean up

```bash
git checkout main && git branch -D smoke/m3
```

Restore your MCP client config so the Dev plan ID points back at the real Dev plan.
