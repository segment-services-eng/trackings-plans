# Tracking Plans MCP — Design Spec

**Date:** 2026-08-26
**Author:** Aubrey Sine (brainstormed with Claude)
**Status:** Draft — pending user review

## Summary

Turn the existing Segment tracking-plans automation repo into an MCP-native authoring
and inspection experience. GitHub Actions remain the promotion spine (dev → qa → prod
via branch → merge). The MCP server is a companion layer that lets a user (via Claude
Desktop, Cursor, etc.) read, draft, validate, and preview tracking-plan changes in
natural language, ultimately producing YAML commits/PRs that the existing workflows
process unchanged.

## Goals

- Preserve the approval spine: prod tracking plans are only ever updated by merge-to-main.
- Expose all current script capabilities as MCP tools with structured inputs/outputs.
- Add capabilities that were previously ad-hoc: semantic diffs, cross-plan queries,
  validation, bulk rewrites, local markdown preview.
- Zero-install distribution: `npx @your-org/tracking-plans-mcp` + one JSON block in
  the user's MCP client config.
- Single source of truth: existing scripts and MCP tools both consume the same
  library code. No duplicated Segment-API or YAML-transform logic.

## Non-goals

- Direct writes to Segment prod bypassing git. The MCP cannot patch prod rules.
- Replacing GitHub Actions. Workflows stay as-is.
- Creating new tracking plans in Segment (rare; do it in the UI).
- Multi-tenant hosted deployment. Local stdio only for v1.
- Finishing or supporting `push-to-webflow.js` (out of scope).

## Users and UX

Primary user: a data / engineering team member managing Segment tracking plans in
Claude Desktop or Cursor. Example interactions:

- "Show me every event in the JS plan that's missing a description."
- "Add a `Product Viewed` event with `product_id` (string, required) and `price`
  (number) to the JavaScript plan."
- "Rename `userId` to `user_id` across every server event — dry run first."
- "Diff dev vs prod for the JS plan."
- "Preview what the markdown data dictionary will look like after my changes."

Secondary user (unchanged): CI. GitHub Actions continue to run the same scripts.

## Architecture

### Repo layout

```
tracking-plans/
├── lib/                          # NEW — pure functions, no process.env access
│   ├── segment-api.ts            # fetchRules, patchRules, deleteRules
│   ├── yaml-transform.ts         # yaml <-> Segment JSON schema
│   ├── render-markdown.ts        # rule[] -> markdown
│   ├── validate.ts               # NEW — schema + naming-convention linting
│   ├── plans-config.ts           # load tracking-plans-config.json, resolve by name
│   └── git-ops.ts                # NEW — branch/commit/push helpers
│
├── mcp/                          # NEW — MCP server
│   ├── server.ts                 # entry point, tool registration
│   ├── context.ts                # resolves REPO_PATH, checks git cleanliness
│   └── tools/
│       ├── read.ts
│       ├── author.ts
│       ├── validate.ts
│       ├── preview.ts
│       └── admin.ts
│
├── scripts/                      # EXISTING — refactored to thin wrappers over lib/
│   └── ... (unchanged filenames, unchanged env-var contracts)
│
├── .github/workflows/            # UNCHANGED
├── tracking-rules/               # UNCHANGED — source of truth
├── plans/                        # UNCHANGED — Segment snapshot
├── config/                       # UNCHANGED
└── docs/                         # UNCHANGED
```

### Language and runtime

- TypeScript, compiled to JS on publish.
- Node 20+ (matches current GitHub Actions runner).
- Built on `@modelcontextprotocol/sdk` (official).
- Distributed as `@your-org/tracking-plans-mcp` on npm with a `bin` entry so
  `npx @your-org/tracking-plans-mcp` boots the stdio server.

### Key invariants

- `lib/` has zero MCP-specific code and zero direct `process.env` reads. Everything
  takes explicit arguments. Both Actions scripts and MCP tools call it.
- `mcp/` never touches Segment or git directly — always through `lib/`.
- Existing scripts keep their filenames and env-var contracts. Their bodies are
  reduced to: parse env, call `lib/...`, print result.

## Tool surface

Every tool returns a typed `ToolResult<T>` (see Error handling below). All tools
that reference a tracking plan take `plan: "javascript" | "server"` and (where
relevant) `env: "dev" | "prod"`.

### Read / query

| Tool                       | Purpose                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `list_plans`               | Enumerate configured plans from `tracking-plans-config.json`.        |
| `list_events`              | Event keys + one-line summaries. Supports `filter` (regex on name, has-property, missing-description). |
| `get_event`                | Full rule for an event: properties, types, required, description.    |
| `diff_plans`               | Semantic diff of two (plan, env) pairs — added/removed/modified events and properties. |
| `find_property_usage`      | Every event using a given property, optionally across plans.         |
| `list_recent_changes`      | Git log of `tracking-rules/<plan>/**` over the last N commits/days.  |

### Draft / author

All authoring tools accept `mode: "files" | "branch" | "pr"` (default from
`MCP_WRITE_MODE`, ultimately `"branch"`).

| Tool                    | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `add_event`             | Write a new YAML file for an event.                                    |
| `update_event`          | Patch YAML for an existing event.                                      |
| `remove_event`          | Delete the YAML file. Requires `confirm: true`; returns removed YAML.  |
| `bulk_rename_property`  | Sweep all YAML files. Requires `dry_run: false` to execute.            |
| `bulk_add_property`     | Add a property to matching events. `dry_run` default true.             |

### Validate

| Tool             | Purpose                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `validate_event` | Check JSON-schema shape, required fields, naming conventions for one rule. |
| `validate_plan`  | Run `validate_event` across every YAML file in a plan.                  |
| `lint_rules`     | Soft checks: missing descriptions, inconsistent property casing, orphan events. |

### Preview / generate

| Tool                       | Purpose                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| `preview_markdown`         | Regenerate `docs/<plan>.md` from local YAML; return diff vs. committed. Does NOT write. |
| `preview_segment_payload`  | Show the exact JSON that would be `PATCH`ed to Segment for a given event. |

### Admin

| Tool                     | Purpose                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `reset_dev_from_prod`    | Mirror of the `RESET_DEV` release trigger. Requires `confirm: true`.   |
| `pull_from_segment`      | Refresh the local `plans/<env>/<plan>/current-rules.json` snapshot from Segment. Same behavior as `save-tracking-plan.js`. Follows the standard write flow (`files` / `branch` / `pr` mode) so the refreshed snapshot is committed through the normal approval spine. |

### Explicitly out of scope for v1

- Direct prod Segment writes.
- Webflow push.
- Creating new tracking plans in Segment.

## Write flow

Preflight (every authoring tool):

1. Resolve `REPO_PATH` (env var or CWD). Fail with `CONFIG` error if not a git repo
   or if `config/tracking-plans-config.json` is missing.
2. Determine effective mode: tool arg > `MCP_WRITE_MODE` env > default `"branch"`.
3. In user-clone mode, check `git status --porcelain`. If dirty AND mode is
   `branch` or `pr`, refuse with `DIRTY_TREE`, listing dirty paths and suggesting
   `git stash` or `mode: "files"`. In managed-clone mode, sync to `origin/main` first.

Per-mode:

- **`files`** — Edit YAML in place. Return touched paths.
- **`branch`** (default) — `git fetch && git checkout -b tp/<plan>/<slug>-<ts> origin/main`;
  edit; `git add tracking-rules/<plan>/ && git commit -m "<structured msg>"`.
  Leave user on that branch. Return `{ branch, commit_sha, files_changed, next_steps }`.
- **`pr`** — Everything in `branch`, then `git push -u origin <branch>` and
  `gh pr create` (fallback to Octokit + `GITHUB_TOKEN`). Return `{ branch, pr_url, pr_number }`.

Commit-message template (machine-parseable):

```
[tp:<plan>] <verb> event "<key>"

- <detail line>
- <detail line>
- Generated via tracking-plans-mcp
```

Failure handling for git: any command failure aborts, restores prior branch
(`git checkout -`), returns raw git stderr in the tool response. The tree is
never left half-committed.

Prod-safety: Segment API tools that would mutate rules refuse unless env is
`"dev"`. `PROD_WRITE_BLOCKED` error, with remediation pointing to merge-to-main.

## Config, auth, and installation

### Config precedence (highest wins)

1. Tool-call arguments.
2. Environment variables passed to the MCP process.
3. `.tracking-plans-mcp.json` in `REPO_PATH` (project-level defaults, checked in).
4. `config/tracking-plans-config.json` (plan list — unchanged).
5. Built-in defaults.

### Environment variables

Required:

- `SEGMENT_PUBLIC_API_TOKEN`
- `DEV_SEGMENT_TRACKING_PLAN_ID_<NAME>` and `PROD_SEGMENT_TRACKING_PLAN_ID_<NAME>`
  for each configured plan (matches existing Actions secret names — a single `.env`
  works for both surfaces).

Optional:

- `REPO_PATH` — path to the clone (default: CWD).
- `MCP_WRITE_MODE` — `files` | `branch` | `pr` (default: `branch`).
- `MCP_MANAGED_CLONE` — `true` to use `~/.tracking-plans-mcp/repo/`.
- `GITHUB_TOKEN` — only for `pr` mode if `gh` CLI isn't available.

### Claude Desktop config example

```json
{
  "mcpServers": {
    "tracking-plans": {
      "command": "npx",
      "args": ["-y", "@your-org/tracking-plans-mcp"],
      "env": {
        "SEGMENT_PUBLIC_API_TOKEN": "...",
        "DEV_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT": "rs_...",
        "PROD_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT": "rs_...",
        "DEV_SEGMENT_TRACKING_PLAN_ID_SERVER": "rs_...",
        "PROD_SEGMENT_TRACKING_PLAN_ID_SERVER": "rs_...",
        "REPO_PATH": "/Users/you/code/trackings-plans"
      }
    }
  }
}
```

### Auth model

Claude Desktop (or the chosen client) is the trust boundary. Tokens live in the
user's local MCP-client config only. The server never transmits secrets anywhere
except Segment's API and (for `pr` mode) GitHub.

### Secrets safety

- Server logs never emit tokens.
- Startup lint checks for common mistakes (e.g., token committed to a `.env` inside
  the repo).
- Tool responses redact anything matching a token pattern before returning to Claude.

## Error handling

Every tool returns a discriminated union:

```ts
type ToolResult<T> =
  | { ok: true; data: T; warnings?: string[] }
  | { ok: false; error: {
      code:
        | "DIRTY_TREE"
        | "SEGMENT_API"
        | "GIT"
        | "VALIDATION"
        | "CONFIG"
        | "NOT_FOUND"
        | "PROD_WRITE_BLOCKED"
        | "UNKNOWN";
      message: string;
      details?: unknown;
      remediation?: string;
    }}
```

Key remediations:

- `DIRTY_TREE` → "Working tree has uncommitted changes in <paths>. Stash them or
  re-run with `mode: 'files'`."
- `SEGMENT_API` → "Segment returned <status>. Check `SEGMENT_PUBLIC_API_TOKEN` or
  retry after <backoff>s."
- `VALIDATION` → returns full findings array; never auto-fixes.
- `PROD_WRITE_BLOCKED` → "Prod writes go through merge-to-main. Open a PR from
  your current branch instead."
- `GIT` → returns raw git stderr; prior branch is always restored.

Guardrails on destructive tools:

- `reset_dev_from_prod` — requires `confirm: true`.
- `remove_event` — requires `confirm: true`; response includes removed YAML.
- `bulk_*` — default `dry_run: true`; must be flipped to execute.

## Testing

- **Unit tests** (Vitest) on `lib/`: YAML↔JSON round-trip, markdown rendering,
  validator findings. Pure functions — highest ROI.
- **Contract tests** on `lib/segment-api.ts` with mocked HTTP (msw). Verify
  pagination, error mapping.
- **Integration tests** on MCP tools via `@modelcontextprotocol/sdk`'s in-process
  test harness. Segment API mocked.
- **Manual smoke test** documented in `docs/mcp-smoke-test.md`: point at a
  throwaway Segment tracking plan, run a scripted flow (add event → validate →
  preview markdown → reset dev).
- **No E2E against real Segment prod. Ever.**

## CI

- Existing workflows: unchanged. Scripts still work because they're now thin
  wrappers over `lib/`, but their env-var contracts and outputs are preserved.
- New workflow `mcp-ci.yml` on PRs touching `lib/` or `mcp/`: typecheck + unit
  tests + contract tests.

## Migration plan (implementation-order sketch)

1. Introduce `lib/` by extracting pure functions from existing scripts; scripts
   become thin wrappers. Verify all existing workflows still pass.
2. Add `validate.ts` and unit tests (new capability, no consumer yet).
3. Scaffold `mcp/server.ts` with the read-only tools first (`list_plans`,
   `list_events`, `get_event`, `diff_plans`). Manual smoke test.
4. Add validate + preview tools.
5. Add authoring tools with `mode: "files"` first, then `"branch"`, then `"pr"`.
6. Add admin tools (`reset_dev_from_prod`, `pull_from_segment`).
7. Publish to npm; update README with Claude Desktop setup.

Detailed step-by-step plan will be produced by the `writing-plans` skill after
this spec is approved.

## Open questions

None blocking. Everything below can be revisited during implementation:

- Exact npm scope (`@your-org/...`) — TBD by user.
- Whether to include a `search_events` full-text tool in v1 (currently omitted;
  `list_events` with regex filter covers most cases).
- `pull_from_segment` currently reuses the standard write-mode machinery
  (`files`/`branch`/`pr`); revisit if usage patterns show something different is wanted.
