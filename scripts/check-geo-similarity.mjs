import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const LOCAL_CITY_BLOCKS_PATH = path.join(ROOT, 'data', 'local-city-blocks.json');
const THRESHOLD = Number(process.env.GEO_SIMILARITY_THRESHOLD || 0.85);

function fail(message) {
  throw new Error(message);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getBlockText(block) {
  return normalizeText(
    [
      ...(block.cases || []).flatMap((item) => [item.title, item.location, item.summary, item.alt]),
      ...(block.reviews || []).flatMap((item) => [item.author, item.location, item.text]),
      block.priceRange?.note,
      block.sla?.note,
      block.offer?.title,
      block.offer?.description,
    ].join(' ')
  );
}

function buildTermMap(text) {
  const terms = new Map();
  for (const token of text.split(' ')) {
    if (!token) continue;
    terms.set(token, (terms.get(token) || 0) + 1);
  }
  return terms;
}

function cosineSimilarity(left, right) {
  const leftTerms = buildTermMap(left);
  const rightTerms = buildTermMap(right);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (const value of leftTerms.values()) {
    leftNorm += value * value;
  }
  for (const value of rightTerms.values()) {
    rightNorm += value * value;
  }
  for (const [term, value] of leftTerms.entries()) {
    if (rightTerms.has(term)) {
      dot += value * rightTerms.get(term);
    }
  }

  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function main() {
  if (!fs.existsSync(LOCAL_CITY_BLOCKS_PATH)) {
    fail('local-city-blocks.json is missing.');
  }

  const data = JSON.parse(fs.readFileSync(LOCAL_CITY_BLOCKS_PATH, 'utf8'));
  const violations = [];

  for (const [serviceId, blocksByCity] of Object.entries(data)) {
    const entries = Object.entries(blocksByCity);
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const [leftCity, leftBlock] = entries[i];
        const [rightCity, rightBlock] = entries[j];
        const similarity = cosineSimilarity(getBlockText(leftBlock), getBlockText(rightBlock));
        if (similarity > THRESHOLD) {
          violations.push(
            `- ${serviceId}: ${leftCity} vs ${rightCity} => similarity=${similarity.toFixed(3)} (threshold=${THRESHOLD})`
          );
        }
      }
    }
  }

  if (violations.length > 0) {
    fail(`Geo similarity gate failed.\n${violations.join('\n')}`);
  }

  console.log(`Geo similarity gate passed: threshold=${THRESHOLD}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
