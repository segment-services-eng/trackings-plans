# MCP Prod-Write Safety Audit (M2)

**Date:** 2026-08-26

## Method

Static grep of `mcp/` for any Segment mutation call (`patchRules`, `deleteRules`).

## Findings

- `grep -rn "patchRules\|deleteRules" mcp/` → **no matches**. Confirmed.
- Prod references in `mcp/tools/*` are exclusively for READING `plans/prod/<plan>/current-rules*.json`. No prod code path calls `ctx.segmentClient()`.

## Conclusion

M2 tools cannot mutate the Segment prod tracking plan. Prod-side writes still flow through merge-to-main → `.github/workflows/update-prod-tracking-plans.yml` → `scripts/update-tracking-plan.js`.
