import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import limax from 'limax';
import { loadIndexabilityPolicyModule } from './lib/load-indexability-policy.mjs';
import { loadCanonicalModule } from './lib/load-canonical.mjs';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');

const CITIES_PATH = path.join(DATA_DIR, 'cities.json');
const SERVICES_PATH = path.join(DATA_DIR, 'services.json');
const FAQ_TEMPLATES_PATH = path.join(DATA_DIR, 'faq-templates.json');
const GENERATED_PAGES_PATH = path.join(DATA_DIR, 'generated-pages.json');
const ARTICLE_SEO_STATE_PATH = path.join(DATA_DIR, 'article-seo-state.json');
const FUNNEL_PUBLIC_PAGES_PATH = path.join(DATA_DIR, 'funnel-public-pages.json');
const ARTICLE_CONTENT_DIR = path.join(ROOT, 'src', 'content', 'articles');
const GUIDES_CONTENT_DIR = path.join(ROOT, 'src', 'content', 'guides');
const FAQ_CONTENT_DIR = path.join(ROOT, 'src', 'content', 'faq');
const PROJECTS_CONTENT_DIR = path.join(ROOT, 'src', 'content', 'projects');
const SITEMAP_OUTPUT_DIR = path.resolve(process.env.BUILD_DATA_SITEMAP_DIR || path.join(ROOT, '.tmp', 'build-data', 'sitemaps'));
const SITEMAP_CHUNK_LIMIT = 50000;

const DEFAULT_GUIDE_BY_SERVICE = {
  'kuhni-na-zakaz': '/guides/process-izgotovleniya-kuhni/',
  'shkafy-kupe': '/articles/kak-vybrat-shkaf-na-zakaz/',
  garderobnye: '/articles/organizacija-shkafa/',
};

const DEFAULT_MAX_GENERATED_PAGES = 200;
const MAX_GENERATED_PAGES = parsePositiveInt(process.env.MAX_GENERATED_PAGES, DEFAULT_MAX_GENERATED_PAGES, 1);

function parsePositiveInt(value, fallback, min = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function normalizePath(pathname) {
  const normalized = `/${String(pathname || '').replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '');
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveServiceForms(service) {
  const forms = service?.forms || {};
  return {
    nominative: String(forms.nominative || '').trim(),
    genitive: String(forms.genitive || '').trim(),
    prepositional: String(forms.prepositional || '').trim(),
    accusative: String(forms.accusative || '').trim(),
  };
}

function resolveServicePathSegment(service) {
  return normalizeToken(service?.pathSegment || service?.id);
}

function buildServiceSlug(servicePathSegment) {
  const normalizedService = normalizeToken(servicePathSegment);
  if (!normalizedService) return '/';
  return normalizePath(`/${normalizedService}`);
}

function applyTemplate(template, vars) {
  let output = String(template || '');
  for (const [key, value] of Object.entries(vars)) {
    output = output.replaceAll(`{${key}}`, String(value));
  }
  return output.replace(/\s+/g, ' ').trim();
}

function addRelated(related, link) {
  if (!link || !isNonEmptyString(link.href) || !isNonEmptyString(link.title)) return;
  const normalizedHref = normalizePath(link.href);
  if (related.some((item) => item.href === normalizedHref)) return;
  related.push({
    title: String(link.title).trim(),
    href: normalizedHref,
    relation: link.relation || 'supporting',
  });
}

function buildFaqByPage({ page, faqTemplates, serviceForms }) {
  const templates = Array.isArray(faqTemplates?.[page.serviceId]) ? faqTemplates[page.serviceId] : [];
  const vars = {
    service: page.serviceName,
    serviceLower: serviceForms.genitive,
    serviceNominative: serviceForms.nominative,
    serviceGenitive: serviceForms.genitive,
    servicePrepositional: serviceForms.prepositional,
    serviceAccusative: serviceForms.accusative,
    location: page.cityNameIn,
    city: page.cityName,
    cityIn: page.cityNameIn,
    cityGenitive: page.cityNameGenitive,
    district: '',
    districtIn: '',
    timeRange: '7-21',
  };

  return templates
    .map((item) => ({
      q: applyTemplate(item.q, vars),
      a: applyTemplate(item.a, vars),
    }))
    .filter((item) => isNonEmptyString(item.q) && isNonEmptyString(item.a));
}

function buildRelatedLinks({ page, pages }) {
  const related = [];

  const siblingServices = pages.filter((candidate) => candidate.serviceId !== page.serviceId);
  for (const siblingService of siblingServices.slice(0, 2)) {
    addRelated(related, {
      title: siblingService.serviceName,
      href: siblingService.pageSlug,
      relation: 'service-sibling',
    });
  }

  const guideLink = DEFAULT_GUIDE_BY_SERVICE[page.serviceId];
  if (guideLink) {
    addRelated(related, {
      title: `Полезный материал: ${page.serviceName}`,
      href: guideLink,
      relation: 'guide',
    });
  }

  addRelated(related, {
    title: 'Реальные кейсы',
    href: '/projects/',
    relation: 'projects',
  });

  return related.slice(0, 6);
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function validateDataModel({ cities, services, faqTemplates }) {
  const errors = [];

  if (!Array.isArray(cities) || cities.length === 0) {
    errors.push('[cities] must contain at least one city');
  }
  if (!Array.isArray(services) || services.length === 0) {
    errors.push('[services] must contain at least one service');
  }
  if (!faqTemplates || typeof faqTemplates !== 'object') {
    errors.push('[faq-templates] must be an object');
  }

  for (const city of cities || []) {
    if (!isNonEmptyString(city.id)) errors.push('[cities] each city must have non-empty id');
    if (!isNonEmptyString(city.name)) errors.push(`[cities:${city?.id || 'unknown'}] "name" must be non-empty`);
    if (!isNonEmptyString(city.nameIn)) errors.push(`[cities:${city?.id || 'unknown'}] "nameIn" must be non-empty`);
    if (!isNonEmptyString(city.nameGenitive)) {
      errors.push(`[cities:${city?.id || 'unknown'}] "nameGenitive" must be non-empty`);
    }
  }

  const moneyServices = (services || []).filter((service) => service?.moneyPage === true);
  if (moneyServices.length === 0) {
    errors.push('[services] at least one service must have moneyPage=true');
  }

  const pathSegments = new Set();
  for (const service of services || []) {
    if (!isNonEmptyString(service.id)) errors.push('[services] each service must have non-empty id');
    if (!isNonEmptyString(service.name)) {
      errors.push(`[services:${service?.id || 'unknown'}] "name" must be non-empty`);
    }
    const forms = resolveServiceForms(service);
    if (!forms.nominative) {
      errors.push(`[services:${service?.id || 'unknown'}] "forms.nominative" must be non-empty`);
    }
    if (!forms.genitive) {
      errors.push(`[services:${service?.id || 'unknown'}] "forms.genitive" must be non-empty`);
    }
    if (!forms.prepositional) {
      errors.push(`[services:${service?.id || 'unknown'}] "forms.prepositional" must be non-empty`);
    }
    if (!forms.accusative) {
      errors.push(`[services:${service?.id || 'unknown'}] "forms.accusative" must be non-empty`);
    }
    const pathSegment = resolveServicePathSegment(service);
    if (!pathSegment) {
      errors.push(`[services:${service?.id || 'unknown'}] "pathSegment" must be non-empty`);
    }
    if (pathSegments.has(pathSegment)) {
      errors.push(`[services] duplicate pathSegment "${pathSegment}"`);
    }
    pathSegments.add(pathSegment);
    if (service.hasDistrictPages === true) {
      errors.push(`[services:${service?.id || 'unknown'}] district pages are not allowed (must be false)`);
    }
  }

  return errors;
}

function buildGeneratedPages({ cities, services, faqTemplates }) {
  const moneyServices = services.filter((service) => service.moneyPage === true);
  const orderedCities = [...cities].sort((a, b) => Number(a.priority) - Number(b.priority));
  const primaryCity = orderedCities[0];
  if (!primaryCity) {
    throw new Error('[build-data] cities list is empty');
  }

  const basePages = moneyServices.map((service) => {
    const servicePathSegment = resolveServicePathSegment(service);
    return {
      cityId: primaryCity.id,
      cityName: primaryCity.name,
      cityNameIn: primaryCity.nameIn,
      cityNameGenitive: primaryCity.nameGenitive,
      serviceId: service.id,
      serviceName: service.name,
      pageType: 'service-money',
      clusterId: `service:${service.id}:money`,
      pageSlug: buildServiceSlug(servicePathSegment),
      locationLabel: `${primaryCity.name} и область`,
      primaryKeyword: normalizeText(`${service.name} ${primaryCity.name}`),
    };
  });

  return basePages.map((page) => ({
    ...page,
    faq: buildFaqByPage({
      page,
      faqTemplates,
      serviceForms: resolveServiceForms(moneyServices.find((service) => service.id === page.serviceId)),
    }),
    related: buildRelatedLinks({ page, pages: basePages }),
    priorityTier: 'A',
    priorityScore: 85,
    readinessScore: 100,
    indexabilityPolicy: 'index',
    releaseStage: 'index_stable',
    rolloutDecisionReason: 'service-only consolidation architecture',
  }));
}

function validateGeneratedPages({ generatedPages, services }) {
  const errors = [];
  if (!Array.isArray(generatedPages) || generatedPages.length === 0) {
    errors.push('[generated-pages] must contain at least one page');
    return errors;
  }

  const expectedCount = services.filter((service) => service.moneyPage === true).length;
  if (generatedPages.length !== expectedCount) {
    errors.push(`[generated-pages] expected ${expectedCount} pages, got ${generatedPages.length}`);
  }

  const seen = new Set();
  for (const page of generatedPages) {
    const slug = normalizePath(page?.pageSlug || '');

    if (seen.has(slug)) errors.push(`[generated-pages] duplicate pageSlug "${slug}"`);
    seen.add(slug);

    if (page?.pageType !== 'service-money') {
      errors.push(
        `[generated-pages] only service-money pages are allowed, got "${String(page?.pageType || '')}" (${slug})`
      );
    }
    if (slug === '/' || slug.split('/').filter(Boolean).length !== 1) {
      errors.push(`[generated-pages] ${slug} must be a single-segment money URL`);
    }
    if (String(page?.indexabilityPolicy || '') !== 'index') {
      errors.push(`[generated-pages] ${slug} must have indexabilityPolicy="index"`);
    }
    if (String(page?.releaseStage || '') !== 'index_stable') {
      errors.push(`[generated-pages] ${slug} must have releaseStage="index_stable"`);
    }
  }

  return errors;
}

function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function extractFrontmatter(rawSource) {
  const source = String(rawSource || '');
  if (!source.startsWith('---')) return null;

  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? String(match[1] || '') : null;
}

function getSlugFromArticleFilename(fileName) {
  return String(fileName || '')
    .replace(/\.mdx?$/i, '')
    .trim();
}

function slugifySegment(value) {
  const normalized = limax(String(value || '').trim()).toLowerCase();
  return normalized
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildProjectTitleSlugSegment(title, city) {
  const cityStem = slugifySegment(city);
  let normalizedTitle = slugifySegment(title);

  if (!normalizedTitle) return '';

  if (cityStem) {
    normalizedTitle = normalizedTitle.replace(
      new RegExp(`-na-zakaz(?:-(?:v|vo)-${cityStem}[a-z0-9-]*)?$`, 'i'),
      ''
    );
    normalizedTitle = normalizedTitle.replace(new RegExp(`-(?:v|vo)-${cityStem}[a-z0-9-]*$`, 'i'), '');
  } else {
    normalizedTitle = normalizedTitle.replace(/-na-zakaz$/i, '');
  }

  return normalizedTitle.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function resolveProjectSlug(frontmatter, slugFromFile) {
  const explicit = String(frontmatter?.slug || '').trim();
  if (explicit) return explicit;

  const serviceCode = normalizeToken(frontmatter?.service);
  const serviceTokenByCode = {
    kuhni: 'kuhnya',
    shkafy: 'shkaf',
    garderobnye: 'garderobnaya',
  };
  const serviceToken = serviceTokenByCode[serviceCode] || serviceCode || 'project';
  const cityToken = slugifySegment(frontmatter?.city || '');
  const streetToken = slugifySegment(frontmatter?.street || '');
  const titleToken = buildProjectTitleSlugSegment(frontmatter?.title || '', frontmatter?.city || '');

  if (!streetToken && titleToken) {
    const titleHasServiceToken =
      titleToken === serviceToken ||
      titleToken.startsWith(`${serviceToken}-`) ||
      titleToken.endsWith(`-${serviceToken}`) ||
      titleToken.includes(`-${serviceToken}-`);

    const parts = [titleHasServiceToken ? '' : serviceToken, titleToken, cityToken].filter(Boolean);
    if (parts.length > 0) return parts.join('-');
  }

  const parts = [serviceToken, frontmatter?.layout, frontmatter?.city, frontmatter?.street]
    .map((value) => slugifySegment(String(value || '')))
    .filter(Boolean);

  return parts.join('-') || slugFromFile;
}

async function listMarkdownFilesRecursive(dirPath) {
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const targetPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFilesRecursive(targetPath)));
      continue;
    }
    if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
      files.push(targetPath);
    }
  }

  return files;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function resolveLastmod(frontmatter) {
  const updatedAt = parseDate(frontmatter?.updateDate ?? frontmatter?.updatedAt);
  const createdAt = parseDate(frontmatter?.publishDate ?? frontmatter?.createdAt);
  return updatedAt || createdAt || null;
}

async function loadMarkdownEntries(dirPath) {
  const files = await listMarkdownFilesRecursive(dirPath);
  const entries = [];

  for (const filePath of files) {
    const source = await fs.readFile(filePath, 'utf8');
    const frontmatterSource = extractFrontmatter(source);
    const frontmatter = frontmatterSource ? yaml.load(frontmatterSource) : {};
    const slugFromFile = getSlugFromArticleFilename(path.basename(filePath));
    const slug =
      dirPath === PROJECTS_CONTENT_DIR
        ? resolveProjectSlug(frontmatter || {}, slugFromFile)
        : String(frontmatter?.slug || slugFromFile).trim();

    entries.push({
      filePath,
      slug,
      frontmatter: frontmatter || {},
      lastmod: resolveLastmod(frontmatter),
    });
  }

  return entries;
}

async function buildArticleSeoState() {
  const entries = await loadMarkdownEntries(ARTICLE_CONTENT_DIR);
  const readyArticlePaths = [];
  const archivedArticlePaths = [];
  const noindexArticlePaths = [];

  for (const entry of entries) {
    const frontmatter = entry.frontmatter || {};
    const draft = Boolean(frontmatter?.draft);
    if (draft) continue;

    const isArchived = Boolean(frontmatter?.isArchived);
    const noindex = Boolean(frontmatter?.noindex);
    const seoReady = Boolean(frontmatter?.seoReady);

    const slug = String(frontmatter?.slug || entry.slug).trim();
    if (!slug) continue;
    const articlePath = normalizePath(`/articles/${slug}`);

    if (isArchived) {
      archivedArticlePaths.push(articlePath);
    }

    if (noindex) {
      noindexArticlePaths.push(articlePath);
    }

    if (!isArchived && !noindex && seoReady) {
      readyArticlePaths.push(articlePath);
    }
  }

  readyArticlePaths.sort();
  archivedArticlePaths.sort();
  noindexArticlePaths.sort();

  return {
    readyArticlePaths,
    archivedArticlePaths,
    noindexArticlePaths,
    hasReadyArticles: readyArticlePaths.length > 0,
  };
}

async function buildFunnelPublicPages({ cities, services, generatedPages }) {
  const orderedCities = [...cities].sort((a, b) => Number(a.priority) - Number(b.priority));
  const primaryCityId = String(orderedCities[0]?.id || '').trim();
  const serviceByPathSegment = new Map(
    services.map((service) => [normalizeToken(service.pathSegment || service.id), service])
  );
  const knownCityIds = new Set(cities.map((city) => String(city.id || '').trim()).filter(Boolean));
  const dimensionsByPath = new Map();

  const addPage = ({ pageSlug, city = '', district = '', service = '', pageType }) => {
    const normalizedSlug = normalizePath(pageSlug);
    if (dimensionsByPath.has(normalizedSlug)) {
      throw new Error(`[build-data] duplicate funnel page route "${normalizedSlug}"`);
    }
    dimensionsByPath.set(normalizedSlug, {
      pageSlug: normalizedSlug,
      city: String(city || '').trim(),
      district: String(district || '').trim(),
      service: String(service || '').trim(),
      pageType: String(pageType || '').trim(),
    });
  };

  addPage({ pageSlug: '/', city: primaryCityId, pageType: 'homepage' });
  addPage({ pageSlug: '/contacts', city: primaryCityId, pageType: 'site' });
  addPage({ pageSlug: '/projects', city: primaryCityId, pageType: 'projects' });

  for (const page of generatedPages) {
    addPage({
      pageSlug: page.pageSlug,
      city: page.cityId,
      service: page.serviceId,
      pageType: page.pageType,
    });
  }

  const projects = await loadMarkdownEntries(PROJECTS_CONTENT_DIR);
  for (const entry of projects) {
    const data = entry.frontmatter || {};
    if (data.draft) continue;

    const slug = String(entry.slug || '').trim();
    const city = String(data.city || '').trim();
    const projectService = serviceByPathSegment.get(normalizeToken(data.service));
    if (!slug || !knownCityIds.has(city) || !projectService) {
      throw new Error(
        `[build-data] published project "${path.basename(entry.filePath)}" has unresolved funnel dimensions`
      );
    }

    addPage({
      pageSlug: `/projects/${slug}`,
      city,
      service: projectService.id,
      pageType: 'project',
    });
  }

  return [...dimensionsByPath.values()].sort((a, b) => a.pageSlug.localeCompare(b.pageSlug));
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSitemapXml(entries) {
  const items = entries
    .map((entry) => {
      const lastmod = entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : '';
      return `<url><loc>${escapeXml(entry.loc)}</loc>${lastmod}</url>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</urlset>`;
}

function buildSitemapIndexXml(entries) {
  const items = entries
    .map((entry) => {
      const lastmod = entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : '';
      return `<sitemap><loc>${escapeXml(entry.loc)}</loc>${lastmod}</sitemap>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</sitemapindex>`;
}

async function writeSitemaps(entries, siteUrl) {
  await fs.rm(SITEMAP_OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(SITEMAP_OUTPUT_DIR, { recursive: true });
  if (entries.length <= SITEMAP_CHUNK_LIMIT) {
    const xml = buildSitemapXml(entries);
    await fs.writeFile(path.join(SITEMAP_OUTPUT_DIR, 'sitemap.xml'), `${xml}\n`, 'utf8');
    const indexEntries = [
      {
        loc: new URL('/sitemap.xml', siteUrl).toString(),
        lastmod: entries[0]?.lastmod || undefined,
      },
    ];
    const indexXml = buildSitemapIndexXml(indexEntries);
    await fs.writeFile(path.join(SITEMAP_OUTPUT_DIR, 'sitemap-index.xml'), `${indexXml}\n`, 'utf8');
    return { files: 2 };
  }

  const chunks = [];
  for (let i = 0; i < entries.length; i += SITEMAP_CHUNK_LIMIT) {
    chunks.push(entries.slice(i, i + SITEMAP_CHUNK_LIMIT));
  }

  const indexEntries = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunkName = `sitemap-${i + 1}.xml`;
    const chunkPath = path.join(SITEMAP_OUTPUT_DIR, chunkName);
    const xml = buildSitemapXml(chunks[i]);
    await fs.writeFile(chunkPath, `${xml}\n`, 'utf8');
    indexEntries.push({
      loc: new URL(`/${chunkName}`, siteUrl).toString(),
      lastmod: chunks[i][0]?.lastmod || undefined,
    });
  }

  const indexXml = buildSitemapIndexXml(indexEntries);
  await fs.writeFile(path.join(SITEMAP_OUTPUT_DIR, 'sitemap-index.xml'), `${indexXml}\n`, 'utf8');
  await fs.writeFile(path.join(SITEMAP_OUTPUT_DIR, 'sitemap.xml'), `${indexXml}\n`, 'utf8');
  return { files: chunks.length + 2 };
}

async function generateSeoArtifacts({ generatedPages }) {
  const publicSiteUrl = String(process.env.PUBLIC_SITE_URL || '').trim();
  if (!publicSiteUrl) {
    throw new Error('[build-data] PUBLIC_SITE_URL is required to generate sitemap.');
  }
  const siteUrl = new URL(publicSiteUrl);

  const [articles, guides, faq, projects] = await Promise.all([
    loadMarkdownEntries(ARTICLE_CONTENT_DIR),
    loadMarkdownEntries(GUIDES_CONTENT_DIR),
    loadMarkdownEntries(FAQ_CONTENT_DIR),
    loadMarkdownEntries(PROJECTS_CONTENT_DIR),
  ]);

  const candidateRoutes = new Map();

  const activeArticles = articles.filter((entry) => !entry.frontmatter?.draft);
  const activeGuides = guides.filter((entry) => !entry.frontmatter?.draft);
  const activeFaq = faq.filter((entry) => !entry.frontmatter?.draft);
  const activeProjects = projects.filter((entry) => !entry.frontmatter?.draft);

  const { getIndexabilityPolicy, INDEX_PATHS, TEMP_NOINDEX_PATHS, NOINDEX_FOLLOW_PATHS } =
    await loadIndexabilityPolicyModule();

  const staticPatterns = [...INDEX_PATHS, ...TEMP_NOINDEX_PATHS, ...NOINDEX_FOLLOW_PATHS].filter(
    (pattern) => !pattern.endsWith('/*')
  );
  for (const route of staticPatterns) {
    candidateRoutes.set(normalizePath(route), { lastmod: null });
  }

  for (const page of generatedPages || []) {
    const slug = normalizePath(page?.pageSlug || '');
    if (!slug || slug === '/') continue;
    candidateRoutes.set(slug, { lastmod: null });
  }

  for (const entry of activeGuides) {
    const data = entry.frontmatter || {};
    const slug = String(data.slug || entry.slug).trim();
    if (!slug) continue;
    candidateRoutes.set(normalizePath(`/guides/${slug}`), { lastmod: entry.lastmod });
  }

  for (const entry of activeFaq) {
    const data = entry.frontmatter || {};
    const slug = String(data.slug || entry.slug).trim();
    if (!slug) continue;
    candidateRoutes.set(normalizePath(`/faq/${slug}`), { lastmod: entry.lastmod });
  }

  for (const entry of activeProjects) {
    const data = entry.frontmatter || {};
    const slug = String(data.slug || entry.slug).trim();
    if (!slug) continue;
    candidateRoutes.set(normalizePath(`/projects/${slug}`), { lastmod: entry.lastmod });
  }

  for (const entry of activeArticles) {
    const data = entry.frontmatter || {};
    const slug = String(data.slug || entry.slug).trim();
    if (!slug) continue;
    candidateRoutes.set(normalizePath(`/articles/${slug}`), { lastmod: entry.lastmod });
  }

  const totalContentCount =
    activeArticles.length +
    activeGuides.length +
    activeFaq.length +
    activeProjects.length +
    (Array.isArray(generatedPages) ? generatedPages.length : 0) +
    staticPatterns.length;
  const minExpected = Math.max(1, Math.floor(totalContentCount * 0.7));

  const { getCanonicalUrl } = await loadCanonicalModule();

  const indexableEntries = [];

  for (const [routePath, meta] of candidateRoutes.entries()) {
    const policy = getIndexabilityPolicy(routePath);
    if (!policy.includeInSitemap) continue;

    const canonicalUrl = getCanonicalUrl(new URL(routePath, siteUrl));
    indexableEntries.push({
      loc: canonicalUrl,
      lastmod: meta?.lastmod ? meta.lastmod.toISOString() : undefined,
    });
  }

  indexableEntries.sort((a, b) => a.loc.localeCompare(b.loc));

  if (indexableEntries.length < minExpected) {
    throw new Error(
      `[build-data] indexable pages dropped unexpectedly: got ${indexableEntries.length}, expected >= ${minExpected}`
    );
  }

  const result = await writeSitemaps(indexableEntries, siteUrl);
  console.log(
    `[build-data] sitemap generated: entries=${indexableEntries.length}, files=${result.files}, output=${SITEMAP_OUTPUT_DIR}`
  );
}

async function main() {
  const [cities, services, faqTemplates] = await Promise.all([
    readJson(CITIES_PATH),
    readJson(SERVICES_PATH),
    readJson(FAQ_TEMPLATES_PATH),
  ]);

  const modelErrors = validateDataModel({ cities, services, faqTemplates });
  if (modelErrors.length > 0) {
    throw new Error(`Data model validation failed:\n${modelErrors.join('\n')}`);
  }

  const generatedPages = buildGeneratedPages({ cities, services, faqTemplates });
  const articleSeoState = await buildArticleSeoState();
  const funnelPublicPages = await buildFunnelPublicPages({ cities, services, generatedPages });

  if (generatedPages.length > MAX_GENERATED_PAGES) {
    throw new Error(
      `[build-data] overgeneration guard: generated ${generatedPages.length} pages exceeds MAX_GENERATED_PAGES=${MAX_GENERATED_PAGES}`
    );
  }

  const artifactErrors = validateGeneratedPages({ generatedPages, services });
  if (artifactErrors.length > 0) {
    throw new Error(`Generated artifact validation failed:\n${artifactErrors.join('\n')}`);
  }

  await fs.writeFile(GENERATED_PAGES_PATH, stringifyJson(generatedPages), 'utf8');
  await fs.writeFile(ARTICLE_SEO_STATE_PATH, stringifyJson(articleSeoState), 'utf8');
  await fs.writeFile(FUNNEL_PUBLIC_PAGES_PATH, stringifyJson(funnelPublicPages), 'utf8');

  await generateSeoArtifacts({ generatedPages });

  console.log(`[build-data] wrote ${generatedPages.length} generated pages`);
  console.log(
    `[build-data] wrote article seo state: ready=${articleSeoState.readyArticlePaths.length}, archived=${articleSeoState.archivedArticlePaths.length}, noindex=${articleSeoState.noindexArticlePaths.length}, hasReadyArticles=${articleSeoState.hasReadyArticles}`
  );
  console.log(`[build-data] wrote ${funnelPublicPages.length} trusted funnel pages`);
  console.log('[build-data] model: service-only money pages');
}

main().catch((error) => {
  console.error('[build-data] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
