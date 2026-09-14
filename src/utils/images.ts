import { getImage } from 'astro:assets';
import type { ImageMetadata } from 'astro';
import type { OpenGraph } from '~/types/seo';

const load = async function () {
  let images: Record<string, () => Promise<unknown>> | undefined = undefined;
  try {
    images = import.meta.glob('~/assets/images/**/*.{jpeg,jpg,png,tiff,webp,gif,svg,JPEG,JPG,PNG,TIFF,WEBP,GIF,SVG}');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (error) {
    // continue regardless of error
  }
  return images;
};

let _images: Record<string, () => Promise<unknown>> | undefined = undefined;

/** */
export const fetchLocalImages = async () => {
  _images = _images || (await load());
  return _images;
};

/** */
export const findImage = async (
  imagePath?: string | ImageMetadata | null
): Promise<string | ImageMetadata | undefined | null> => {
  // Not string
  if (typeof imagePath !== 'string') {
    if (imagePath && typeof imagePath === 'object') {
      const candidate = imagePath as Partial<ImageMetadata>;
      if (typeof candidate.src === 'string' && Number.isFinite(candidate.width) && Number.isFinite(candidate.height)) {
        return candidate as ImageMetadata;
      }
    }
    return null;
  }

  // Remote images
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    return imagePath;
  }

  // Absolute /images/* paths from public can be mapped to local assets for optimization.
  // This keeps content frontmatter stable while enabling Astro image transforms.
  if (imagePath.startsWith('/images/')) {
    const images = await fetchLocalImages();
    const key = imagePath.replace('/images/', '/src/assets/images/');
    if (images && typeof images[key] === 'function') {
      return ((await images[key]()) as { default: ImageMetadata }).default;
    }
    return imagePath;
  }

  // Other absolute paths
  if (imagePath.startsWith('/')) {
    return imagePath;
  }

  // Relative paths or not "~/assets/"
  if (!imagePath.startsWith('~/assets/images')) {
    return imagePath;
  }

  const images = await fetchLocalImages();
  const key = imagePath.replace('~/', '/src/');

  return images && typeof images[key] === 'function'
    ? ((await images[key]()) as { default: ImageMetadata })['default']
    : null;
};

/** */
export const adaptOpenGraphImages = async (openGraph: OpenGraph = {}, astroSite?: URL): Promise<OpenGraph> => {
  if (!openGraph?.images?.length) {
    return openGraph;
  }

  const images = openGraph.images;
  const defaultWidth = 1200;
  const defaultHeight = 626;
  const isDev = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);

  const safeGetImage = async (options: Parameters<typeof getImage>[0]) => {
    try {
      return await getImage(options);
    } catch (error) {
      if (isDev) {
        console.warn('[images] Failed to optimize open graph image, using fallback.', error);
      }
      return null;
    }
  };

  const resolveAbsoluteUrl = (value: string) => {
    if (!value) return '';
    if (value.startsWith('http://') || value.startsWith('https://')) return value;
    if (!astroSite) return value;
    try {
      return String(new URL(value, astroSite));
    } catch {
      return value;
    }
  };

  if (isDev) {
    return {
      ...openGraph,
      images: images.map((image) => ({
        ...image,
        url: resolveAbsoluteUrl(String(image?.url || '')),
      })),
    };
  }

  const adaptedImages = await Promise.all(
    images.map(async (image) => {
      if (!image?.url) {
        return { url: '' };
      }

      const resolvedImage = (await findImage(image.url)) as ImageMetadata | string | undefined;
      if (!resolvedImage) {
        return { url: '' };
      }

      if (typeof resolvedImage === 'string') {
        return {
          url: resolveAbsoluteUrl(resolvedImage),
          width: image.width,
          height: image.height,
        };
      }

      if (!Number.isFinite(resolvedImage.width) || !Number.isFinite(resolvedImage.height)) {
        return {
          url: resolveAbsoluteUrl(image.url),
          width: image.width,
          height: image.height,
        };
      }

      const dimensions =
        resolvedImage.width <= defaultWidth
          ? [resolvedImage.width, resolvedImage.height]
          : [defaultWidth, defaultHeight];
      const optimized = await safeGetImage({
        src: resolvedImage,
        width: dimensions[0],
        height: dimensions[1],
        format: 'jpg',
        inferSize: true,
      });

      return {
        url: optimized?.src ? resolveAbsoluteUrl(optimized.src) : resolveAbsoluteUrl(image.url),
        width: optimized?.attributes?.width ?? dimensions[0],
        height: optimized?.attributes?.height ?? dimensions[1],
      };
    })
  );

  return { ...openGraph, ...(adaptedImages ? { images: adaptedImages } : {}) };
};
