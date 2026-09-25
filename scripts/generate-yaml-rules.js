const path = require('path');
const fs = require('fs');
const { ruleToYaml, writeYamlRuleFile } = require('../dist/lib/yaml-transform.js');

const [planDir, saveDir] = process.argv.slice(2);
if (!planDir || !saveDir) {
  console.error('Usage: node scripts/generate-yaml-rules.js <planDir> <saveDir>');
  process.exit(1);
}
const jsonFilePath = path.join(planDir, 'current-rules.json');
const { rules } = JSON.parse(fs.readFileSync(jsonFilePath, 'utf-8'));
for (const rule of rules) {
  const y = ruleToYaml(rule);
  const fileName = `${rule.key.replace(/ /g, '_')}.yml`;
  writeYamlRuleFile(path.join(saveDir, fileName), y);
  console.log(`Generated ${fileName}`);
}
