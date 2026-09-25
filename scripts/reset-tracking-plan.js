const { createSegmentClient } = require('../dist/lib/segment-api.js');
const { readSnapshotSources, resetRules } = require('../dist/lib/snapshot-sync.js');

async function main() {
  const planDir = process.env.PLAN_DIR;
  const trackingPlanId = process.env.SEGMENT_TRACKING_PLAN_ID;
  const apiKey = process.env.SEGMENT_API_KEY;
  if (!planDir || !trackingPlanId || !apiKey) {
    console.error('Missing PLAN_DIR, SEGMENT_TRACKING_PLAN_ID, or SEGMENT_API_KEY');
    process.exit(1);
  }
  const client = createSegmentClient({ apiKey });
  const { deleted, patched } = await resetRules(
    client,
    trackingPlanId,
    readSnapshotSources(planDir),
    (m) => console.log(m),
  );
  console.log(
    `Reset ${trackingPlanId}: patched ${patched} rules, deleted ${deleted} rules`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
