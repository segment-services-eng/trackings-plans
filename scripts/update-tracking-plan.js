const { execSync } = require('child_process');
const { createSegmentClient } = require('../dist/lib/segment-api.js');
const { loadYamlRuleFile, yamlToRule } = require('../dist/lib/yaml-transform.js');

function getChangedFiles(directory) {
  const files = execSync('git diff --name-only HEAD^ HEAD').toString().split('\n');
  return files.filter((f) => f.startsWith(directory) && f.endsWith('.yml'));
}

async function main() {
  const planDir = process.env.PLAN_DIR;
  const trackingPlanId = process.env.SEGMENT_TRACKING_PLAN_ID;
  const apiKey = process.env.SEGMENT_API_KEY;
  if (!planDir || !trackingPlanId || !apiKey) {
    console.error('Missing PLAN_DIR, SEGMENT_TRACKING_PLAN_ID, or SEGMENT_API_KEY');
    process.exit(1);
  }
  const changed = getChangedFiles(planDir);
  const rules = changed.map((f) => yamlToRule(loadYamlRuleFile(f)));
  if (rules.length === 0) {
    console.log('No changed YAML rules to update.');
    return;
  }
  const client = createSegmentClient({ apiKey });
  await client.patchRules(trackingPlanId, rules);
  console.log(`Updated ${rules.length} rules on plan ${trackingPlanId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
