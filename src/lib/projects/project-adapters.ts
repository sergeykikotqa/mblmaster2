import type { ProjectCardData, ProjectVideoCard } from '~/types/project';
import {
  normalizeProjectContent,
  resolveProjectPublicImage,
  type NormalizedProjectContent,
  type ProjectEntry,
} from './normalized-project-content';

export {
  normalizeProjectContent,
  normalizeProjectImageBaseDir,
  resolveProjectImage,
  resolveProjectPublicImage,
  resolveProjectSlug,
  type NormalizedProjectContent,
  type ProjectEntry,
} from './normalized-project-content';

type ProjectBlock = NonNullable<ProjectEntry['data']['blocks']>[number];

const GENERIC_SECTION_TITLES = new Set([
  'краткое описание проекта',
  'как мы решили задачу',
  'итог проекта',
  'результат',
  'заключение',
]);

const formatMoney = (value: number | undefined): string => {
  if (!Number.isFinite(value)) return '';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value));
};

const normalizeStreet = (value: string): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const hasPrefix =
    /^(ул\.|улица|пр-т|проспект|пер\.|переулок|б-р|бульвар|мкр\.|микрорайон|проезд|шоссе|тракт|пл\.|площадь)/i.test(
      raw
    );
  return hasPrefix ? raw : `ул. ${raw}`;
};

const stripMarkdown = (value: string): string => {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[*_`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const isGenericHeading = (value: string): boolean => GENERIC_SECTION_TITLES.has(stripMarkdown(value).toLowerCase());

const extractMeaningfulParagraph = (body: string): string => {
  const paragraphs = String(body || '')
    .split(/\n\s*\n/)
    .map((line) => line.trim());
  for (const paragraph of paragraphs) {
    if (!paragraph) continue;
    if (!paragraph.includes('\n') && /^#{1,6}\s+/.test(paragraph)) continue;
    const cleaned = stripMarkdown(paragraph);
    if (!cleaned || cleaned.length < 24 || isGenericHeading(cleaned)) continue;
    return cleaned;
  }
  const fallback = paragraphs.find((line) => Boolean(line) && !/^#{1,6}\s+/.test(line));
  return stripMarkdown(fallback || '');
};

const extractListItemAfter = (body: string, marker: RegExp): string => {
  const match = String(body || '').match(marker);
  if (!match) return '';
  const chunk = match[1] || '';
  const firstLine = chunk
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^[-*]\s+/.test(line));
  if (!firstLine) return '';
  return stripMarkdown(firstLine.replace(/^[-*]\s+/, ''));
};

const extractInlineAfter = (body: string, marker: RegExp): string => {
  const match = String(body || '').match(marker);
  return match ? stripMarkdown(match[1] || '') : '';
};

const extractProjectBlockText = (blocks: ProjectBlock[], allowedTypes: Array<ProjectBlock['type']>): string => {
  for (const block of blocks) {
    if (!allowedTypes.includes(block.type)) continue;

    const candidates = [
      'text' in block ? block.text : '',
      'description' in block ? block.description : '',
      'title' in block ? block.title : '',
    ];

    for (const candidate of candidates) {
      const cleaned = stripMarkdown(String(candidate || ''));
      if (!cleaned || isGenericHeading(cleaned)) continue;
      return cleaned;
    }
  }

  return '';
};

const clampText = (value: string, max = 140): string => {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trim()}…`;
};

const formatVideoDate = (value: string): string => {
  const timestamp = Number(new Date(value || ''));
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(timestamp));
};

const detectVideoPlatform = (...urls: Array<string | undefined>): string => {
  const source = urls
    .map((value) =>
      String(value || '')
        .trim()
        .toLowerCase()
    )
    .find(Boolean);

  if (!source) return 'Видеообзор';
  if (source.includes('vkvideo.ru') || source.includes('vk.com/video')) return 'VK Видео';
  if (source.includes('youtube.com') || source.includes('youtu.be')) return 'YouTube';
  if (source.includes('rutube.ru')) return 'RuTube';
  return 'Видеообзор';
};

const buildLocationLabel = (cityLabel: string, street: string, complex: string, district: string): string => {
  const parts: string[] = [];
  const normalizedStreet = normalizeStreet(street);
  if (normalizedStreet) parts.push(normalizedStreet);
  if (complex) parts.push(complex);
  if (!normalizedStreet && !complex && district) parts.push(`${district} район`);
  if (parts.length === 0) return '';
  return `${cityLabel}, ${parts.join(', ')}`;
};

const buildAudienceLabel = (areaLabel: string, complex: string, district: string, serviceKey: string): string => {
  if (areaLabel) {
    if (serviceKey === 'kuhni') return `Для кухни ${areaLabel}`;
    if (serviceKey === 'garderobnye') return `Для гардеробной ${areaLabel}`;
    if (serviceKey === 'shkafy') return `Для комнаты ${areaLabel}`;
    return `Для помещения ${areaLabel}`;
  }
  if (complex) return `Для объекта в ${complex}`;
  if (district) return `Для ${district} района`;
  return '';
};

const normalizeLayoutToken = (value: string): string => {
  const raw = String(value || '').toLowerCase();
  if (!raw) return '';
  if (raw.includes('углов')) return 'corner';
  if (raw.includes('прям') || raw.includes('линей')) return 'straight';
  if (raw.includes('п-образ') || raw.includes('п‑образ') || raw.includes('п образ')) return 'u-shape';
  return '';
};

const isNormalizedProjectContent = (
  value: ProjectEntry | NormalizedProjectContent
): value is NormalizedProjectContent => {
  if (!value || typeof value !== 'object') return false;
  return 'entry' in value && 'serviceLabels' in value && 'imageBaseDir' in value;
};

const toNormalizedProject = (value: ProjectEntry | NormalizedProjectContent): NormalizedProjectContent =>
  isNormalizedProjectContent(value) ? value : normalizeProjectContent(value);

export function buildProjectCardData(input: ProjectEntry | NormalizedProjectContent): ProjectCardData {
  const project = toNormalizedProject(input);
  const { data, slug, href, cityLabels, serviceLabels, serviceCode } = project;
  const cityLabel = cityLabels.base;
  const serviceLabel = serviceLabels.plural;
  const normalizedCoverImage = project.coverImage;
  const hasEstimatedPrice = project.hasEstimatedPrice;
  const resolvedPriceValue = project.resolvedPriceValue;
  const formattedPrice = formatMoney(resolvedPriceValue ?? undefined);
  const formattedDuration = project.durationValue !== null ? `${project.durationValue} дн.` : '';
  const description = project.description;
  const areaValue = project.areaValue;
  const areaLabel = areaValue !== null ? `${areaValue} м²` : '';
  const locationLabel = buildLocationLabel(
    cityLabel,
    String(data.street || '').trim(),
    String(data.complex || '').trim(),
    String(data.district || '').trim()
  );
  const audienceLabel = buildAudienceLabel(
    areaLabel,
    String(data.complex || '').trim(),
    String(data.district || '').trim(),
    String(data.service || '').trim()
  );
  const isFeminine = serviceLabels.noun.endsWith('а') || serviceLabels.noun.endsWith('я');
  const sameServicePhrase = `${isFeminine ? 'такую же' : 'такой же'} ${serviceLabels.accusative}`;
  const ctaLabel = `Хочу ${sameServicePhrase} →`;
  const calloutText = `Рассчитаем ${sameServicePhrase} под ваши размеры за 1 день`;

  const secondaryCtaLabel = 'Смотреть проект';
  const secondaryCtaHref = href;
  const layoutToken = normalizeLayoutToken(String(data.layout || ''));

  const rawBody = project.body;
  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  const taskText = clampText(
    stripMarkdown(
      String(data.task || '').trim() || extractProjectBlockText(blocks, ['task']) || extractMeaningfulParagraph(rawBody)
    ),
    150
  );
  const solutionText = clampText(
    stripMarkdown(
      String(data.solution || '').trim() ||
        extractProjectBlockText(blocks, ['solution', 'split']) ||
        extractListItemAfter(rawBody, /Что сделали:\s*([\s\S]*?)(?:\n\n|Результат:|$)/i)
    ),
    140
  );
  const resultText = clampText(
    stripMarkdown(extractProjectBlockText(blocks, ['result']) || extractInlineAfter(rawBody, /Результат:\s*([^\n]+)/i)),
    140
  );
  const proofHighlight =
    (resultText && { label: 'Результат', value: resultText }) ||
    (solutionText && { label: 'Решение', value: solutionText }) ||
    (taskText && { label: 'Задача', value: taskText }) ||
    undefined;

  return {
    slug,
    href,
    title: project.title,
    description,
    cityLabel,
    serviceLabel,
    coverImage: normalizedCoverImage,
    priceLabel: formattedPrice ? `${hasEstimatedPrice ? '~' : ''}${formattedPrice} ₽` : '',
    priceNote: hasEstimatedPrice
      ? String((data as { estimatedPriceNote?: string }).estimatedPriceNote || '').trim() ||
        'Оценка по фото и аналогичным проектам.'
      : '',
    priceIsEstimated: hasEstimatedPrice || undefined,
    durationLabel: formattedDuration,
    areaLabel,
    locationLabel,
    audienceLabel,
    ctaLabel,
    calloutText,
    secondaryCtaLabel: secondaryCtaHref ? secondaryCtaLabel : '',
    secondaryCtaHref,
    proofHighlight,
    areaValue: areaValue ?? undefined,
    priceValue: resolvedPriceValue ?? undefined,
    layoutToken,
    serviceId: serviceCode || undefined,
  };
}

export function buildProjectCards(entries: Array<ProjectEntry | NormalizedProjectContent>): ProjectCardData[] {
  return entries.map(buildProjectCardData);
}

export function buildProjectVideoCards(entries: ProjectEntry[]): ProjectVideoCard[] {
  return entries
    .map((entry) => normalizeProjectContent(entry))
    .filter((project) => project.data.video && (project.data.video.embedUrl || project.data.video.contentUrl))
    .map((project) => {
      const { data, slug, serviceLabels, imageBaseDir } = project;
      const href = `${project.href}#video`;
      const city = project.cityLabels.base;
      const service = serviceLabels.plural;
      const title = String(data.video?.title || project.title || '');
      const locationParts = [
        normalizeStreet(String(data.street || '').trim()),
        String(data.complex || '').trim(),
        !String(data.street || '').trim() && !String(data.complex || '').trim()
          ? String(data.district || '').trim()
          : '',
      ].filter(Boolean);
      const locationLabel = locationParts.join(', ');
      const description = clampText(
        stripMarkdown(
          String(data.video?.description || '').trim() ||
            project.description ||
            extractProjectBlockText(Array.isArray(data.blocks) ? data.blocks : [], ['task', 'solution', 'split'])
        ),
        132
      );
      const image = data.video?.thumbnail || (project.images.length > 0 ? project.images[0] : '');
      const normalizedImage = resolveProjectPublicImage(slug, image, imageBaseDir);
      const meta = `${city} · ${service}`;
      return {
        title,
        href,
        image: normalizedImage,
        meta,
        description,
        locationLabel,
        platformLabel: detectVideoPlatform(data.video?.contentUrl, data.video?.embedUrl),
        publishedLabel: formatVideoDate(String(data.video?.uploadDate || '')),
        serviceLabel: serviceLabels.plural,
      };
    })
    .filter((card) => Boolean(card.image));
}

export function buildRelatedProjectCards(
  entries: ProjectEntry[],
  currentSlug: string,
  service: string,
  limit = 4
): ProjectCardData[] {
  const normalizeToken = (value: string): string =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^\/+|\/+$/g, '');

  const normalizedCurrent = normalizeToken(currentSlug);
  const normalizedService = normalizeToken(service);
  const projects = entries.map((entry) => normalizeProjectContent(entry));
  const currentProject = projects.find((project) => normalizeToken(project.slug) === normalizedCurrent);

  const normalizeField = (value: unknown) =>
    String(value || '')
      .trim()
      .toLowerCase();

  const getScore = (project: NormalizedProjectContent) => {
    if (!currentProject) return 0;
    let score = 0;
    if (normalizeField(project.data.city) === normalizeField(currentProject.data.city)) score += 3;
    if (
      normalizeField(project.data.layout) &&
      normalizeField(project.data.layout) === normalizeField(currentProject.data.layout)
    )
      score += 2;
    if (
      normalizeField(project.data.style) &&
      normalizeField(project.data.style) === normalizeField(currentProject.data.style)
    )
      score += 1;
    if (
      normalizeField(project.data.materials?.facade) &&
      normalizeField(project.data.materials?.facade) === normalizeField(currentProject.data.materials?.facade)
    )
      score += 1;
    if (
      normalizeField(project.data.materials?.tabletop) &&
      normalizeField(project.data.materials?.tabletop) === normalizeField(currentProject.data.materials?.tabletop)
    )
      score += 1;
    if (
      normalizeField(project.data.materials?.hardware) &&
      normalizeField(project.data.materials?.hardware) === normalizeField(currentProject.data.materials?.hardware)
    )
      score += 1;

    if (typeof project.data.price === 'number' && typeof currentProject.data.price === 'number') {
      const diff = Math.abs(project.data.price - currentProject.data.price);
      const ratio = diff / Math.max(currentProject.data.price, 1);
      if (ratio <= 0.2) score += 1;
    }

    if (typeof project.data.area === 'number' && typeof currentProject.data.area === 'number') {
      const diff = Math.abs(project.data.area - currentProject.data.area);
      const ratio = diff / Math.max(currentProject.data.area, 1);
      if (ratio <= 0.2) score += 1;
    }

    return score;
  };

  const sorted = projects
    .filter((project) => {
      if (project.data.draft) return false;
      const entrySlug = normalizeToken(project.slug);
      return entrySlug !== normalizedCurrent && normalizeToken(project.serviceCode) === normalizedService;
    })
    .map((project) => ({ project, score: getScore(project) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const dateA = Number(a.project.publishDate);
      const dateB = Number(b.project.publishDate);
      return dateB - dateA;
    })
    .map((item) => item.project)
    .slice(0, limit);

  return buildProjectCards(sorted);
}
