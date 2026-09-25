const { execSync } = require('child_process');
const yaml = require('js-yaml');
const { createSegmentClient } = require('../dist/lib/segment-api.js');
const { loadYamlRuleFile, yamlToRule } = require('../dist/lib/yaml-transform.js');

function getChangedFiles(directory) {
  const baseRef = process.env.BASE_REF || 'origin/main';
  let range;
  try {
    const mergeBase = execSync(`git merge-base ${baseRef} HEAD`).toString().trim();
    range = `${mergeBase}..HEAD`;
  } catch {
    range = `${baseRef}..HEAD`;
  }
  const lines = execSync(`git diff --name-status ${range}`)
    .toString()
    .split('\n')
    .filter(Boolean);
  const upserts = [];
  const deletes = [];
  for (const line of lines) {
    const [statusRaw, ...pathParts] = line.split('\t');
    const status = statusRaw[0];
    const path = pathParts[pathParts.length - 1];
    if (!path.startsWith(directory) || !path.endsWith('.yml')) continue;
    if (status === 'D') deletes.push(path);
    else upserts.push(path);
  }
  return { upserts, deletes, baseRef };
}

function loadDeletedYaml(path, baseRef) {
  const mergeBase = execSync(`git merge-base ${baseRef} HEAD`).toString().trim();
  const content = execSync(`git show ${mergeBase}:${path}`).toString();
  return yaml.load(content);
}

async function main() {
  const planDir = process.env.PLAN_DIR;
  const trackingPlanId = process.env.SEGMENT_TRACKING_PLAN_ID;
  const apiKey = process.env.SEGMENT_API_KEY;
  if (!planDir || !trackingPlanId || !apiKey) {
    console.error('Missing PLAN_DIR, SEGMENT_TRACKING_PLAN_ID, or SEGMENT_API_KEY');
    process.exit(1);
  }
  const { upserts, deletes, baseRef } = getChangedFiles(planDir);
  const rules = upserts.map((f) => yamlToRule(loadYamlRuleFile(f)));
  const deleteIds = deletes.map((f) => {
    const y = loadDeletedYaml(f, baseRef);
    return { key: y.key, type: y.type, version: y.version };
  });
  if (rules.length === 0 && deleteIds.length === 0) {
    console.log('No changed YAML rules to update.');
    return;
  }
  const client = createSegmentClient({ apiKey });
  if (rules.length > 0) {
    await client.patchRules(trackingPlanId, rules);
    console.log(`Updated ${rules.length} rules on plan ${trackingPlanId}`);
  }
  if (deleteIds.length > 0) {
    await client.deleteRules(trackingPlanId, deleteIds);
    console.log(`Deleted ${deleteIds.length} rules on plan ${trackingPlanId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
