import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = process.cwd();
const PROJECTS_DIR = path.join(ROOT, 'src', 'content', 'projects');
const OUTPUT_DIR = path.join(ROOT, 'content', 'migrations');

const args = process.argv.slice(2);
const options = {
  slug: null,
  apply: false,
  dryRun: false,
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--apply') {
    options.apply = true;
    continue;
  }
  if (arg === '--dry-run') {
    options.dryRun = true;
    continue;
  }
  if (arg.startsWith('--slug=')) {
    options.slug = arg.slice('--slug='.length).trim();
    continue;
  }
  if (arg === '--slug') {
    options.slug = String(args[i + 1] || '').trim();
    i += 1;
  }
}

const LEGACY_FIELDS = [
  'task',
  'solution',
  'process',
  'cost',
  'beforeAfter',
  'faq',
  'internalLinks',
  'imageCaptions',
];

const BLOCK_ORDER = {
  hero: 1,
  task: 2,
  solution: 3,
  split: 3.5,
  materials: 4,
  process: 5,
  gallery: 6,
  beforeAfter: 7,
  video: 8,
  quote: 9,
  result: 10,
  cost: 11,
  specs: 12,
  faq: 13,
  links: 13.5,
  related: 14,
  cta: 15,
};

const DEFAULT_SORT_ORDER = Number.MAX_SAFE_INTEGER;

function extractFrontmatter(rawSource) {
  const source = String(rawSource || '');
  if (!source.startsWith('---')) {
    return { frontmatterSource: null, body: source };
  }

  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) return { frontmatterSource: null, body: source };

  return {
    frontmatterSource: String(match[1] || ''),
    body: source.slice(match[0].length),
  };
}

function parseFrontmatter(source) {
  if (!source) return {};
  try {
    const parsed = yaml.load(source, { schema: yaml.JSON_SCHEMA });
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function stringifyFrontmatter(data) {
  const yamlSource = yaml.dump(data, { lineWidth: 120, noRefs: true, schema: yaml.JSON_SCHEMA });
  return `---\n${yamlSource}---\n`;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isEmptyValue(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return '';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value))} ₽`;
}

function applyDefaults(block, defaults) {
  const next = { ...block };
  for (const [key, value] of Object.entries(defaults || {})) {
    if (isEmptyValue(next[key]) && !isEmptyValue(value)) {
      next[key] = value;
    }
  }
  return next;
}

function buildMaterialsItems(materials) {
  if (!materials || typeof materials !== 'object') return [];
  const items = [
    { label: 'Фасады', value: materials.facade, icon: 'tabler:palette' },
    { label: 'Столешница', value: materials.tabletop, icon: 'tabler:square' },
    { label: 'Корпус', value: materials.corpus, icon: 'tabler:box' },
    { label: 'Фурнитура', value: materials.hardware, icon: 'tabler:tool' },
  ];
  return items.filter((item) => isNonEmptyString(item.value));
}

function buildCostPayload(cost, price) {
  if (!cost || typeof cost !== 'object') return null;
  const from = Number.isFinite(cost.from) ? formatMoney(cost.from) : '';
  const to = Number.isFinite(cost.to) ? formatMoney(cost.to) : '';
  const note = String(cost.note || '').trim();
  let label = '';
  if (from && to) {
    label = `от ${from} до ${to}`;
  } else if (from) {
    label = `от ${from}`;
  } else if (to) {
    label = `до ${to}`;
  } else if (Number.isFinite(price)) {
    label = formatMoney(price);
  }
  if (!label && !note) return null;
  return { label, note };
}

function normalizeProcessSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((step) => ({
      title: String(step?.title || '').trim(),
      description: String(step?.description || '').trim(),
      meta: String(step?.meta || step?.tag || step?.label || '').trim(),
    }))
    .filter((step) => step.title && step.description);
}

function normalizeBeforeAfter(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      before: String(item?.before || '').trim(),
      after: String(item?.after || '').trim(),
      caption: String(item?.caption || '').trim(),
    }))
    .filter((item) => item.before && item.after);
}

function normalizeFaq(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      question: String(item?.question || '').trim(),
      answer: String(item?.answer || '').trim(),
    }))
    .filter((item) => item.question && item.answer);
}

function normalizeInternalLinks(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      text: String(item?.text || '').trim(),
      href: String(item?.href || '').trim(),
    }))
    .filter((item) => item.text && item.href);
}

function normalizeDateValue(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.valueOf())) {
    return value.toISOString();
  }
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isFinite(parsed.valueOf())) {
    return parsed.toISOString();
  }
  return text;
}

function normalizeDateString(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    return text || null;
  }
  return null;
}

function sortBlocks(blocks) {
  return blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => {
      const orderA = BLOCK_ORDER[a.block?.type] ?? DEFAULT_SORT_ORDER;
      const orderB = BLOCK_ORDER[b.block?.type] ?? DEFAULT_SORT_ORDER;
      if (orderA !== orderB) return orderA - orderB;
      return a.index - b.index;
    })
    .map(({ block }) => block);
}

function buildBlocks({ data, body, existingBlocks }) {
  const taskText = String(data.task || '').trim();
  const solutionText = String(data.solution || '').trim();
  const materialsItems = buildMaterialsItems(data.materials);
  const processSteps = normalizeProcessSteps(data.process);
  const galleryImages = Array.isArray(data.images) ? data.images.filter(Boolean) : [];
  const galleryCaptions =
    data.imageCaptions && typeof data.imageCaptions === 'object' ? data.imageCaptions : undefined;
  const beforeAfterItems = normalizeBeforeAfter(data.beforeAfter);
  const faqItems = normalizeFaq(data.faq);
  const internalLinks = normalizeInternalLinks(data.internalLinks);
  const costPayload = buildCostPayload(data.cost, data.price);
  const hasBodyContent = isNonEmptyString(body);
  const heroTitle = String(data.title || '').trim();
  const heroImage =
    String(data.cover || '').trim() || String(galleryImages[0] || '').trim() || undefined;

  const migratedFields = new Set();

  if (existingBlocks.length > 0) {
    const updatedBlocks = existingBlocks.map((block) => {
      if (!block || typeof block !== 'object') return block;
      const type = block.type;

      if (type === 'hero' && (heroTitle || heroImage)) {
        return applyDefaults(block, { title: heroTitle, image: heroImage });
      }
      if (type === 'task' && taskText) {
        return applyDefaults(block, { text: taskText });
      }
      if (type === 'solution' && solutionText) {
        return applyDefaults(block, { text: solutionText });
      }
      if (type === 'materials' && materialsItems.length > 0) {
        return applyDefaults(block, { items: materialsItems });
      }
      if (type === 'process' && processSteps.length > 0) {
        return applyDefaults(block, { steps: processSteps });
      }
      if (type === 'gallery' && galleryImages.length > 0) {
        return applyDefaults(block, { images: galleryImages, captions: galleryCaptions });
      }
      if (type === 'beforeAfter' && beforeAfterItems.length > 0) {
        return applyDefaults(block, { items: beforeAfterItems });
      }
      if (type === 'faq' && faqItems.length > 0) {
        return applyDefaults(block, { items: faqItems });
      }
      if (type === 'links' && internalLinks.length > 0) {
        return applyDefaults(block, { links: internalLinks });
      }
      if (type === 'cost' && costPayload) {
        return applyDefaults(block, costPayload);
      }
      if (type === 'result' && hasBodyContent) {
        return applyDefaults(block, { title: 'Итог проекта' });
      }

      return block;
    });

    if (taskText && updatedBlocks.some((block) => block?.type === 'task')) migratedFields.add('task');
    if (solutionText && updatedBlocks.some((block) => block?.type === 'solution')) migratedFields.add('solution');
    if (processSteps.length > 0 && updatedBlocks.some((block) => block?.type === 'process'))
      migratedFields.add('process');
    if (beforeAfterItems.length > 0 && updatedBlocks.some((block) => block?.type === 'beforeAfter'))
      migratedFields.add('beforeAfter');
    if (faqItems.length > 0 && updatedBlocks.some((block) => block?.type === 'faq')) migratedFields.add('faq');
    if (internalLinks.length > 0 && updatedBlocks.some((block) => block?.type === 'links'))
      migratedFields.add('internalLinks');
    if (costPayload && updatedBlocks.some((block) => block?.type === 'cost')) migratedFields.add('cost');
    if (galleryCaptions && updatedBlocks.some((block) => block?.type === 'gallery'))
      migratedFields.add('imageCaptions');

    return { blocks: sortBlocks(updatedBlocks), migratedFields };
  }

  const blocks = [];

  if (heroTitle || heroImage) {
    blocks.push({
      type: 'hero',
      ...(heroTitle ? { title: heroTitle } : {}),
      ...(heroImage ? { image: heroImage } : {}),
    });
  } else {
    blocks.push({ type: 'hero' });
  }

  if (taskText) {
    blocks.push({ type: 'task', text: taskText });
    migratedFields.add('task');
  }
  if (solutionText) {
    blocks.push({ type: 'solution', text: solutionText });
    migratedFields.add('solution');
  }
  if (materialsItems.length > 0) {
    blocks.push({ type: 'materials', items: materialsItems });
  }
  if (processSteps.length > 0) {
    blocks.push({ type: 'process', steps: processSteps });
    migratedFields.add('process');
  }
  if (galleryImages.length > 0) {
    blocks.push({ type: 'gallery', images: galleryImages, captions: galleryCaptions });
    if (galleryCaptions) migratedFields.add('imageCaptions');
  }
  if (beforeAfterItems.length > 0) {
    blocks.push({ type: 'beforeAfter', items: beforeAfterItems });
    migratedFields.add('beforeAfter');
  }
  if (data.video && (data.video.embedUrl || data.video.contentUrl)) {
    blocks.push({ type: 'video' });
  }
  if (hasBodyContent) {
    blocks.push({ type: 'result', title: 'Итог проекта' });
  }
  if (costPayload) {
    blocks.push({ type: 'cost', ...costPayload });
    migratedFields.add('cost');
  }
  blocks.push({ type: 'specs' });
  if (faqItems.length > 0) {
    blocks.push({ type: 'faq', items: faqItems });
    migratedFields.add('faq');
  }
  if (internalLinks.length > 0) {
    blocks.push({ type: 'links', links: internalLinks });
    migratedFields.add('internalLinks');
  }

  return { blocks: sortBlocks(blocks), migratedFields };
}

function shouldRemoveLegacyField(field, migratedFields) {
  return migratedFields.has(field);
}

function normalizeFilename(fileName) {
  return String(fileName || '').replace(/\.mdx?$/i, '');
}

function main() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error(`[migrate-project-to-blocks] projects dir not found: ${PROJECTS_DIR}`);
    process.exit(1);
  }

  if (!options.apply && !options.dryRun && !fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const files = fs.readdirSync(PROJECTS_DIR).filter((file) => file.endsWith('.md') || file.endsWith('.mdx'));
  const results = [];

  for (const fileName of files) {
    const fullPath = path.join(PROJECTS_DIR, fileName);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const { frontmatterSource, body } = extractFrontmatter(raw);
    if (!frontmatterSource) {
      results.push({ fileName, status: 'skipped', reason: 'no frontmatter' });
      continue;
    }

    const data = parseFrontmatter(frontmatterSource);
    if (!data || typeof data !== 'object') {
      results.push({ fileName, status: 'skipped', reason: 'invalid frontmatter' });
      continue;
    }

    if (options.slug) {
      const normalized = normalizeFilename(fileName);
      const frontmatterSlug = normalizeFilename(String(data.slug || ''));
      const needle = options.slug;
      if (!normalized.includes(needle) && !frontmatterSlug.includes(needle)) {
        continue;
      }
    }

    const existingBlocks = Array.isArray(data.blocks) ? data.blocks.filter((block) => block && block.type) : [];
    const { blocks, migratedFields } = buildBlocks({ data, body, existingBlocks });

    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new Error(`[migrate-project-to-blocks] no blocks produced for ${fileName}`);
    }
    if (blocks[0]?.type !== 'hero') {
      console.warn(`[migrate-project-to-blocks] ${fileName} blocks do not start with hero`);
    }

    const nextFrontmatter = { ...data, blocks };

    const normalizedPublishDate = normalizeDateValue(nextFrontmatter.publishDate ?? nextFrontmatter.date);
    if (normalizedPublishDate) {
      nextFrontmatter.publishDate = normalizedPublishDate;
      delete nextFrontmatter.date;
    } else if (nextFrontmatter.publishDate) {
      delete nextFrontmatter.date;
    }

    if (nextFrontmatter.video && typeof nextFrontmatter.video === 'object') {
      const normalizedUploadDate = normalizeDateString(nextFrontmatter.video.uploadDate);
      if (normalizedUploadDate) {
        nextFrontmatter.video = { ...nextFrontmatter.video, uploadDate: normalizedUploadDate };
      }
    }

    for (const field of LEGACY_FIELDS) {
      if (shouldRemoveLegacyField(field, migratedFields)) {
        delete nextFrontmatter[field];
      }
    }

    const outputFrontmatter = stringifyFrontmatter(nextFrontmatter);
    const bodyPrefix = body.startsWith('\n') || body.startsWith('\r') ? '' : '\n';
    const outputSource = `${outputFrontmatter}${bodyPrefix}${body}`;

    const outputPath = options.apply ? fullPath : path.join(OUTPUT_DIR, fileName);

    if (!options.dryRun) {
      fs.writeFileSync(outputPath, outputSource, 'utf8');
    }

    results.push({
      fileName,
      status: 'ok',
      output: path.relative(ROOT, outputPath).replace(/\\/g, '/'),
    });
  }

  const written = results.filter((item) => item.status === 'ok');
  console.log(`[migrate-project-to-blocks] processed ${written.length} files`);
  for (const item of written) {
    console.log(`- ${item.fileName} -> ${item.output}`);
  }
}

main();
