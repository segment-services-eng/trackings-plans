const path = require('path');
const fs = require('fs');
const { renderMarkdown } = require('../dist/lib/render-markdown.js');

const [title, jsonSourcePath, markdownTargetPath] = process.argv.slice(2);
if (!title || !jsonSourcePath || !markdownTargetPath) {
  console.error('Usage: node scripts/render-tp.js <title> <jsonSourcePath> <markdownTargetPath>');
  process.exit(1);
}
const json = JSON.parse(fs.readFileSync(path.resolve(jsonSourcePath), 'utf8'));
const md = renderMarkdown({ title, rules: json.rules });
fs.mkdirSync(path.dirname(markdownTargetPath), { recursive: true });
fs.writeFileSync(markdownTargetPath, md, 'utf-8');
console.log(`Wrote ${markdownTargetPath}`);
