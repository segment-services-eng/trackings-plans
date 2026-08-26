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
  const rules = await client.fetchAllRules(trackingPlanId);
  fs.mkdirSync(planDir, { recursive: true });
  const filePath = path.join(planDir, 'current-rules.json');
  fs.writeFileSync(filePath, JSON.stringify({ rules }, null, 2));
  console.log(`Saved ${rules.length} rules to ${filePath}`);
  splitFileIfLarge(filePath, planDir);
}

function splitFileIfLarge(filePath, planDir) {
  const MAX = 100 * 1024 * 1024;
  const CHUNK = 90 * 1024 * 1024;
  const size = fs.statSync(filePath).size;
  if (size <= MAX) return;
  const { rules } = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  let idx = 1;
  let cur = [];
  for (const rule of rules) {
    cur.push(rule);
    if (Buffer.byteLength(JSON.stringify({ rules: cur }), 'utf-8') >= CHUNK) {
      fs.writeFileSync(
        path.join(planDir, `current-rules-${idx}.json`),
        JSON.stringify({ rules: cur }, null, 2),
      );
      idx++;
      cur = [];
    }
  }
  if (cur.length) {
    fs.writeFileSync(
      path.join(planDir, `current-rules-${idx}.json`),
      JSON.stringify({ rules: cur }, null, 2),
    );
  }
  fs.unlinkSync(filePath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
