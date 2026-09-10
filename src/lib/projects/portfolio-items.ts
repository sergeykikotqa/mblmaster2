import { getCollection } from 'astro:content';

import {
  normalizeProjectContent,
  type NormalizedProjectContent,
  type ProjectEntry,
} from './normalized-project-content';

export type PortfolioCategory = 'kuhni' | 'shkafy' | 'garderobnye';

export type PortfolioItem = {
  src: string;
  alt: string;
  title: string;
  style: string;
  facade: string;
  area: string;
  price: string;
  category: PortfolioCategory;
  badge: string;
  href: string;
};

const SERVICE_ORDER: PortfolioCategory[] = ['kuhni', 'shkafy', 'garderobnye'];

const formatMoney = (value: number): string =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);

const formatArea = (value: number): string =>
  `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value)} м²`;

const getServiceRelevance = (project: NormalizedProjectContent): number => {
  const haystack = `${project.slug} ${project.title}`.toLowerCase();
  if (project.serviceCode === 'kuhni') return /kuhn|кухн/.test(haystack) ? 2 : 0;
  if (project.serviceCode === 'shkafy') return /shkaf|шкаф/.test(haystack) ? 2 : 0;
  if (project.serviceCode === 'garderobnye') return /garderob|гардероб/.test(haystack) ? 2 : 0;
  return 0;
};

const sortByPublishDate = (a: NormalizedProjectContent, b: NormalizedProjectContent): number => {
  const diff = b.publishDate.getTime() - a.publishDate.getTime();
  if (diff !== 0) return diff;
  const relevanceDiff = getServiceRelevance(b) - getServiceRelevance(a);
  if (relevanceDiff !== 0) return relevanceDiff;
  return a.slug.localeCompare(b.slug);
};

const capitalize = (value: string): string => {
  const source = String(value || '').trim();
  return source ? `${source.slice(0, 1).toUpperCase()}${source.slice(1)}` : '';
};

const isPortfolioCategory = (value: string): value is PortfolioCategory =>
  SERVICE_ORDER.includes(value as PortfolioCategory);

const hasRealProjectPhoto = (project: NormalizedProjectContent): boolean =>
  project.coverImage.startsWith('/images/projects/');

const toPortfolioItem = (project: NormalizedProjectContent): PortfolioItem | null => {
  const category = String(project.data.service || '').trim();
  if (!isPortfolioCategory(category) || !project.coverImage) return null;

  const serviceLabel = capitalize(project.serviceLabels.plural);
  const style = String(project.data.style || '').trim() || serviceLabel;
  const facade = String(project.data.materials?.facade || '').trim() || 'Под ваш проект';
  const area = project.areaValue !== null ? formatArea(project.areaValue) : 'Индивидуально';
  const price = project.resolvedPriceValue
    ? `${project.hasEstimatedPrice ? '~' : ''}${formatMoney(project.resolvedPriceValue)} ₽`
    : 'Рассчитать';

  return {
    src: project.coverImage,
    alt: project.title,
    title: project.title,
    style,
    facade,
    area,
    price,
    category,
    badge: serviceLabel,
    href: project.href,
  };
};

export function buildPortfolioItems(entries: ProjectEntry[], limit = 6): PortfolioItem[] {
  const normalized = entries
    .map((entry) => normalizeProjectContent(entry))
    .filter(hasRealProjectPhoto)
    .sort(sortByPublishDate);
  const selected: NormalizedProjectContent[] = [];
  const selectedSlugs = new Set<string>();

  for (const service of SERVICE_ORDER) {
    const candidate = normalized.find((project) => project.serviceCode === service && !selectedSlugs.has(project.slug));
    if (!candidate) continue;
    selected.push(candidate);
    selectedSlugs.add(candidate.slug);
  }

  for (const project of normalized) {
    if (selected.length >= limit) break;
    if (selectedSlugs.has(project.slug)) continue;
    selected.push(project);
    selectedSlugs.add(project.slug);
  }

  return selected
    .slice(0, limit)
    .map((project) => toPortfolioItem(project))
    .filter((item): item is PortfolioItem => Boolean(item));
}

export async function getPortfolioItems(limit = 6): Promise<PortfolioItem[]> {
  const projects = await getCollection('projects', ({ data }) => !data.draft);
  return buildPortfolioItems(projects, limit);
}
