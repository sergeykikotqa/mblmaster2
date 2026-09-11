import type { CollectionEntry } from 'astro:content';
import type { ImageMetadata } from 'astro';
import { getImage } from 'astro:assets';

import { getBusinessInfo } from '~/config/business-info';
import { toAbsoluteUrl, toCanonical } from '~/lib/url-builder';
import { generateAlt } from '~/utils/slugify';
import { findImage } from '~/utils/images';
import {
  generateMicroGeoText,
  generateProjectDescription,
  generateProjectHeading,
  getCityLabels,
  getServiceLabels,
} from '~/utils/seo';

import {
  normalizeProjectContent,
  resolveProjectImage,
  type NormalizedProjectContent,
} from './normalized-project-content';
import { getRelatedEntities } from '~/lib/entities/get-related-entities';
import type {
  ProjectBreadcrumbItem,
  ProjectCardData,
  ProjectCostBreakdownItem,
  ProjectHeroStat,
  ProjectHeroTag,
  ProjectQuickSpec,
  ProjectRailBenefit,
  ProjectSummaryFact,
  ProjectTocItem,
} from '~/types/project';

type ProjectEntry = CollectionEntry<'projects'>;
type ArticleEntry = CollectionEntry<'articles'>;
type ProjectBlock = NonNullable<ProjectEntry['data']['blocks']>[number];
type MaterialsProjectBlock = Extract<ProjectBlock, { type: 'materials' }>;
type ProcessProjectBlock = Extract<ProjectBlock, { type: 'process' }>;
type BeforeAfterProjectBlock = Extract<ProjectBlock, { type: 'beforeAfter' }>;

type ProjectMaterialItem = { label: string; value: string; icon: string };
type ProjectProcessStep = { title: string; description: string; meta?: string };

type ProjectHeroModel = {
  heading: string;
  description: string;
  microGeoText: string;
  cityLabel: string;
  cityInCase?: string;
  heroImage?: string;
  heroAlt: string;
  quickSpecs: ProjectQuickSpec[];
  service: string;
  hasGallery: boolean;
  heroTags: ProjectHeroTag[];
  heroStats: ProjectHeroStat[];
  breadcrumbs: ProjectBreadcrumbItem[];
  rating?: { value: string; label: string } | null;
};

type ProjectAboutModel = {
  title: string;
  paragraphs: string[];
  image: string;
  highlights: Array<{ title: string; description: string; icon: string }>;
  hasSection: boolean;
};

type ProjectCostModel = {
  label: string;
  note: string;
  breakdown: ProjectCostBreakdownItem[];
  summaryPrice: string;
  hasCost: boolean;
};

type ProjectCtaDefaults = {
  title: string;
  highlight: string;
  description: string;
  primaryLabel: string;
  secondaryLabel: string;
  backgroundImage: string;
  backgroundStyle: string;
};

type ProjectSectionVisibility = {
  hasHero: boolean;
  hasGallery: boolean;
  hasSpecs: boolean;
  hasCost: boolean;
  hasTask: boolean;
  hasSolution: boolean;
  hasMaterials: boolean;
  hasProcess: boolean;
  hasCompare: boolean;
  hasVideo: boolean;
  hasResult: boolean;
  hasFaq: boolean;
  hasLinks: boolean;
  hasCta: boolean;
};

export type ProjectViewModel = {
  entry: ProjectEntry;
  project: NormalizedProjectContent;
  data: NormalizedProjectContent['data'];
  slug: string;
  heading: string;
  pageTitle: string;
  description: string;
  shortDescription: string;
  metaDescription: string;
  canonicalPath: string;
  canonicalUrl: string;
  projectDate: Date;
  metadata: {
    title: string;
    description: string;
    canonical: string;
    openGraph?: {
      type: string;
      images?: Array<{ url: string; width: number; height: number }>;
    };
  };
  preloadImage: { href: string; srcset?: string; sizes?: string; type?: string } | null;
  labels: {
    city: ReturnType<typeof getCityLabels>;
    service: ReturnType<typeof getServiceLabels>;
    layoutLabel: string;
    serviceLinkText: string;
  };
  hero: ProjectHeroModel;
  heroBackgroundImage: string;
  heroBackgroundAlt: string;
  gallery: {
    images: string[];
    imagesForBlocks: string[];
    alt: string;
    captions: Record<string, string>;
    heroImage: string;
  };
  about: ProjectAboutModel;
  task: {
    text: string;
    bullets: string[];
    constraints: string[];
  };
  solution: {
    text: string;
    splitImage: string;
  };
  materials: {
    items: ProjectMaterialItem[];
    summary: string;
    railItems: ProjectMaterialItem[];
  };
  process: {
    steps: ProjectProcessStep[];
    image: string;
    railSteps: ProjectProcessStep[];
  };
  beforeAfter: {
    items: Array<{ beforeSrc: string; afterSrc: string; caption: string }>;
  };
  video: {
    data: ProjectEntry['data']['video'] | undefined;
    poster: string;
    thumbnailUrl: string;
    hasVideo: boolean;
  };
  faq: {
    items: Array<{ question: string; answer: string }>;
  };
  internalLinks: Array<{ text: string; href: string }>;
  cost: ProjectCostModel;
  summaryFacts: ProjectSummaryFact[];
  railFacts: ProjectSummaryFact[];
  railBenefits: ProjectRailBenefit[];
  shouldShowKeyFacts: boolean;
  tocItems: ProjectTocItem[];
  blocks: ProjectEntry['data']['blocks'] | null;
  hasBlocks: boolean;
  blockTypes: Set<string>;
  sectionVisibility: ProjectSectionVisibility;
  hasBodyContent: boolean;
  relatedProjects: ProjectCardData[];
  relatedArticles: Array<{ text: string; href: string }>;
  ctaDefaults: ProjectCtaDefaults;
  contact: {
    phone: string;
    phoneHref: string;
  };
  schemas: {
    breadcrumbSchema: Record<string, unknown>;
    productSchema: Record<string, unknown>;
    serviceSchema: Record<string, unknown>;
    articleSchema: Record<string, unknown>;
    creativeWorkSchema: Record<string, unknown>;
    videoSchema: Record<string, unknown> | null;
    faqSchema: Record<string, unknown> | null;
  };
};

export type ProjectViewModelParams = {
  entry: ProjectEntry;
  allProjects: ProjectEntry[];
  articles: ArticleEntry[];
  site?: URL;
};

const capitalize = (value: string) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : '');

const formatMoney = (value: number) =>
  `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value)} ₽`;

const isPresent = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;
const isMaterialsProjectBlock = (block: ProjectBlock): block is MaterialsProjectBlock => block.type === 'materials';
const isProcessProjectBlock = (block: ProjectBlock): block is ProcessProjectBlock => block.type === 'process';
const isBeforeAfterProjectBlock = (block: ProjectBlock): block is BeforeAfterProjectBlock =>
  block.type === 'beforeAfter';

export async function buildProjectViewModel({
  entry,
  allProjects,
  articles,
  site,
}: ProjectViewModelParams): Promise<ProjectViewModel> {
  const project = normalizeProjectContent(entry);
  const { data, slug, cityLabels, serviceLabels, serviceCode, imageBaseDir } = project;

  const hasBodyContent = project.body.trim().length > 0;

  const normalizeArticleSlug = (value: string): string => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    return trimmed
      .replace(/[?#].*$/, '')
      .replace(/^\/+/, '')
      .replace(/^articles\//, '')
      .replace(/\.mdx?$/, '');
  };

  const resolveArticleSlug = (article: ArticleEntry): string =>
    normalizeArticleSlug(String(article.data.slug || article.id));

  const articleIndex = new Map(
    articles.map((article) => {
      const articleSlug = resolveArticleSlug(article);
      return [articleSlug, { title: article.data.title, slug: articleSlug }];
    })
  );

  const resolveArticleLink = (value: string) => {
    const normalized = normalizeArticleSlug(value);
    if (!normalized) return null;
    const article = articleIndex.get(normalized);
    if (!article) return null;
    return { text: article.title || normalized, href: `/articles/${article.slug}` };
  };

  const normalizeInternalHref = (value: string) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  };

  const layoutLabel = String(data.layout || '').trim();
  const serviceLinkText = layoutLabel
    ? `${capitalize(layoutLabel)} ${serviceLabels.noun} на заказ`
    : `${serviceLabels.plural} на заказ`;

  const relatedEntities = getRelatedEntities({
    type: 'project',
    slug,
    projects: allProjects,
    articles,
    limits: { projects: 3, articles: 2, services: 1 },
  });

  const explicitInternalLinks = Array.isArray(data.internalLinks)
    ? data.internalLinks
        .map((item) => ({
          text: String(item.text || '').trim(),
          href: normalizeInternalHref(item.href),
        }))
        .filter((item) => item.text && item.href)
    : [];

  const fallbackLinksByService: Record<string, Array<{ text: string; href: string }>> = {
    kuhni: [
      { text: 'Кухни на заказ', href: '/kuhni' },
      { text: 'Как выбрать кухню на заказ', href: '/articles/kak-vybrat-kuhnyu-na-zakaz' },
      { text: 'Материалы для кухни', href: '/articles/materialy-dlya-kuhni' },
    ],
    shkafy: [
      { text: 'Шкафы-купе на заказ', href: '/shkafy' },
      { text: 'Как выбрать шкаф на заказ', href: '/articles/kak-vybrat-shkaf-na-zakaz' },
      { text: 'Раздвижные двери для шкафа', href: '/articles/razdvijnye-dveri-dlya-shkafa' },
    ],
    garderobnye: [
      { text: 'Гардеробные на заказ', href: '/garderobnye' },
      { text: 'Организация шкафа и гардеробной', href: '/articles/organizacija-shkafa' },
    ],
  };

  const manualRelatedArticleLinks = Array.isArray(data.relatedArticles)
    ? data.relatedArticles
        .map((slug) => resolveArticleLink(slug))
        .filter((item): item is { text: string; href: string } => Boolean(item))
    : [];

  const baseServiceLink = fallbackLinksByService[serviceCode]?.[0] || null;
  const fallbackServiceLink = baseServiceLink ? { ...baseServiceLink, text: serviceLinkText } : null;
  const fallbackArticleLinks = (fallbackLinksByService[serviceCode] || [])
    .slice(1)
    .map((link) => resolveArticleLink(link.href))
    .filter(Boolean);

  const fallbackInternalLinks = [
    fallbackServiceLink,
    ...(manualRelatedArticleLinks.length > 0 ? manualRelatedArticleLinks : fallbackArticleLinks),
  ].filter(
    (item): item is { text: string; href: string } => Boolean(item?.text) && Boolean(item?.href)
  );

  const resolvedInternalLinks = explicitInternalLinks.length > 0 ? explicitInternalLinks : fallbackInternalLinks;

  const rawTitle = project.title;
  const heading = rawTitle ? rawTitle.replace(/\s*\([^)]*\)\s*$/, '') : generateProjectHeading(data);
  const generatedDescription = generateProjectDescription(data);
  const description = generatedDescription;
  const shortDescription = project.description || generatedDescription.split('\n').find((line) => line.trim()) || generatedDescription;
  const metaDescription = project.description || generatedDescription;
  const microGeoText = generateMicroGeoText(data);
  const canonicalPath = toCanonical(`/projects/${slug}`, site);
  const canonicalUrl = toAbsoluteUrl(canonicalPath, site);
  const projectDate = project.publishDate;

  const moneyPageHref = `/${data.service}`;
  const moneyPageCanonicalUrl = toAbsoluteUrl(moneyPageHref, site);

  const galleryAlt = generateAlt(data.layout, cityLabels.base, data.street, data.service);
  const allImages = project.images;
  const normalizedImages = project.resolvedImages;
  const heroImage = project.coverImage;
  const heroAlt = heroImage ? `${galleryAlt} — главный кадр проекта` : galleryAlt;
  const heroBackgroundImage = '/images/cta/cta-kitchen.jpg';
  const heroBackgroundAlt = 'Фоновое изображение кейса';
  const galleryImages = allImages;
  const imageCaptions = project.imageCaptions;
  const blocks = Array.isArray(data.blocks) ? data.blocks : null;
  const hasBlocks = Boolean(blocks && blocks.length > 0);
  const firstHeadingFromBlocks = (() => {
    if (!blocks) return '';
    for (const block of blocks) {
      if (block && 'title' in block) {
        const title = String(block.title || '').trim();
        if (title) return title;
      }
    }
    return '';
  })();
  const pageTitle = rawTitle || firstHeadingFromBlocks || 'Без названия';
  const heroBlock = blocks?.find((block) => block.type === 'hero');
  const heroBlockImage =
    heroBlock && 'image' in heroBlock ? resolveProjectImage(slug, heroBlock.image, imageBaseDir) : '';
  const resolvedHeroImage = heroBlockImage || heroImage;
  const heroHeading = heroBlock && 'title' in heroBlock && heroBlock.title ? heroBlock.title : pageTitle;
  const heroDescription =
    heroBlock && 'description' in heroBlock && heroBlock.description ? heroBlock.description : shortDescription;
  const heroBadge = heroBlock && 'badge' in heroBlock && heroBlock.badge ? heroBlock.badge : cityLabels.base;
  const galleryImagesOverride = (() => {
    const galleryBlock = blocks?.find((block) => block.type === 'gallery');
    if (!galleryBlock || !('images' in galleryBlock)) return null;
    if (!Array.isArray(galleryBlock.images) || galleryBlock.images.length === 0) return null;
    return galleryBlock.images;
  })();
  const galleryImagesForBlocks = galleryImagesOverride ?? galleryImages;
  const splitImages = (galleryImagesOverride ?? allImages)
    .map((image, imageIndex) => resolveProjectImage(slug, image, imageBaseDir, imageIndex))
    .filter((image) => Boolean(String(image || '').trim()));
  const solutionSplitImage = splitImages.length > 1 ? splitImages[1] : '';
  const rawOgImage = resolvedHeroImage || heroImage;

  const isOptimizableImage = (value: ImageMetadata | string | null | undefined): value is ImageMetadata => {
    if (!value || typeof value !== 'object') return false;
    return Number.isFinite(value.width) && Number.isFinite(value.height);
  };
  const isDev = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);
  const safeGetImage = async (options: Parameters<typeof getImage>[0]) => {
    try {
      return await getImage(options);
    } catch (error) {
      if (isDev) {
        console.warn('[project-view-model] Failed to optimize image, using fallback.', error);
      }
      return null;
    }
  };

  const isRawProjectImagePath = (value: string | null | undefined): boolean =>
    String(value || '').includes('/images/projects/');
  const sanitizeProjectImagePath = (value: string | null | undefined): string => {
    const normalized = String(value || '').trim();
    if (!normalized) return '';
    return isRawProjectImagePath(normalized) ? '' : normalized;
  };

  const primaryGalleryImage = resolvedHeroImage || heroImage;
  const heroPreloadSource = primaryGalleryImage || heroBackgroundImage;
  const resolvedPrimaryGalleryImage = heroPreloadSource ? await findImage(heroPreloadSource) : null;
  let preloadImage: { href: string; srcset?: string; sizes?: string; type?: string } | null = null;
  if (resolvedPrimaryGalleryImage) {
    if (typeof resolvedPrimaryGalleryImage === 'string') {
      preloadImage = {
        href: resolvedPrimaryGalleryImage,
        type: resolvedPrimaryGalleryImage.endsWith('.webp') ? 'image/webp' : undefined,
      };
    }
  }

  const video = data.video;
  const businessInfo = getBusinessInfo();
  const companyName = process.env.SITE_NAME || 'мбл мастер';
  const normalizeVideoUrl = (value: string | undefined): string => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    return toAbsoluteUrl(trimmed, site);
  };

  const ogImage = sanitizeProjectImagePath(preloadImage?.href) || sanitizeProjectImagePath(rawOgImage);

  const videoThumbnailSource = video?.thumbnail || ogImage || '';
  const resolvedVideoThumbnail = videoThumbnailSource ? await findImage(videoThumbnailSource) : null;
  let videoThumbnailUrl = normalizeVideoUrl(videoThumbnailSource);
  if (resolvedVideoThumbnail && typeof resolvedVideoThumbnail !== 'string' && isOptimizableImage(resolvedVideoThumbnail)) {
    const optimizedThumbnail = await safeGetImage({
      src: resolvedVideoThumbnail,
      width: 1200,
      format: 'jpg',
      inferSize: true,
    });
    if (optimizedThumbnail?.src) {
      videoThumbnailUrl = toAbsoluteUrl(optimizedThumbnail.src, site);
    }
  }
  if (isRawProjectImagePath(videoThumbnailUrl)) {
    videoThumbnailUrl = ogImage ? toAbsoluteUrl(ogImage, site) : '';
  }
  const videoPoster = videoThumbnailUrl || resolvedHeroImage || heroImage || '';

  const materials: ProjectMaterialItem[] = [
    { label: 'Фасады', value: String(data.materials?.facade || '').trim(), icon: 'tabler:palette' },
    { label: 'Столешница', value: String(data.materials?.tabletop || '').trim(), icon: 'tabler:square' },
    { label: 'Корпус', value: String(data.materials?.corpus || '').trim(), icon: 'tabler:box' },
    { label: 'Фурнитура', value: String(data.materials?.hardware || '').trim(), icon: 'tabler:tool' },
  ].filter((item) => Boolean(item.value));

  const formatDays = (value: number) => {
    if (!Number.isFinite(value)) return '';
    const normalized = Number(value);
    if (normalized % 10 === 1 && normalized % 100 !== 11) return `${normalized} день`;
    if (normalized % 10 >= 2 && normalized % 10 <= 4 && (normalized % 100 < 10 || normalized % 100 >= 20)) {
      return `${normalized} дня`;
    }
    return `${normalized} дней`;
  };

  const formattedDuration = Number.isFinite(data.duration) ? formatDays(Number(data.duration)) : '';
  const formattedDurationShort = Number.isFinite(data.duration) ? `${Number(data.duration)} дн.` : '';
  const formattedArea = Number.isFinite(data.area) ? `${Number(data.area)} м²` : '';
  const quickSpecs = [
    data.layout ? { label: 'Тип', value: data.layout } : null,
    data.materials?.facade ? { label: 'Фасады', value: data.materials.facade } : null,
    formattedDuration ? { label: 'Срок изготовления', value: formattedDuration } : null,
  ].filter(isPresent);

  const taskText = String(data.task || '').trim();
  const solutionText = String(data.solution || '').trim();
  const processSteps = Array.isArray(data.process)
    ? data.process
        .map((step) => ({
          title: String(step.title || '').trim(),
          description: String(step.description || '').trim(),
          meta: String(step.meta || step.tag || step.label || '').trim(),
        }))
        .filter((step) => step.title && step.description)
    : [];

  const costData = data.cost || null;
  const hasCost =
    costData &&
    (Number.isFinite(costData.from) || Number.isFinite(costData.to) || Boolean(String(costData.note || '').trim()));

  const costFrom = Number.isFinite(costData?.from) ? formatMoney(Number(costData?.from)) : '';
  const costTo = Number.isFinite(costData?.to) ? formatMoney(Number(costData?.to)) : '';
  const costLabel = costFrom && costTo ? `от ${costFrom} до ${costTo}` : costFrom || costTo;
  const hasEstimatedPrice = project.hasEstimatedPrice;
  const resolvedPriceValue = project.resolvedPriceValue;
  const estimatedPriceNote = hasEstimatedPrice ? String(data.estimatedPriceNote || '').trim() : '';
  const formattedPrice = resolvedPriceValue !== null
    ? `${hasEstimatedPrice ? '~' : ''}${formatMoney(Number(resolvedPriceValue))}`
    : '';
  const costNote = String(costData?.note || '').trim() || estimatedPriceNote;
  const summaryPrice = costLabel || formattedPrice;
  const summaryMaterials = materials
    .filter((item) => ['Фасады', 'Столешница', 'Фурнитура'].includes(item.label))
    .slice(0, 3);
  const hasVideo = Boolean(video?.embedUrl);
  const materialsSummary = summaryMaterials.map((item) => item.value).join(', ');

  const beforeAfterItems = Array.isArray(data.beforeAfter)
    ? data.beforeAfter
        .map((item) => {
          const beforeSrc = resolveProjectImage(slug, item.before, imageBaseDir);
          const afterSrc = resolveProjectImage(slug, item.after, imageBaseDir);
          return {
            beforeSrc,
            afterSrc,
            caption: String(item.caption || '').trim(),
          };
        })
        .filter((item) => item.beforeSrc && item.afterSrc)
    : [];

  const fallbackFaq = [
    {
      question: `Сколько стоит ${serviceLabels.noun} на заказ в ${cityLabels.inCase}?`,
      answer:
        'Стоимость зависит от размеров, материалов и наполнения. После замера даем точную смету без скрытых позиций.',
    },
    {
      question: `Сколько времени занимает изготовление ${serviceLabels.genitive}?`,
      answer:
        'Срок определяется сложностью проекта и загрузкой производства. Обычно ориентир фиксируется в договоре после согласования проекта.',
    },
    {
      question: `Можно ли изменить проект ${serviceLabels.genitive} перед запуском?`,
      answer:
        'Да, корректировки вносятся на этапе согласования. Финальная версия фиксируется перед передачей в производство.',
    },
  ];

  const faqItems = Array.isArray(data.faq) && data.faq.length > 0 ? data.faq : fallbackFaq;

  const blockTypes = new Set((blocks || []).map((block) => block.type));
  const blockMaterialsItems =
    hasBlocks && blocks
      ? blocks.find(
          (block): block is MaterialsProjectBlock =>
            isMaterialsProjectBlock(block) && Array.isArray(block.items) && block.items.length > 0
        )
      : null;
  const blockProcessItems =
    hasBlocks && blocks
      ? blocks.find(
          (block): block is ProcessProjectBlock =>
            isProcessProjectBlock(block) && Array.isArray(block.steps) && block.steps.length > 0
        )
      : null;
  const blockBeforeAfterItems =
    hasBlocks && blocks
      ? blocks.find(
          (block): block is BeforeAfterProjectBlock =>
            isBeforeAfterProjectBlock(block) && Array.isArray(block.items) && block.items.length > 0
        )
      : null;
  const blockCost = hasBlocks && blocks ? blocks.find((block) => block.type === 'cost') : null;
  const blockTask = hasBlocks && blocks ? blocks.find((block) => block.type === 'task') : null;
  const blockSolution = hasBlocks && blocks ? blocks.find((block) => block.type === 'solution') : null;

  const sectionVisibility: ProjectSectionVisibility = {
    hasHero: hasBlocks ? blockTypes.has('hero') : true,
    hasGallery: hasBlocks ? blockTypes.has('gallery') && galleryImagesForBlocks.length > 0 : galleryImages.length > 0,
    hasSpecs: hasBlocks ? blockTypes.has('specs') : true,
    hasCost:
      hasBlocks && blockTypes.has('cost')
        ? Boolean(blockCost?.label || blockCost?.note || costLabel || costNote || formattedPrice)
        : Boolean(costLabel || formattedPrice),
    hasTask:
      hasBlocks && blockTypes.has('task') ? Boolean(blockTask?.text || taskText) : Boolean(taskText),
    hasSolution:
      hasBlocks && blockTypes.has('solution') ? Boolean(blockSolution?.text || solutionText) : Boolean(solutionText),
    hasMaterials:
      hasBlocks && blockTypes.has('materials')
        ? Boolean(blockMaterialsItems || materials.length > 0)
        : materials.length > 0,
    hasProcess:
      hasBlocks && blockTypes.has('process')
        ? Boolean(blockProcessItems || processSteps.length > 0)
        : processSteps.length > 0,
    hasCompare:
      hasBlocks && blockTypes.has('beforeAfter')
        ? Boolean(blockBeforeAfterItems || beforeAfterItems.length > 0)
        : beforeAfterItems.length > 0,
    hasVideo: hasBlocks ? blockTypes.has('video') && Boolean(video?.embedUrl) : Boolean(video?.embedUrl),
    hasResult: hasBlocks ? blockTypes.has('result') && hasBodyContent : hasBodyContent,
    hasFaq: hasBlocks ? blockTypes.has('faq') && faqItems.length > 0 : faqItems.length > 0,
    hasLinks: hasBlocks ? blockTypes.has('links') && resolvedInternalLinks.length > 0 : resolvedInternalLinks.length > 0,
    hasCta: hasBlocks ? blockTypes.has('cta') : true,
  };

  const videoFactTone: ProjectSummaryFact['tone'] = hasVideo ? 'success' : 'neutral';
  const compareFactTone: ProjectSummaryFact['tone'] = sectionVisibility.hasCompare ? 'success' : 'neutral';

  const summaryFactsRaw: ProjectSummaryFact[] = [
    { key: 'city', label: 'Город', value: cityLabels.base, icon: 'tabler:map-pin' },
    { key: 'type', label: 'Тип', value: serviceLabels.noun, icon: 'tabler:armchair' },
    { key: 'cost', label: hasEstimatedPrice ? 'Оценка' : 'Стоимость', value: summaryPrice, icon: 'tabler:wallet' },
    { key: 'duration', label: 'Срок', value: formattedDuration, icon: 'tabler:clock' },
    { key: 'materials', label: 'Материалы', value: materialsSummary, icon: 'tabler:layers-subtract' },
    { key: 'warranty', label: 'Гарантия', value: '2 года', icon: 'tabler:shield-check', tone: 'success' },
    { key: 'video', label: 'Видео', value: hasVideo ? 'Есть' : 'Нет', icon: 'tabler:video', tone: videoFactTone },
    {
      key: 'beforeAfter',
      label: 'До/после',
      value: sectionVisibility.hasCompare ? 'Есть' : 'Нет',
      icon: 'tabler:photo',
      tone: compareFactTone,
    },
  ];
  const summaryFacts: ProjectSummaryFact[] = summaryFactsRaw.filter((item) =>
    Boolean(String(item.value || '').trim())
  );

  const railFacts = summaryFacts.filter((item) =>
    ['city', 'type', 'cost', 'duration', 'materials', 'warranty'].includes(item.key)
  );

  const shouldShowKeyFacts = summaryFacts.length > 0;

  const projectYear = projectDate.getFullYear();

  const locationTag = [cityLabels.base, data.street || data.district || data.complex].filter(Boolean).join(', ');
  const yearTag = formattedDuration ? `${projectYear} год, ${formattedDuration}` : `${projectYear} год`;
  const heroTagsRaw: Array<ProjectHeroTag | null> = [
    locationTag ? { text: locationTag, tone: 'accent' } : null,
    yearTag ? { text: yearTag } : null,
  ];
  const heroTags: ProjectHeroTag[] = heroTagsRaw.filter(isPresent);

  const heroStats: ProjectHeroStat[] = [
    summaryPrice ? { label: hasEstimatedPrice ? 'оценка под ключ' : 'стоимость под ключ', value: summaryPrice } : null,
    formattedDurationShort ? { label: 'срок изготовления', value: formattedDurationShort } : null,
    formattedArea ? { label: `площадь ${serviceLabels.genitive}`, value: formattedArea } : null,
    { label: 'гарантия на изделие', value: '2 г.' },
  ].filter(isPresent);

  const breadcrumbs: ProjectBreadcrumbItem[] = [];

  const hasQuote = hasBlocks ? blockTypes.has('quote') : false;
  const heroRating = hasQuote ? { value: '5.0', label: 'отзыв клиента' } : null;

  const aboutTitleParts: string[] = [];
  if (data.complex) {
    aboutTitleParts.push(data.complex);
  } else if (data.street) {
    aboutTitleParts.push(data.street);
  } else if (data.district) {
    aboutTitleParts.push(`${data.district} район`);
  }
  const layoutTitle = layoutLabel ? `${capitalize(layoutLabel)} ${serviceLabels.noun}` : capitalize(serviceLabels.noun);
  const fallbackAboutTitle = rawTitle || `${layoutTitle}${formattedArea ? ` ${formattedArea}` : ''}`;
  const aboutTitle =
    aboutTitleParts.length > 0
      ? `${aboutTitleParts.join(', ')}, ${layoutTitle}${formattedArea ? ` ${formattedArea}` : ''}`
      : fallbackAboutTitle;
  const aboutParagraphsBase = generatedDescription
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const aboutParagraphs = aboutParagraphsBase.slice(0, 2);
  if (microGeoText && !aboutParagraphs.some((item) => item.includes(microGeoText)) && aboutParagraphs.length < 2) {
    aboutParagraphs.push(microGeoText);
  }

  const aboutImageCandidate = galleryImagesForBlocks[0] || '';
  const aboutImage = aboutImageCandidate
    ? resolveProjectImage(slug, aboutImageCandidate, imageBaseDir)
    : resolvedHeroImage || '';
  const aboutHighlights = [
    layoutLabel ? { title: 'Планировка', description: capitalize(layoutLabel), icon: 'tabler:layout-board' } : null,
    materials[0]
      ? { title: materials[0].label, description: String(materials[0].value || ''), icon: materials[0].icon }
      : null,
    formattedDuration ? { title: 'Срок изготовления', description: formattedDuration, icon: 'tabler:clock' } : null,
  ].filter(isPresent);
  const hasAboutSection = aboutParagraphs.length > 0 || Boolean(aboutImage);

  const splitSentences = (value: string) =>
    value
      .split(/\n+/)
      .flatMap((line) => line.split(/(?<=[.!?])\s+/))
      .map((item) => item.replace(/^[–-]\s*/, '').replace(/[.!?]+$/, '').trim())
      .filter(Boolean);

  const taskBullets = splitSentences(taskText).slice(0, 5);
  const constraintBullets = [
    formattedDuration ? `Срок — ${formattedDuration}` : null,
    summaryPrice ? `${hasEstimatedPrice ? 'Оценка бюджета' : 'Бюджет'} — ${summaryPrice}` : null,
    formattedArea ? `Площадь — ${formattedArea}` : null,
    materialsSummary ? `Материалы — ${materialsSummary}` : null,
    layoutLabel ? `Тип — ${layoutLabel}` : null,
  ]
    .filter((item): item is string => Boolean(item))
    .slice(0, 5);

  const processImageCandidate = galleryImagesForBlocks[1] || galleryImagesForBlocks[0] || '';
  const processImage = processImageCandidate
    ? resolveProjectImage(slug, processImageCandidate, imageBaseDir, 1)
    : '';

  const railProcessSteps = (() => {
    if (blockProcessItems && 'steps' in blockProcessItems && Array.isArray(blockProcessItems.steps)) {
      return blockProcessItems.steps
        .map((step) => ({
          title: String(step.title || '').trim(),
          description: String(step.description || '').trim(),
          meta: String(step.meta || step.tag || step.label || '').trim(),
        }))
        .filter((step) => step.title && step.description);
    }
    return processSteps;
  })();

  const railMaterials = (() => {
    if (blockMaterialsItems && Array.isArray(blockMaterialsItems.items)) {
      return blockMaterialsItems.items
        .map((item) => ({
          label: String(item.label || '').trim(),
          value: String(item.value || '').trim(),
          icon: String(item.icon || 'tabler:palette').trim(),
        }))
        .filter((item) => item.label && item.value);
    }
    return materials;
  })();

  const ctaBackground = '/images/cta/cta-kitchen.jpg';
  const ctaBackgroundStyle = ctaBackground ? `--cta-bg: url('${ctaBackground}')` : '';

  const costBreakdown: ProjectCostBreakdownItem[] = (() => {
    if (!Number.isFinite(resolvedPriceValue)) return [];
    const total = Number(resolvedPriceValue);
    if (total <= 0) return [];
    const round = (value: number) => Math.round(value / 1000) * 1000;
    return [
      {
        label: 'Производство',
        value: `~${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(round(total * 0.75))} ₽`,
        note: 'корпус, фасады, столешница',
      },
      {
        label: 'Фурнитура',
        value: `~${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(round(total * 0.15))} ₽`,
        note: materials[2]?.value || 'петли, направляющие',
      },
      {
        label: 'Монтаж',
        value: `~${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(round(total * 0.1))} ₽`,
        note: 'доставка + установка под ключ',
      },
    ];
  })();

  const railBenefits: ProjectRailBenefit[] = [
    { icon: 'tabler:shield-check', text: 'Гарантия 2 года на изделие' },
    { icon: 'tabler:tool', text: 'Монтаж под ключ по Иркутску' },
    { icon: 'tabler:calendar-event', text: 'Замер бесплатно в день обращения' },
    { icon: 'tabler:users', text: '300+ реализованных проектов' },
    { icon: 'tabler:map-pin', text: '10+ лет на рынке Иркутска' },
  ];

  const tocBase = [
    { id: 'overview', label: 'Обзор', visible: sectionVisibility.hasHero },
    { id: 'gallery', label: 'Галерея', visible: sectionVisibility.hasGallery },
    { id: 'specs', label: 'Характеристики', visible: sectionVisibility.hasSpecs },
    { id: 'cost', label: 'Стоимость', visible: sectionVisibility.hasCost },
    { id: 'task', label: 'Задача', visible: sectionVisibility.hasTask },
    { id: 'solution', label: 'Решение', visible: sectionVisibility.hasSolution },
    { id: 'materials', label: 'Материалы', visible: sectionVisibility.hasMaterials },
    { id: 'process', label: 'Процесс', visible: sectionVisibility.hasProcess },
    { id: 'before-after', label: 'До и после', visible: sectionVisibility.hasCompare },
    { id: 'video', label: 'Видео', visible: sectionVisibility.hasVideo },
    { id: 'result', label: 'Результат', visible: sectionVisibility.hasResult },
    { id: 'faq', label: 'Вопросы', visible: sectionVisibility.hasFaq },
    { id: 'links', label: 'Материалы по теме', visible: sectionVisibility.hasLinks },
    { id: 'cta', label: 'Расчет', visible: sectionVisibility.hasCta },
  ];

  const tocItems: ProjectTocItem[] = hasBlocks
    ? (() => {
        const items: ProjectTocItem[] = [];
        const seen = new Set<string>();
        const baseById = new Map(tocBase.map((item) => [item.id, item]));
        const typeToId = new Map<string, string>([
          ['hero', 'overview'],
          ['beforeAfter', 'before-after'],
        ]);
        let splitIndex = 0;
        let quoteIndex = 0;

        (blocks || []).forEach((block) => {
          if (block.type === 'split') {
            splitIndex += 1;
            const anchor = String(block.anchor || '').trim() || `split-${splitIndex}`;
            const label = String(block.tocLabel || block.title || '').trim();
            if (anchor && label && !seen.has(anchor)) {
              items.push({ id: anchor, label });
              seen.add(anchor);
            }
          } else if (block.type === 'quote') {
            quoteIndex += 1;
            const anchor = String(block.anchor || '').trim() || `quote-${quoteIndex}`;
            const label = String(block.tocLabel || 'Отзыв клиента').trim();
            if (anchor && label && !seen.has(anchor)) {
              items.push({ id: anchor, label });
              seen.add(anchor);
            }
          } else {
            const baseId = typeToId.get(block.type) || block.type;
            const base = baseById.get(baseId);
            if (base && base.visible && !seen.has(base.id)) {
              items.push({ id: base.id, label: base.label });
              seen.add(base.id);
            }
          }
        });

        return items;
      })()
    : tocBase.filter((item) => item.visible);

  const metadata = {
    title: data.title || heading,
    description: metaDescription,
    canonical: canonicalPath,
    openGraph: ogImage
      ? {
          type: 'article',
          images: [
            {
              url: ogImage,
              width: 1200,
              height: 800,
            },
          ],
        }
      : { type: 'article' },
  };

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Кейсы',
        item: toAbsoluteUrl('/projects', site),
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: data.title,
        item: canonicalUrl,
      },
    ],
  };

  const productSchema = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: `${data.layout ? `${data.layout} ` : ''}${serviceLabels.noun} на заказ`,
    description: metaDescription,
    image: normalizedImages.filter((image) => !isRawProjectImagePath(image)),
    brand: {
      '@type': 'Organization',
      name: 'Мебель Иркутск',
    },
    offers: project.actualPriceValue !== null
      ? {
          '@type': 'Offer',
          price: String(project.actualPriceValue),
          priceCurrency: 'RUB',
          url: canonicalUrl,
        }
      : undefined,
  };

  const creativeWorkAbout = `${serviceLabels.noun} на заказ в ${cityLabels.inCase}`;
  const areaServedName =
    {
      Иркутск: 'Irkutsk',
      Ангарск: 'Angarsk',
      Шелехов: 'Shelekhov',
    }[cityLabels.base] || cityLabels.base;
  const creativeWorkSchema = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: data.title,
    description: metaDescription,
    image: ogImage ? toAbsoluteUrl(ogImage, site) : undefined,
    datePublished: projectDate.toISOString(),
    about: creativeWorkAbout,
    areaServed: areaServedName,
    url: canonicalUrl,
    author: {
      '@type': 'Organization',
      name: companyName,
    },
  };

  const serviceSchema = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: `${serviceLabels.noun} на заказ`,
    areaServed: cityLabels.base,
    url: moneyPageCanonicalUrl,
  };

  const videoSchema =
    video && video.embedUrl
      ? {
          '@context': 'https://schema.org',
          '@type': 'VideoObject',
          name: video.title || data.title,
          description: video.description || metaDescription,
          thumbnailUrl: videoThumbnailUrl,
          uploadDate: video.uploadDate,
          contentUrl: normalizeVideoUrl(video.contentUrl),
          embedUrl: normalizeVideoUrl(video.embedUrl),
          publisher: {
            '@type': 'Organization',
            name: 'Мебель Иркутск',
          },
        }
      : null;

  const faqSchema =
    faqItems.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: faqItems.map((item) => ({
            '@type': 'Question',
            name: item.question,
            acceptedAnswer: {
              '@type': 'Answer',
              text: item.answer,
            },
          })),
        }
      : null;

  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: data.title,
    description: metaDescription,
    datePublished: projectDate.toISOString(),
    author: {
      '@type': 'Organization',
      name: 'Мебель Иркутск',
    },
    mainEntityOfPage: canonicalUrl,
  };

  const relatedProjects = relatedEntities.projects;
  const relatedArticleLinks =
    manualRelatedArticleLinks.length > 0
      ? manualRelatedArticleLinks
      : relatedEntities.articles
          .map((article) => ({
            text: String(article.data.mainKeyword || article.data.title || '').trim(),
            href: `/articles/${resolveArticleSlug(article)}`,
          }))
          .filter((item) => item.text && item.href);

  const ctaDefaults: ProjectCtaDefaults = {
    title: `Хотите такую же ${serviceLabels.accusative}?`,
    highlight: 'Рассчитаем стоимость бесплатно',
    description: 'Замерщик выедет в день обращения. Проект, 3D-визуализация и расчет — бесплатно.',
    primaryLabel: 'Получить расчет бесплатно',
    secondaryLabel: businessInfo.phone,
    backgroundImage: ctaBackground,
    backgroundStyle: ctaBackgroundStyle,
  };

  return {
    entry,
    project,
    data,
    slug,
    heading,
    pageTitle,
    description,
    shortDescription,
    metaDescription,
    canonicalPath,
    canonicalUrl,
    projectDate,
    metadata,
    preloadImage,
    labels: {
      city: cityLabels,
      service: serviceLabels,
      layoutLabel,
      serviceLinkText,
    },
    hero: {
      heading: heroHeading,
      description: heroDescription,
      microGeoText,
      cityLabel: heroBadge,
      cityInCase: cityLabels.inCase,
      heroImage: resolvedHeroImage || heroImage || heroBackgroundImage,
      heroAlt,
      quickSpecs,
      service: data.service,
      hasGallery: galleryImagesForBlocks.length > 0,
      heroTags,
      heroStats,
      breadcrumbs,
      rating: heroRating,
    },
    heroBackgroundImage,
    heroBackgroundAlt,
    gallery: {
      images: galleryImages,
      imagesForBlocks: galleryImagesForBlocks,
      alt: galleryAlt,
      captions: imageCaptions,
      heroImage: heroImage,
    },
    about: {
      title: aboutTitle,
      paragraphs: aboutParagraphs,
      image: aboutImage,
      highlights: aboutHighlights,
      hasSection: hasAboutSection,
    },
    task: {
      text: taskText,
      bullets: taskBullets,
      constraints: constraintBullets,
    },
    solution: {
      text: solutionText,
      splitImage: solutionSplitImage,
    },
    materials: {
      items: materials,
      summary: materialsSummary,
      railItems: railMaterials,
    },
    process: {
      steps: processSteps,
      image: processImage,
      railSteps: railProcessSteps,
    },
    beforeAfter: {
      items: beforeAfterItems,
    },
    video: {
      data: video,
      poster: videoPoster,
      thumbnailUrl: videoThumbnailUrl,
      hasVideo,
    },
    faq: {
      items: faqItems,
    },
    internalLinks: resolvedInternalLinks,
    cost: {
      label: costLabel || formattedPrice,
      note: costNote,
      breakdown: costBreakdown,
      summaryPrice,
      hasCost: Boolean((hasCost && costLabel) || formattedPrice),
    },
    summaryFacts,
    railFacts,
    railBenefits,
    shouldShowKeyFacts,
    tocItems,
    blocks,
    hasBlocks,
    blockTypes,
    sectionVisibility,
    hasBodyContent,
    relatedProjects,
    relatedArticles: relatedArticleLinks,
    ctaDefaults,
    contact: {
      phone: businessInfo.phone,
      phoneHref: businessInfo.phoneHref,
    },
    schemas: {
      breadcrumbSchema,
      productSchema,
      serviceSchema,
      articleSchema,
      creativeWorkSchema,
      videoSchema,
      faqSchema,
    },
  };
}

