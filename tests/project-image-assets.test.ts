import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  normalizeProjectContent,
  resolveProjectImage,
  type ProjectEntry,
} from '~/lib/projects/normalized-project-content';

const PROJECTS_DIR = path.resolve('src/content/projects');

const readProjectEntry = (fileName: string): ProjectEntry => {
  const source = readFileSync(path.join(PROJECTS_DIR, fileName), 'utf8');
  const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);

  if (!frontmatter) {
    throw new Error(`Project content is missing frontmatter: ${fileName}`);
  }

  return {
    id: fileName.replace(/\.mdx?$/i, ''),
    collection: 'projects',
    data: load(frontmatter[1]) as ProjectEntry['data'],
    body: source.slice(frontmatter[0].length).trim(),
  } as unknown as ProjectEntry;
};

const projectImageExists = (imagePath: string): boolean => {
  if (/^https?:\/\//i.test(imagePath)) return true;

  const relativePath = imagePath.replace(/^\/+/, '');
  const assetPath = path.resolve('src/assets', relativePath);
  const publicPath = path.resolve('public', relativePath);

  return existsSync(assetPath) || existsSync(publicPath);
};

const collectImageReferences = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(value.trim()) ? [value.trim()] : [];
  }
  if (Array.isArray(value)) return value.flatMap(collectImageReferences);
  if (!value || typeof value !== 'object') return [];

  return Object.values(value).flatMap(collectImageReferences);
};

describe('project image asset gate', () => {
  it('resolves every normalized project image to an existing local MBL asset', () => {
    const projectFiles = readdirSync(PROJECTS_DIR)
      .filter((fileName) => /\.mdx?$/i.test(fileName))
      .sort();
    const missingImages: string[] = [];
    let resolvedImageCount = 0;

    for (const fileName of projectFiles) {
      const entry = readProjectEntry(fileName);
      const project = normalizeProjectContent(entry);

      expect(project.resolvedImages, `${fileName} must resolve every declared gallery image`).toHaveLength(
        project.images.length
      );

      const allResolvedImages = new Set([
        ...project.resolvedImages,
        ...collectImageReferences(entry.data).map((imagePath, imageIndex) =>
          resolveProjectImage(project.slug, imagePath, project.imageBaseDir, imageIndex)
        ),
      ]);

      for (const imagePath of allResolvedImages) {
        resolvedImageCount += 1;
        if (!projectImageExists(imagePath)) {
          missingImages.push(`${fileName}: ${imagePath}`);
        }
      }
    }

    expect(resolvedImageCount).toBeGreaterThan(0);
    expect(missingImages, `Missing normalized project images:\n${missingImages.join('\n')}`).toEqual([]);
  });
});
