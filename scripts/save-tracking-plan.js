const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Get environment variables
const planDir = process.env.PLAN_DIR;
const workspace = process.env.SEGMENT_WORKSPACE;
const trackingPlanId = process.env.SEGMENT_TRACKING_PLAN_ID;
const apiUrl = `https://api.segmentapis.com/tracking-plans/${trackingPlanId}/rules`;
const apiKey = process.env.SEGMENT_API_KEY;
const paginationCount = 100;
const CHUNK_SIZE = 90 * 1024 * 1024; // 90MB

console.log('API key:', apiKey);
console.log('API URL:', apiUrl);
console.log('Workspace:', workspace);
console.log('Tracking Plan ID:', trackingPlanId);
console.log('Pagination Count:', paginationCount);

// Ensure the directory exists before writing the file
function ensureDirectoryExists(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
    console.log(`✅ Created directory: ${directoryPath}`);
  }
}

// Split file into chunks
function splitFile(filePath) {
  const fileSize = fs.statSync(filePath).size;
  
  if (fileSize <= 100 * 1024 * 1024) {
    console.log(`✅ File size is under 100MB (${(fileSize / (1024 * 1024)).toFixed(2)} MB). No splitting needed.`);
    return;
  }

  console.log(`⚙️ File size exceeds 100MB (${(fileSize / (1024 * 1024)).toFixed(2)} MB). Splitting into chunks...`);

  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const rules = content.rules;

  let chunkIndex = 1;
  let currentChunk = [];

  rules.forEach(rule => {
    currentChunk.push(rule);
    const chunkSize = Buffer.byteLength(JSON.stringify({ rules: currentChunk }), 'utf-8');

    if (chunkSize >= CHUNK_SIZE) {
      const chunkPath = path.join(planDir, `current-rules-${chunkIndex}.json`);
      fs.writeFileSync(chunkPath, JSON.stringify({ rules: currentChunk }, null, 2));
      console.log(`✅ Created chunk: ${chunkPath}`);
      chunkIndex++;
      currentChunk = [];
    }
  });

  // Write remaining rules if any
  if (currentChunk.length > 0) {
    const chunkPath = path.join(planDir, `current-rules-${chunkIndex}.json`);
    fs.writeFileSync(chunkPath, JSON.stringify({ rules: currentChunk }, null, 2));
    console.log(`✅ Created final chunk: ${chunkPath}`);
  }

  // Remove original file if split
  fs.unlinkSync(filePath);
  console.log(`🗑️ Removed original file: ${filePath}`);
}

async function fetchUpdatedTrackingPlanRules(cursor = null, accumulatedRules = []) {
  try {
      const params = new URLSearchParams({
          'pagination[count]': paginationCount.toString(),
      });

      if (cursor) {
          params.append('pagination[cursor]', cursor);
      }

      const requestUrl = `${apiUrl}?${params.toString()}`;
      console.log(`🔍 Fetching from URL: ${requestUrl}`);

      const response = await axios.get(requestUrl, {
          headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache'
          },
      });

      const { rules = [], pagination } = response.data.data;
      accumulatedRules.push(...rules);

      console.log(`✅ Fetched ${rules.length} rules. Total accumulated: ${accumulatedRules.length}`);
      console.log(`📖 Pagination details: current: ${pagination?.current}, next: ${pagination?.next}`);

      if (pagination?.next) {
          // Recursively fetch the next page using the cursor
          return await fetchUpdatedTrackingPlanRules(pagination.next, accumulatedRules);
      } else {
          console.log('🎉 Finished fetching all rules.');
          return accumulatedRules;
      }
  } catch (error) {
      console.error('❌ Error fetching rules:', error.response?.data || error.message);
      return accumulatedRules;
  }
}


// Main function
async function main() {
  const allRules = await fetchUpdatedTrackingPlanRules();
  ensureDirectoryExists(planDir);

  const filePath = path.join(planDir, 'current-rules.json');
  fs.writeFileSync(filePath, JSON.stringify({ rules: allRules }, null, 2));
  console.log(`✅ Saved all rules to: ${filePath}`);

  splitFile(filePath);
}

main();
