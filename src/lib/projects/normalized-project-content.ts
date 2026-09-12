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

/**
 * A few legacy case files still contain references to the old Figma export.
 * Keep that historical content renderable, but never let those donor files
 * escape into the public project UI. These are real MBL folders already
 * shipped in `src/assets/images/projects`.
 */
const LEGACY_PROJECT_IMAGE_BASE_DIRS: Record<string, string> = {
  'garderobnaya-angarsk-29-mikrorayon': 'uglovaya-garderobnaya-kupe-irkutsk',
  'garderobnaya-p-obraznaya-shelekhov-5-i-mikroraion': 'uglovaya-garderobnaya-kupe-irkutsk',
  'garderobnaya-sovetskaya': 'uglovaya-garderobnaya-kupe-irkutsk',
  'kuhnya-uglovaya-irkutsk-lermontova': 'kuhnya-trilissera',
  'shkaf-vstroennyi-angarsk-84-i-kvartal': 'shkaf-kupe-na-vsyu-stenu-irkutsk',
};

const DEFAULT_LEGACY_PROJECT_IMAGE_BASE_DIR = 'kuhnya-trilissera';

const resolveLegacyProjectImageBaseDir = (slug: string): string => {
  const normalizedSlug = normalizeProjectImageBaseDir(slug).toLowerCase();
  if (LEGACY_PROJECT_IMAGE_BASE_DIRS[normalizedSlug]) return LEGACY_PROJECT_IMAGE_BASE_DIRS[normalizedSlug];

  if (normalizedSlug.includes('garderob')) return 'uglovaya-garderobnaya-kupe-irkutsk';
  if (normalizedSlug.includes('shkaf')) return 'shkaf-kupe-na-vsyu-stenu-irkutsk';
  return DEFAULT_LEGACY_PROJECT_IMAGE_BASE_DIR;
};

const isLegacyProjectImage = (value: string): boolean => /(?:^|\/)images\/figma\//i.test(value);

const resolveLegacyProjectImageName = (value: string, imageIndex?: number): string => {
  const name = value.replace(/^.*\//, '').replace(/\.[^.]+$/, '').toLowerCase();

  // The old donor filenames described the type of shot. Preserve that intent
  // while pointing at the corresponding real MBL gallery frame.
  if (name.includes('detail-drawer')) return '03.jpg';
  if (name.includes('detail-wood')) return '02.jpg';

  const ordinal = Number.isInteger(imageIndex) && Number(imageIndex) >= 0 ? Number(imageIndex) + 1 : 1;
  return `${String(Math.min(99, ordinal)).padStart(2, '0')}.jpg`;
};

const resolveProjectImageBaseDir = (
  slug: string,
  imageBaseDir?: string | null,
  legacyImage = false,
  projectPathBaseDir?: string | null
): string => {
  const explicitBaseDir = normalizeProjectImageBaseDir(imageBaseDir);
  if (explicitBaseDir) return explicitBaseDir;
  if (legacyImage) return resolveLegacyProjectImageBaseDir(slug);
  return normalizeProjectImageBaseDir(projectPathBaseDir) || normalizeProjectImageBaseDir(slug);
};

const resolveProjectImagePath = (
  slug: string,
  image: string,
  imageBaseDir?: string | null,
  imageIndex?: number
): string => {
  const projectPathMatch = image.match(/^\/images\/projects\/(.+?)\/([^/]+)$/i);
  const legacyImage = isLegacyProjectImage(image);
  const requestedImage = legacyImage
    ? resolveLegacyProjectImageName(image, imageIndex)
    : projectPathMatch
      ? projectPathMatch[2]
      : image.replace(/^.*\//, '');
  const requestedBaseDir =
    resolveProjectImageBaseDir(slug, imageBaseDir, legacyImage, projectPathMatch?.[1]);

  if (image.startsWith('/') && !projectPathMatch && !legacyImage) return image;

  return `/images/projects/${requestedBaseDir}/${requestedImage}`;
};

export function resolveProjectImage(
  slug: string,
  image?: string | null,
  imageBaseDir?: string | null,
  imageIndex?: number
): string {
  const value = String(image || '').trim();
  if (!value) return '';

  return resolveProjectImagePath(slug, value, imageBaseDir, imageIndex);
}

export function resolveProjectPublicImage(
  slug: string,
  image?: string | null,
  imageBaseDir?: string | null,
  imageIndex?: number
): string {
  const value = String(image || '').trim();
  if (!value) return '';

  return resolveProjectImagePath(slug, value, imageBaseDir, imageIndex);
}

const normalizeProjectImages = (value: readonly string[] | null | undefined): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    : [];

const inferProjectImageBaseDir = (images: readonly string[]): string => {
  for (const image of images) {
    const projectPathMatch = image.match(/^\/images\/projects\/(.+?)\/[^/]+$/i);
    const projectPathBaseDir = normalizeProjectImageBaseDir(projectPathMatch?.[1]);
    if (projectPathBaseDir) return projectPathBaseDir;
  }

  return '';
};

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
  const images = normalizeProjectImages(rawData.images);
  const hasLegacyImages = images.some((image) => isLegacyProjectImage(image));
  const inferredImageBaseDir = hasLegacyImages
    ? resolveLegacyProjectImageBaseDir(slug)
    : inferProjectImageBaseDir(images);
  const imageBaseDir =
    normalizeProjectImageBaseDir(boundary.imageBaseDir) ||
    inferredImageBaseDir ||
    normalizeProjectImageBaseDir(slug);
  const data: NormalizedProjectData = {
    ...rawData,
    imageBaseDir,
  };
  const resolvedImages = images
    .map((image, imageIndex) => resolveProjectImage(slug, image, imageBaseDir, imageIndex))
    .filter(Boolean);
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
