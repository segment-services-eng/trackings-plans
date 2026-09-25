const { execSync } = require('child_process');
const { createSegmentClient } = require('../dist/lib/segment-api.js');
const { loadYamlRuleFile, yamlToRule } = require('../dist/lib/yaml-transform.js');

function getChangedFiles(directory) {
  const baseRef = process.env.BASE_REF || 'origin/main';
  // Diff from the merge-base of BASE_REF..HEAD so multi-commit branches include
  // every YAML change since branching, not just the final commit.
  let range;
  try {
    const mergeBase = execSync(`git merge-base ${baseRef} HEAD`).toString().trim();
    range = `${mergeBase}..HEAD`;
  } catch {
    // Fall back to comparing against BASE_REF directly (e.g. when no shared
    // history has been fetched). Any error will surface as an empty diff.
    range = `${baseRef}..HEAD`;
  }
  const files = execSync(`git diff --name-only ${range}`).toString().split('\n');
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
