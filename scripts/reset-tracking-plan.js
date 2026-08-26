const path = require('path');
const fs = require('fs');
const { createSegmentClient } = require('../dist/lib/segment-api.js');

async function main() {
  const planDir = process.env.PLAN_DIR;
  const trackingPlanId = process.env.SEGMENT_TRACKING_PLAN_ID;
  const apiKey = process.env.SEGMENT_API_KEY;
  if (!planDir || !trackingPlanId || !apiKey) {
    console.error('Missing PLAN_DIR, SEGMENT_TRACKING_PLAN_ID, or SEGMENT_API_KEY');
    process.exit(1);
  }
  const client = createSegmentClient({ apiKey });
  const existing = await client.fetchAllRules(trackingPlanId);
  if (existing.length > 0) {
    await client.deleteRules(
      trackingPlanId,
      existing.map((r) => ({ key: r.key, type: r.type, version: r.version })),
    );
    console.log(`Deleted ${existing.length} rules from ${trackingPlanId}`);
  }
  const files = fs
    .readdirSync(planDir)
    .filter((f) => f.startsWith('current-rules') && f.endsWith('.json'))
    .sort();
  for (const f of files) {
    const { rules } = JSON.parse(fs.readFileSync(path.join(planDir, f), 'utf-8'));
    if (Array.isArray(rules) && rules.length > 0) {
      await client.patchRules(trackingPlanId, rules);
      console.log(`Uploaded ${rules.length} rules from ${f}`);
    }
  }
  console.log('Tracking plan reset complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
