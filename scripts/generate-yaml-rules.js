// const fs = require('fs');
// const path = require('path');
// const yaml = require('js-yaml');

// // Get command-line arguments
// const args = process.argv.slice(2);

// // Get directory paths from command-line arguments or use defaults
// const planDir = args[0] || process.env.PLAN_DIR || './tracking-rules/rules';
// const jsonFilePath =  path.join(planDir, 'current-rules.json');
// const saveDir = args[2] || './tracking-rules/rules';

// console.log('Plan Directory:', planDir);
// console.log('JSON File Path:', jsonFilePath);
// console.log('Save Directory:', saveDir);

// // Load JSON data
// let trackingPlanData;
// try {
//   trackingPlanData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf-8'));
//   console.log('Loaded tracking plan data:', trackingPlanData);
// } catch (error) {
//   console.error('Error reading JSON file:', error.message);
//   process.exit(1);
// }

// // Function to convert JSON rules to YAML and save them
// function generateYAMLFiles() {
//   trackingPlanData.rules.forEach((rule) => {
//     const yamlContent = yaml.dump({ rule });
//     const fileName = `${rule.key.replace(/ /g, '_')}.yaml`;
//     const filePath = path.join(saveDir, fileName);

//     try {
//       fs.writeFileSync(filePath, yamlContent);
//       console.log(`Generated YAML file: ${filePath}`);
//     } catch (error) {
//       console.error(`Error writing YAML file ${fileName}:`, error.message);
//     }
//   });
// }

// // Run the function to generate YAML files
// generateYAMLFiles();

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Get command-line arguments
const args = process.argv.slice(2);

// Ensure correct arguments are provided
if (args.length < 2) {
  console.error('Usage: node scripts/generate-yaml-rules.js <planDir> <saveDir>');
  process.exit(1);
}

// Assign command-line arguments
const planDir = args[0];  // e.g., plans/prod/<TP_NAME>
const saveDir = args[1];  // e.g., tracking-rules/<TP_NAME>
const jsonFilePath = path.join(planDir, 'current-rules.json');

// Ensure save directory exists
if (!fs.existsSync(saveDir)) {
  fs.mkdirSync(saveDir, { recursive: true });
}

console.log('Plan Directory:', planDir);
console.log('JSON File Path:', jsonFilePath);
console.log('Save Directory:', saveDir);

// Load JSON data
let trackingPlanData;
try {
  trackingPlanData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf-8'));
  console.log('Loaded tracking plan data:', trackingPlanData);
} catch (error) {
  console.error('Error reading JSON file:', error.message);
  process.exit(1);
}

// Function to convert JSON rules to YAML and save them
function generateYAMLFiles() {
  trackingPlanData.rules.forEach((rule) => {
    const yamlContent = yaml.dump({ rule });
    const fileName = `${rule.key.replace(/ /g, '_')}.yaml`;
    const filePath = path.join(saveDir, fileName);

    try {
      fs.writeFileSync(filePath, yamlContent);
      console.log(`Generated YAML file: ${filePath}`);
    } catch (error) {
      console.error(`Error writing YAML file ${fileName}:`, error.message);
    }
  });
}

// Run the function to generate YAML files
generateYAMLFiles();
