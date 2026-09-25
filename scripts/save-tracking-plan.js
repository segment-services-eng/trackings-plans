const path = require('path');
const fs = require('fs');
const { createSegmentClient } = require('../dist/lib/segment-api.js');
const { formatSnapshotFiles } = require('../dist/lib/snapshot-sync.js');

async function main() {
  const planDir = process.env.PLAN_DIR;
  const trackingPlanId = process.env.SEGMENT_TRACKING_PLAN_ID;
  const apiKey = process.env.SEGMENT_API_KEY;
  if (!planDir || !trackingPlanId || !apiKey) {
    console.error('Missing PLAN_DIR, SEGMENT_TRACKING_PLAN_ID, or SEGMENT_API_KEY');
    process.exit(1);
  }
  const client = createSegmentClient({ apiKey });
  const rules = await client.fetchAllRules(trackingPlanId);
  fs.mkdirSync(planDir, { recursive: true });
  const files = formatSnapshotFiles(rules);
  for (const f of files) {
    fs.writeFileSync(path.join(planDir, f.name), f.content);
  }
  // Mirrors the previous split behavior: when chunked, the single
  // current-rules.json is removed.
  const single = path.join(planDir, 'current-rules.json');
  if (files[0].name !== 'current-rules.json' && fs.existsSync(single)) {
    fs.unlinkSync(single);
  }
  console.log(`Saved ${rules.length} rules to ${single}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
