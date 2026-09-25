# M4 state as of 07a6c17 (2026-09-25)

**Branch:** `feat/mcp-milestone-4` off `feat/mcp-milestone-3`. Nothing pushed.
**Spec:** `docs/superpowers/specs/2026-09-24-tracking-plans-mcp-m4-design.md`.
**Tests:** 221 pass, typecheck clean, built server serves 20 tools over stdio.

## Done in M4 so far
- Foundation: `lib/forge.ts` interface, `tests/helpers/fake-forge.ts`, `ctx.forge`, `ctx.defaultBranch` (from `default_branch` in `.tracking-plans-mcp.json`, default `main`).
- 3.1 session branches: `branch` on `add_event`/`update_event`/`remove_event`/`bulk_rename_property`/`bulk_add_property`. Existence and collision checks now run inside the mutator via `WriteAbort`, so they see the target branch's files. PR reuse via `ctx.forge.findOpenPullRequest`. Non-FF push → `GIT` with pull remediation, never forces.
- 3.3 GitHub `ForgeClient` (`lib/forge-github.ts`): `gh` first, Octokit + `GITHUB_TOKEN`/`GH_TOKEN` fallback. Handles PRs, workflow dispatch, run lookup by `[<request_id>]`, and `result` artifact via `fflate`. `parseRemoteUrl` handles HTTPS/SSH/ssh://.
- 3.2 workflow tools (`mcp/tools/workflows.ts`): `deploy_dev`, `reset_dev` (needs `confirm:true`), `check_prod_drift`, `get_workflow_run`. `wait_seconds` 0..45. Dispatches on `ctx.defaultBranch`. `request_id = mcp-<ms>-<6 base36>`. New `WORKFLOW` error code. M3 admin tools (`mcp/tools/admin.ts` + tests) deleted; `segmentApiKey`/`segmentClient`/`planIdEnv` gone from `ServerContext`. `SEGMENT_PUBLIC_API_TOKEN` stays in `lib/secrets.ts` for lint + redaction. `lib/segment-api.ts`, `lib/snapshot-sync.ts` and `scripts/` kept — Actions still uses them.

## Remaining work (spec Build order §)
1. **Section 2 GitHub workflows** — the dispatchable YAML the tools call:
   - `.github/workflows/deploy-dev.yml` (replaces `update-dev-tracking-plans.yml`): trigger on PR labeled `deploy-dev` (label + subsequent push) OR `workflow_dispatch` with inputs `request_id`, `plan`, `ref`. Checkout `inputs.ref`. Build Segment JSON from that ref's YAML and PATCH the Dev plan for `inputs.plan` (a path or `all`). Sticky PR comment. NO commits back to the feature branch. Concurrency `segment-dev-<plan>`, cancel-in-progress false.
   - `.github/workflows/deploy-prod.yml` (replaces `update-prod-tracking-plans.yml`): trigger on push to `main` under `tracking-rules/**`. Uses a `production` GitHub Environment (required reviewers). PATCH prod, save prod snapshot, render docs, commit snapshot + docs back to `main`.
   - `.github/workflows/reset-dev.yml` (converted from `reset-dev-tracking-plans.yml`): `workflow_dispatch` inputs `request_id`, `plan`. Reset Dev from `plans/prod/<plan>/current-rules.json` on `main`.
   - `.github/workflows/prod-drift.yml` (new): nightly cron + `workflow_dispatch` input `request_id`. Fetch Prod; if it differs from the committed snapshot, open/update ONE PR on fixed branch `tp/drift/prod` showing drift vs YAML.
   - `generate-markdown.yml` and `initialize.yml`: convert release-name triggers to `workflow_dispatch`, unchanged behavior.
   - **Dispatch contract every workflow honors:** `run-name` contains `[${{ inputs.request_id }}]`; upload artifact `result` containing `result.json` with `{ ok, workflow, plans:[{plan,env,rules_patched?,rules_deleted?,drift?}], errors? }` even on failure (`if: always()`); a run only counts as success when its conclusion is `success`.
   - **Reuse:** the current jobs already call `scripts/update-tracking-plan.js` and `scripts/save-tracking-plan.js`, which use `lib/segment-api.ts` + `lib/snapshot-sync.ts`. Keep the Segment code paths in those.
   - **Delete `.github/workflows/update-dev-tracking-plans.yml`, `update-prod-tracking-plans.yml`, `reset-dev-tracking-plans.yml`** once replacements are in.
2. **Read tools `env:"dev"` → YAML from the current checkout.** Today `list_events`/`get_event`/`validate_*`/`preview_markdown` on `env:"dev"` read `plans/dev/<plan>/current-rules.json`. Change to read `tracking-rules/<plan>/**` YAML. `env:"prod"` keeps reading `plans/prod/**`. Result should include `source: "yaml"|"snapshot"`. Then `git rm -r plans/dev` and add `plans/dev/` to `.gitignore`.
3. **README + migration notes.** README's MCP client env example (~line 185) still has `SEGMENT_PUBLIC_API_TOKEN` and `*_SEGMENT_TRACKING_PLAN_ID_*` — remove; MCP now only needs `REPO_PATH`, optionally `GITHUB_TOKEN`, optionally `MCP_WRITE_MODE`. Add `.tracking-plans-mcp.json` `default_branch` + `forge`. Document the `deploy-dev` PR label, the `production` Environment setup, and the RESET_DEV → `gh workflow run reset-dev.yml -f plan=... -f request_id=$(uuidgen)` change. Delete `docs/mcp-smoke-test-m3.md` claims about the admin tools (they don't exist anymore) or rewrite as an M4 smoke test.
4. **Review pass** on the full M4 diff.

## File-ownership plan for fanout (independent worktrees)
- `m4/workflows` — `.github/workflows/**` and any workflow-side helper scripts.
- `m4/reads` — `mcp/tools/read.ts`, `mcp/tools/validate.ts`, `mcp/tools/preview.ts`, `lib/plan-snapshot.ts` if needed, tests. Delete `plans/dev` and `.gitignore`.
- `m4/docs` — README, `docs/mcp-smoke-test-m3.md` (rewrite or delete), new `docs/mcp-smoke-test-m4.md`.

Nothing overlaps between the three; the reads and docs agents can run against the current `feat/mcp-milestone-4` without waiting for the workflows agent.
