import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const rootDir = process.cwd();
const figmaDir = path.join(rootDir, 'public', 'images', 'figma');
const outputDir = path.join(figmaDir, 'optimized');

const jobs = [
  { input: 'hero-main.png', outputBase: 'hero-main', widths: [480, 768, 1024, 1366] },
  { input: 'hero-slide-2.png', outputBase: 'hero-slide-2', widths: [480, 768, 1024, 1366] },
  { input: 'hero-slide-3.png', outputBase: 'hero-slide-3', widths: [480, 768, 1024, 1366] },
  { input: 'portfolio-modern-light.jpg', outputBase: 'portfolio-modern-light', widths: [320, 480, 640, 960] },
  { input: 'portfolio-modern-wide.png', outputBase: 'portfolio-modern-wide', widths: [320, 480, 640, 960] },
  { input: 'portfolio-detail-drawer.png', outputBase: 'portfolio-detail-drawer', widths: [320, 480, 640, 960] },
  { input: 'portfolio-detail-wood.png', outputBase: 'portfolio-detail-wood', widths: [320, 480, 640, 960] },
  { input: 'portfolio-classic-white.png', outputBase: 'portfolio-classic-white', widths: [320, 480, 640, 960] },
  { input: 'portfolio-dark-modern.png', outputBase: 'portfolio-dark-modern', widths: [320, 480, 640, 960] },
  { input: 'portfolio-classic-cream.png', outputBase: 'portfolio-classic-cream', widths: [320, 480, 640, 960] },
  { input: 'video-thumb.png', outputBase: 'video-thumb', widths: [320, 640] },
  { input: 'video-thumb-2.png', outputBase: 'video-thumb-2', widths: [320, 640] },
  { input: 'video-thumb-3.png', outputBase: 'video-thumb-3', widths: [320, 640] },
];

async function buildVariant(inputPath, outputPath, width, format) {
  const image = sharp(inputPath).rotate().resize({
    width,
    withoutEnlargement: true,
  });

  if (format === 'webp') {
    await image.webp({ quality: 56, effort: 6 }).toFile(outputPath);
    return;
  }

  await image.avif({ quality: 44, effort: 8 }).toFile(outputPath);
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  let created = 0;

  for (const job of jobs) {
    const inputPath = path.join(figmaDir, job.input);
    if (!fs.existsSync(inputPath)) {
      console.warn(`[optimize-figma-placeholders] skip missing source: ${job.input}`);
      continue;
    }

    for (const width of job.widths) {
      for (const format of ['webp', 'avif']) {
        const outputPath = path.join(outputDir, `${job.outputBase}-${width}.${format}`);
        await buildVariant(inputPath, outputPath, width, format);
        created += 1;
      }
    }
  }

  console.log(`[optimize-figma-placeholders] generated ${created} files in ${outputDir}`);
}

main().catch((error) => {
  console.error('[optimize-figma-placeholders] failed', error);
  process.exit(1);
});
