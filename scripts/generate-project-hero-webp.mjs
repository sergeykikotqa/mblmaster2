import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';
import sharp from 'sharp';

const ROOT = process.cwd();
const PROJECTS_DIR = path.join(ROOT, 'src', 'content', 'projects');
const ASSETS_DIR = path.join(ROOT, 'src', 'assets', 'images', 'projects');
const OUTPUT_DIR = path.join(ROOT, 'public', 'hero');
const MAX_DIMENSION = 1000;

function listProjectFiles() {
  return fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
    .map((entry) => path.join(PROJECTS_DIR, entry.name))
    .sort();
}

function parseFrontmatter(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  return (yaml.load(match[1]) || {}) ?? {};
}

function resolveSourcePath(slug, imageValue) {
  const normalized = String(imageValue || '').trim();
  if (!normalized) return null;
  if (normalized.startsWith('/hero/')) return null;
  if (normalized.startsWith('/images/projects/')) {
    const relativePath = normalized.replace(/^\/images\/projects\//, '');
    return path.join(ROOT, 'src', 'assets', 'images', relativePath);
  }
  if (normalized.startsWith('/')) return null;
  return path.join(ASSETS_DIR, slug, normalized);
}

function selectHeroSource(frontmatter, slug) {
  const blocks = Array.isArray(frontmatter.blocks) ? frontmatter.blocks : [];
  const heroBlock = blocks.find((block) => block && block.type === 'hero');
  const candidates = [heroBlock?.image, ...(Array.isArray(frontmatter.images) ? frontmatter.images : [])];

  for (const candidate of candidates) {
    const sourcePath = resolveSourcePath(slug, candidate);
    if (sourcePath && fs.existsSync(sourcePath)) {
      return sourcePath;
    }
  }

  return null;
}

async function generateHero({ slug, sourcePath }) {
  const outputPath = path.join(OUTPUT_DIR, `${slug}.webp`);
  const transformer = sharp(sourcePath).rotate().resize({
    width: MAX_DIMENSION,
    height: MAX_DIMENSION,
    fit: 'inside',
    withoutEnlargement: true,
  });

  const metadata = await transformer.metadata();
  await transformer
    .webp({
      quality: 44,
      effort: 6,
      smartSubsample: true,
    })
    .toFile(outputPath);

  const outputMetadata = await sharp(outputPath).metadata();
  const outputStats = fs.statSync(outputPath);
  return {
    slug,
    sourcePath: path.relative(ROOT, sourcePath),
    outputPath: path.relative(ROOT, outputPath),
    sourceWidth: metadata.width,
    sourceHeight: metadata.height,
    outputWidth: outputMetadata.width,
    outputHeight: outputMetadata.height,
    outputSizeKb: Number((outputStats.size / 1024).toFixed(1)),
  };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const results = [];
  for (const filePath of listProjectFiles()) {
    const frontmatter = parseFrontmatter(filePath);
    if (frontmatter?.draft) continue;

    const slug = String(frontmatter?.slug || path.basename(filePath, '.md')).trim();
    if (!slug) continue;

    const sourcePath = selectHeroSource(frontmatter, slug);
    if (!sourcePath) continue;

    results.push(await generateHero({ slug, sourcePath }));
  }

  if (results.length === 0) {
    console.log('[hero-webp] no local project heroes found');
    return;
  }

  for (const result of results) {
    console.log(
      `[hero-webp] ${result.slug}: ${result.outputWidth}x${result.outputHeight}, ${result.outputSizeKb} KB <- ${result.sourcePath}`
    );
  }
}

main().catch((error) => {
  console.error('[hero-webp] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
