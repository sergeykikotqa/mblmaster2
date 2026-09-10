import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = process.cwd();
const ARTICLES_DIR = path.join(ROOT, 'src', 'content', 'articles');
const GUIDES_DIR = path.join(ROOT, 'src', 'content', 'guides');
const FAQ_DIR = path.join(ROOT, 'src', 'content', 'faq');
const DATA_DIR = path.join(ROOT, 'data');
const CITIES_PATH = path.join(DATA_DIR, 'cities.json');
const SERVICES_PATH = path.join(DATA_DIR, 'services.json');
const GENERATED_PAGES_PATH = path.join(DATA_DIR, 'generated-pages.json');
const STATIC_PATHS = new Set(['/', '/articles', '/guides', '/faq', '/contacts', '/privacy', '/o-kompanii']);

const CTA_KEYWORDS = [
  'заказать',
  'заказ',
  'заявк',
  'консультац',
  'позвон',
  'связат',
  'расчет',
  'расчёт',
  'оставить',
  'получить',
  'замер',
];

const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/gi;

function normalizePath(value) {
  return value.replace(/\/+$/, '') || '/';
}

function normalizeSegmentToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '');
}

function resolveServicePathSegment(service) {
  return normalizeSegmentToken(service?.pathSegment || service?.id);
}

function buildServiceSlug(servicePathSegment) {
  const normalizedService = normalizeSegmentToken(servicePathSegment);
  if (!normalizedService) return '/';
  return normalizePath(`/${normalizedService}`);
}

function parseMarkdownFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, body: raw };
  }

  const frontmatter = yaml.load(match[1]) || {};
  const body = match[2] || '';
  return { data: frontmatter, body };
}

function loadCollection(collectionName, dirPath) {
  if (!fs.existsSync(dirPath)) return [];

  const files = fs
    .readdirSync(dirPath)
    .filter((file) => file.endsWith('.md') || file.endsWith('.mdx'))
    .sort();

  return files.map((fileName) => {
    const filePath = path.join(dirPath, fileName);
    const { data, body } = parseMarkdownFile(filePath);
    const slug = String(data.slug || fileName.replace(/\.mdx?$/, ''));
    return {
      id: fileName,
      slug,
      collection: collectionName,
      data,
      body,
    };
  });
}

function normalizeInternalLink(slug, articleSlugs, guideSlugs, faqSlugs) {
  if (slug.startsWith('/')) return normalizePath(slug);
  if (articleSlugs.has(slug)) return `/articles/${slug}`;
  if (guideSlugs.has(slug)) return `/guides/${slug}`;
  if (faqSlugs.has(slug)) return `/faq/${slug}`;
  return normalizePath(`/${slug}`);
}

function normalizeCluster(entry) {
  const raw = `${entry.data.category || ''} ${entry.data.mainKeyword || ''} ${(entry.data.tags || []).join(' ')}`
    .trim()
    .toLowerCase();
  if (raw.includes('кухн')) return 'kitchen';
  if (raw.includes('шкаф') || raw.includes('гардероб') || raw.includes('хранен')) return 'storage';
  if (raw.includes('район') || raw.includes('иркут')) return 'local';
  return raw || 'general';
}

function scoreRelated(base, candidate) {
  const baseTags = new Set((base.data.tags || []).map((tag) => String(tag).trim().toLowerCase()));
  const candidateTags = (candidate.data.tags || []).map((tag) => String(tag).trim().toLowerCase());
  let score = 0;

  for (const tag of candidateTags) {
    if (baseTags.has(tag)) score += 2;
  }
  if (
    String(base.data.mainKeyword || '')
      .trim()
      .toLowerCase() ===
    String(candidate.data.mainKeyword || '')
      .trim()
      .toLowerCase()
  ) {
    score += 1;
  }

  return score;
}

function buildAutoRelated(entry, entries) {
  const cluster = normalizeCluster(entry);
  const peers = entries
    .filter((candidate) => candidate.slug !== entry.slug)
    .filter((candidate) => normalizeCluster(candidate) === cluster)
    .sort((a, b) => {
      const scoreDiff = scoreRelated(entry, b) - scoreRelated(entry, a);
      if (scoreDiff !== 0) return scoreDiff;
      const aDate = new Date(a.data.publishDate || 0).getTime();
      const bDate = new Date(b.data.publishDate || 0).getTime();
      return bDate - aDate;
    });

  return peers.slice(0, 3);
}

function collectMarkdownLinks(body) {
  const links = [];
  MARKDOWN_LINK_RE.lastIndex = 0;
  let match;
  while ((match = MARKDOWN_LINK_RE.exec(body || '')) !== null) {
    links.push({ text: String(match[1] || ''), href: String(match[2] || '') });
  }
  return links;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function countWords(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function buildExpectedGeneratedPages(cities, services) {
  const orderedCities = [...cities].sort((a, b) => Number(a.priority) - Number(b.priority));
  const primaryCity = orderedCities[0];
  const moneyServices = services.filter((service) => service.moneyPage);
  const servicePathSegmentById = new Map(
    services.map((service) => [service.id, resolveServicePathSegment(service) || normalizeSegmentToken(service.id)])
  );
  const pages = [];

  if (!primaryCity) {
    return pages;
  }

  for (const service of moneyServices) {
    pages.push({
      cityId: primaryCity.id,
      serviceId: service.id,
      pageType: 'service-money',
      pageSlug: buildServiceSlug(servicePathSegmentById.get(service.id) || service.id),
    });
  }

  return pages;
}

function validateSeoDataModel(errors) {
  if (!fs.existsSync(DATA_DIR)) {
    return {
      generatedRoutes: new Set(),
      cityHubRoutes: new Set(),
      generatedPages: [],
    };
  }

  const requiredFiles = [CITIES_PATH, SERVICES_PATH, GENERATED_PAGES_PATH];
  for (const filePath of requiredFiles) {
    if (!fs.existsSync(filePath)) {
      errors.push(`[seo-data] missing file: ${path.relative(ROOT, filePath).replace(/\\/g, '/')}`);
    }
  }
  if (errors.some((error) => error.includes('[seo-data] missing file:'))) {
    return {
      generatedRoutes: new Set(),
      cityHubRoutes: new Set(),
      generatedPages: [],
    };
  }

  const cities = readJson(CITIES_PATH);
  const services = readJson(SERVICES_PATH);
  const generatedPages = readJson(GENERATED_PAGES_PATH);

  if (!Array.isArray(cities) || !Array.isArray(services) || !Array.isArray(generatedPages)) {
    errors.push('[seo-data] one of data files is not an array');
    return {
      generatedRoutes: new Set(),
      cityHubRoutes: new Set(),
      generatedPages: [],
    };
  }

  const cityIds = new Set();
  for (const city of cities) {
    if (!city?.id || cityIds.has(city.id)) {
      errors.push(`[seo-data] duplicate or empty city id: "${city?.id || ''}"`);
      continue;
    }
    cityIds.add(city.id);
  }

  const serviceIds = new Set();
  for (const service of services) {
    if (!service?.id || serviceIds.has(service.id)) {
      errors.push(`[seo-data] duplicate or empty service id: "${service?.id || ''}"`);
      continue;
    }
    if (!service?.pathSegment || !String(service.pathSegment).trim()) {
      errors.push(`[seo-data] service "${service.id}" has empty pathSegment`);
    }
    serviceIds.add(service.id);
  }

  const expectedPages = buildExpectedGeneratedPages(cities, services);
  if (generatedPages.length !== expectedPages.length) {
    errors.push(
      `[seo-data] generated-pages count mismatch: expected ${expectedPages.length}, got ${generatedPages.length}. Run "npm run build:data".`
    );
  }

  const expectedSlugs = new Set(expectedPages.map((page) => normalizePath(page.pageSlug)));
  const generatedSlugs = new Set(generatedPages.map((page) => normalizePath(page.pageSlug)));

  for (const slug of expectedSlugs) {
    if (!generatedSlugs.has(slug)) {
      errors.push(`[seo-data] generated-pages is missing route "${slug}"`);
    }
  }

  for (const slug of generatedSlugs) {
    if (!expectedSlugs.has(slug)) {
      errors.push(`[seo-data] generated-pages has unexpected route "${slug}"`);
    }
  }

  const cityHubRoutes = new Set(cities.map((city) => normalizePath(`/${city.id}`)));
  for (const page of generatedPages) {
    const slug = normalizePath(page?.pageSlug || '');
    if (!slug || slug === '/') {
      errors.push('[seo-data] generated page has invalid pageSlug');
      continue;
    }
    const related = Array.isArray(page?.related) ? page.related : [];
    if (related.length < 2) {
      errors.push(`[seo-data] "${slug}" must contain at least 2 related links`);
    }
    for (const link of related) {
      const href = normalizePath(link?.href || '');
      if (!href || href === '/') {
        errors.push(`[seo-data] "${slug}" has invalid related href`);
      }
      if (!String(link?.title || '').trim()) {
        errors.push(`[seo-data] "${slug}" has related link with empty title`);
      }
    }

    const faqEntries = Array.isArray(page?.faq) ? page.faq : [];
    if (faqEntries.length < 3) {
      errors.push(`[seo-data] "${slug}" must contain at least 3 faq items`);
    }
    const faqWordCount = faqEntries.reduce((sum, item) => sum + countWords(item?.q) + countWords(item?.a), 0);
    if (page?.pageType === 'service-money' && faqWordCount < 120) {
      errors.push(`[seo-data] "${slug}" must have faqWordsTotal >= 120, got ${faqWordCount}`);
    }
  }

  return {
    generatedRoutes: generatedSlugs,
    cityHubRoutes,
    generatedPages,
  };
}

function lint() {
  const articles = loadCollection('articles', ARTICLES_DIR).filter((entry) => !entry.data.draft);
  const guides = loadCollection('guides', GUIDES_DIR).filter((entry) => !entry.data.draft);
  const faq = loadCollection('faq', FAQ_DIR).filter((entry) => !entry.data.draft);

  const articleSlugs = new Set(articles.map((entry) => entry.slug));
  const guideSlugs = new Set(guides.map((entry) => entry.slug));
  const faqSlugs = new Set(faq.map((entry) => entry.slug));
  const errors = [];

  const knownPaths = new Set([
    ...STATIC_PATHS,
    ...articles.map((entry) => `/articles/${entry.slug}`),
    ...guides.map((entry) => `/guides/${entry.slug}`),
    ...faq.map((entry) => `/faq/${entry.slug}`),
  ]);

  const { generatedRoutes, cityHubRoutes, generatedPages } = validateSeoDataModel(errors);
  for (const routePath of generatedRoutes) {
    knownPaths.add(routePath);
  }
  for (const routePath of cityHubRoutes) {
    knownPaths.add(routePath);
  }

  for (const page of generatedPages) {
    const slug = normalizePath(page?.pageSlug || '');
    const related = Array.isArray(page?.related) ? page.related : [];
    for (const link of related) {
      const href = normalizePath(link?.href || '');
      if (!knownPaths.has(href)) {
        errors.push(`[seo-data] "${slug}" has related link to unknown route "${href}"`);
      }
    }
  }

  const validateEntry = (entry, collectionName, options = { checkRelated: false, checkOrphan: false }) => {
    const related = entry.data.relatedArticles || [];
    const internalLinks = entry.data.internalLinks || [];
    const currentPath =
      collectionName === 'articles'
        ? `/articles/${entry.slug}`
        : collectionName === 'guides'
          ? `/guides/${entry.slug}`
          : `/faq/${entry.slug}`;

    if (options.checkRelated) {
      for (const relatedSlug of related) {
        if (!articleSlugs.has(relatedSlug) && !guideSlugs.has(relatedSlug) && !faqSlugs.has(relatedSlug)) {
          errors.push(
            `[${collectionName}/${entry.slug}] relatedArticles: "${relatedSlug}" is missing (expected article/guide/faq slug)`
          );
        }
      }
    }

    for (const link of internalLinks) {
      const target = normalizeInternalLink(String(link.slug || ''), articleSlugs, guideSlugs, faqSlugs);
      if (!knownPaths.has(target)) {
        errors.push(`[${collectionName}/${entry.slug}] internalLinks: "${link.slug}" -> "${target}" is missing`);
      }
      if (target === currentPath) {
        errors.push(`[${collectionName}/${entry.slug}] internalLinks: "${link.slug}" points to itself`);
      }
    }

    const markdownLinks = collectMarkdownLinks(entry.body);
    const internalBodyLinks = markdownLinks.filter(
      (link) => link.href.startsWith('/') && !link.href.startsWith('//') && !link.href.startsWith('/#')
    );

    for (const link of internalBodyLinks) {
      const normalized = normalizePath(link.href);
      if (!knownPaths.has(normalized)) {
        errors.push(`[${collectionName}/${entry.slug}] markdown link: "${link.href}" -> "${normalized}" is missing`);
      }
    }

    for (const link of markdownLinks) {
      if (!/^https?:\/\//i.test(link.href)) continue;
      const text = link.text.toLowerCase();
      const isCta = CTA_KEYWORDS.some((keyword) => text.includes(keyword));
      if (isCta) {
        errors.push(
          `[${collectionName}/${entry.slug}] external CTA is forbidden: anchor="${link.text}", href="${link.href}"`
        );
      }
    }

    if (options.checkOrphan) {
      const collectionEntries = collectionName === 'guides' ? guides : collectionName === 'faq' ? faq : articles;
      const autoRelated = buildAutoRelated(entry, collectionEntries).map((item) => item.slug);
      const manualRelated = related.filter(
        (slug) => articleSlugs.has(slug) || guideSlugs.has(slug) || faqSlugs.has(slug)
      );
      const hasInternalLinks = internalLinks.length > 0 || internalBodyLinks.length > 0;
      const hasRelatedLinks = manualRelated.length > 0 || autoRelated.length > 0;
      if (!hasInternalLinks && !hasRelatedLinks) {
        errors.push(
          `[${collectionName}/${entry.slug}] orphan page: no internal links in body/frontmatter and no related links in cluster graph`
        );
      }
    }
  };

  for (const article of articles) {
    validateEntry(article, 'articles', { checkRelated: true, checkOrphan: true });
  }

  for (const guide of guides) {
    validateEntry(guide, 'guides', { checkRelated: true, checkOrphan: true });
  }

  for (const item of faq) {
    validateEntry(item, 'faq', { checkRelated: true, checkOrphan: true });
  }

  if (errors.length > 0) {
    console.error(`Content lint failed (${errors.length}):\n${errors.join('\n')}`);
    process.exit(1);
  }

  console.log(
    `Content lint passed: ${articles.length} articles, ${guides.length} guides, ${faq.length} faq entries; link graph is clean.`
  );
}

lint();
