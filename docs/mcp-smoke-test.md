# Tracking Plans MCP — Manual Smoke Test (Milestone 1)

## Prerequisites

- Node 20+ installed.
- Local clone of this repo at `~/code/trackings-plans` (or wherever).
- Segment API token and tracking plan IDs available (same values used by GitHub Actions secrets).

## Steps

### 1. Build

```bash
cd ~/code/trackings-plans
npm ci
npm run build
```

Expected: `dist/mcp/bin.js` and `dist/lib/*.js` exist.

### 2. Run once locally

```bash
REPO_PATH=$(pwd) \
SEGMENT_PUBLIC_API_TOKEN=sgp_... \
DEV_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT=rs_... \
PROD_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT=rs_... \
DEV_SEGMENT_TRACKING_PLAN_ID_SERVER=rs_... \
PROD_SEGMENT_TRACKING_PLAN_ID_SERVER=rs_... \
node dist/mcp/bin.js < /dev/null
```

Expected: prints startup line to stderr, exits cleanly.

### 3. Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tracking-plans": {
      "command": "node",
      "args": ["/absolute/path/to/trackings-plans/dist/mcp/bin.js"],
      "env": {
        "REPO_PATH": "/absolute/path/to/trackings-plans",
        "SEGMENT_PUBLIC_API_TOKEN": "sgp_...",
        "DEV_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT": "rs_...",
        "PROD_SEGMENT_TRACKING_PLAN_ID_JAVASCRIPT": "rs_...",
        "DEV_SEGMENT_TRACKING_PLAN_ID_SERVER": "rs_...",
        "PROD_SEGMENT_TRACKING_PLAN_ID_SERVER": "rs_..."
      }
    }
  }
}
```

Restart Claude Desktop.

### 4. Verify each tool through Claude

Ask Claude Desktop:

1. **`list_plans`** — "What tracking plans are configured?"
   - Expected: JavaScript, Server (or whatever is in `config/tracking-plans-config.json`).

2. **`list_events`** — "List all events in the JavaScript dev plan."
   - Expected: matches `plans/dev/javascript/current-rules.json`.

3. **`list_events` with filter** — "List events in the JavaScript prod plan whose names start with 'Product'."
   - Expected: filtered list.

4. **`list_events` missing_description** — "Which events in server prod are missing descriptions?"
   - Expected: only events without a `description`.

5. **`get_event`** — "Show me the full definition for 'Product Viewed' in the JavaScript dev plan."
   - Expected: yaml-shape with properties and required flags.

6. **`diff_plans`** — "Diff JavaScript dev vs prod."
   - Expected: added/removed/modified lists.

7. **`find_property_usage`** — "Which events use the `user_id` property?"
   - Expected: usage list, possibly across both plans.

8. **`list_recent_changes`** — "Show me the last 10 commits touching JavaScript tracking rules."
   - Expected: recent git commits.

### 5. Regression check on Actions

Trigger a workflow that runs the refactored scripts (e.g., merge a small YAML change to a dev branch and ensure `update-dev-tracking-plans.yml` still succeeds). If the workflow fails on `npm run build`, add the Setup Node / Install / Build steps as described in Task 7.
