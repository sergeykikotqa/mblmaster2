import type { CollectionEntry } from 'astro:content';

import { generateProjectSlug } from '~/utils/slugify';
import { generateProjectDescription, getCityLabels, getServiceLabels, type ServiceLabels } from '~/utils/seo';
import { readProjectBoundary } from './project-boundary';

export type ProjectEntry = CollectionEntry<'projects'>;

export type NormalizedProjectData = ProjectEntry['data'] & {
  imageBaseDir: string;
};

export interface NormalizedProjectContent {
  entry: ProjectEntry;
  data: NormalizedProjectData;
  body: string;
  slug: string;
  href: string;
  title: string;
  description: string;
  cityLabels: ReturnType<typeof getCityLabels>;
  serviceLabels: ServiceLabels;
  serviceCode: string;
  imageBaseDir: string;
  images: string[];
  resolvedImages: string[];
  imageCaptions: Record<string, string>;
  coverImage: string;
  areaValue: number | null;
  durationValue: number | null;
  actualPriceValue: number | null;
  estimatedPriceValue: number | null;
  resolvedPriceValue: number | null;
  hasActualPrice: boolean;
  hasEstimatedPrice: boolean;
  publishDate: Date;
}

export function resolveProjectSlug(entry: ProjectEntry): string {
  const explicit = String(entry.data.slug || '').trim();
  if (explicit) return explicit.replace(/\.mdx?$/, '');
  return String(generateProjectSlug(entry.data) || entry.id).replace(/\.mdx?$/, '');
}

export const normalizeProjectImageBaseDir = (value: string | null | undefined): string =>
  String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/?src\/assets\/images\/projects\//, '')
    .replace(/^\/?public\/images\/projects\//, '')
    .replace(/^\/?images\/projects\//, '')
    .replace(/^\/+|\/+$/g, '');

export function resolveProjectImage(slug: string, image?: string | null, imageBaseDir?: string | null): string {
  const value = String(image || '').trim();
  if (!value) return '';

  const projectPathMatch = value.match(/^\/images\/projects\/(.+?)\/([^/]+)$/i);
  const requestedImage = projectPathMatch ? projectPathMatch[2] : value.replace(/^.*\//, '');
  const requestedBaseDir =
    normalizeProjectImageBaseDir(imageBaseDir) ||
    normalizeProjectImageBaseDir(projectPathMatch?.[1]) ||
    normalizeProjectImageBaseDir(slug);

  if (value.startsWith('/') && !projectPathMatch) return value;

  return `/images/projects/${requestedBaseDir}/${requestedImage}`;
}

export function resolveProjectPublicImage(slug: string, image?: string | null, imageBaseDir?: string | null): string {
  const value = String(image || '').trim();
  if (!value) return '';

  const projectPathMatch = value.match(/^\/images\/projects\/(.+?)\/([^/]+)$/i);
  const requestedImage = projectPathMatch ? projectPathMatch[2] : value.replace(/^.*\//, '');
  const requestedBaseDir =
    normalizeProjectImageBaseDir(imageBaseDir) ||
    normalizeProjectImageBaseDir(projectPathMatch?.[1]) ||
    normalizeProjectImageBaseDir(slug);

  if (value.startsWith('/') && !projectPathMatch) return value;

  return `/images/projects/${requestedBaseDir}/${requestedImage}`;
}

const normalizeProjectImages = (value: readonly string[] | null | undefined): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    : [];

const normalizeImageCaptions = (value: ProjectEntry['data']['imageCaptions']): Record<string, string> => {
  if (!value || typeof value !== 'object') return {};

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, caption]) => [String(key || '').trim(), String(caption || '').trim()])
      .filter(([key, caption]) => Boolean(key) && Boolean(caption))
  );
};

const normalizeFiniteNumber = (value: number | null | undefined): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export function normalizeProjectContent(entry: ProjectEntry): NormalizedProjectContent {
  const slug = resolveProjectSlug(entry);
  const rawData = entry.data;
  const boundary = readProjectBoundary(entry);
  const imageBaseDir = normalizeProjectImageBaseDir(boundary.imageBaseDir) || normalizeProjectImageBaseDir(slug);
  const data: NormalizedProjectData = {
    ...rawData,
    imageBaseDir,
  };
  const images = normalizeProjectImages(data.images);
  const resolvedImages = images.map((image) => resolveProjectImage(slug, image, imageBaseDir)).filter(Boolean);
  const actualPriceValue = normalizeFiniteNumber(data.price);
  const estimatedPriceValue = normalizeFiniteNumber(boundary.estimatedPrice);
  const hasActualPrice = actualPriceValue !== null;
  const hasEstimatedPrice = !hasActualPrice && estimatedPriceValue !== null;
  const resolvedPriceValue = actualPriceValue ?? estimatedPriceValue;
  const cityLabels = getCityLabels(String(data.city || ''));
  const serviceLabels = getServiceLabels(String(data.service || ''), boundary.serviceLabelOverride);
  const description = String(data.description || '').trim() || generateProjectDescription(data).split('\n')[0] || '';
  const publishDate = data.publishDate ? new Date(data.publishDate) : new Date();

  return {
    entry,
    data,
    body: boundary.body,
    slug,
    href: `/projects/${slug}`,
    title: String(data.title || '').trim(),
    description,
    cityLabels,
    serviceLabels,
    serviceCode: String(data.service || '').trim(),
    imageBaseDir,
    images,
    resolvedImages,
    imageCaptions: normalizeImageCaptions(data.imageCaptions),
    coverImage: resolvedImages[0] || '',
    areaValue: normalizeFiniteNumber(data.area),
    durationValue: normalizeFiniteNumber(data.duration),
    actualPriceValue,
    estimatedPriceValue,
    resolvedPriceValue,
    hasActualPrice,
    hasEstimatedPrice,
    publishDate,
  };
}
