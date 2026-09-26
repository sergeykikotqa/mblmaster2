import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

const ROOT = process.cwd();

function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(ROOT, relativePath));
}

test('projects routes exist', () => {
  expect(exists('src/pages/projects/index.astro')).toBe(true);
  expect(exists('src/pages/projects/[slug].astro')).toBe(true);
});

test('money pages routes exist', () => {
  expect(exists('src/pages/irkutsk.astro')).toBe(false);
  expect(exists('src/pages/[service].astro')).toBe(true);
  expect(exists('src/pages/[city]/index.astro')).toBe(false);
  expect(exists('src/pages/[city]/[service].astro')).toBe(false);
});

test('legacy micro and district routes do not exist', () => {
  const forbiddenFiles = [
    'src/pages/[city]/[service].astro',
    'src/pages/[city]/[district]/[service].astro',
    'src/pages/irkutsk/[district]/[service].ts',
  ];

  for (const target of forbiddenFiles) {
    expect(exists(target)).toBe(false);
  }
});

test('no legacy route files in micro folders', () => {
  const microRoots = ['src/pages/kuhni', 'src/pages/shkafy', 'src/pages/garderobnye', 'src/pages/raiony'];

  function collectRouteFiles(root: string): string[] {
    const result: string[] = [];
    if (!exists(root)) return result;

    function walk(dir: string) {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const relative = path.join(dir, entry.name).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          walk(relative);
          continue;
        }
        if (entry.isFile() && (relative.endsWith('.astro') || relative.endsWith('.ts'))) {
          result.push(relative);
        }
      }
    }

    walk(root);
    return result;
  }

  for (const root of microRoots) {
    if (!exists(root)) continue;
    const routeFiles = collectRouteFiles(root);
    expect(routeFiles).toEqual([]);
  }
});

test('no catch-all pages exist', () => {
  const pageFiles: string[] = [];
  const pagesRoot = path.join(ROOT, 'src/pages');

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile()) {
        pageFiles.push(path.relative(pagesRoot, fullPath).replace(/\\/g, '/'));
      }
    }
  }

  walk(pagesRoot);

  const catchAllFiles = pageFiles.filter((file) => file.includes('[...'));
  expect(catchAllFiles).toEqual([]);
});
