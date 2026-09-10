import fs from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

type PublicImageMetadata = {
  width: number;
  height: number;
};

const metadataCache = new Map<string, PublicImageMetadata | null>();

export async function getPublicImageMetadata(
  imagePath?: string | null
): Promise<PublicImageMetadata | null> {
  const normalizedPath = String(imagePath || '').trim();
  if (!normalizedPath.startsWith('/')) return null;

  if (metadataCache.has(normalizedPath)) {
    return metadataCache.get(normalizedPath) ?? null;
  }

  const absolutePath = path.join(process.cwd(), 'public', normalizedPath.replace(/^\/+/, ''));
  if (!fs.existsSync(absolutePath)) {
    metadataCache.set(normalizedPath, null);
    return null;
  }

  try {
    const metadata = await sharp(absolutePath).metadata();
    if (Number.isFinite(metadata.width) && Number.isFinite(metadata.height)) {
      const resolvedMetadata = {
        width: Number(metadata.width),
        height: Number(metadata.height),
      };
      metadataCache.set(normalizedPath, resolvedMetadata);
      return resolvedMetadata;
    }
  } catch {
    // Non-optimizable public images can safely fall back to plain <img> without dimensions.
  }

  metadataCache.set(normalizedPath, null);
  return null;
}
