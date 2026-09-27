import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';

import { generateProjectSlug } from '../src/utils/slugify';
import { buildAuditRoutes } from '../scripts/lib/audit-routes.mjs';

const ROOT = process.cwd();
const PROJECTS_DIR = path.join(ROOT, 'src', 'content', 'projects');

/**
 * The two mechanisms that can disagree about a project URL:
 *
 *   scripts/lib/audit-routes.mjs      frontmatter.slug || markdown filename
 *   src/lib/projects/normalized-...  frontmatter.slug || generateProjectSlug(data)
 *
 * When a project has no explicit `slug`, the audit invents a route from the
 * filename while Astro generates a different canonical route. Lighthouse then
 * requests a URL that does not exist and the whole collect batch fails.
 */
interface ProjectContentFile {
  file: string;
  stem: string;
  explicitSlug: string | null;
  auditSlug: string;
  canonicalPublicSlug: string;
  parity: 'MATCH' | 'MISMATCH';
}

function listProjectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) files.push(fullPath);
    }
  }
  return files.sort();
}

function parseFrontmatter(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    return (yaml.load(match[1]) || {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Mirrors `resolveProjectSlug` from src/lib/projects/normalized-project-content.ts. */
function canonicalSlugFor(frontmatter: Record<string, unknown>): string {
  const explicit = String(frontmatter.slug || '').trim();
  if (explicit) return explicit.replace(/\.mdx?$/, '');
  return String(
    generateProjectSlug({
      title: frontmatter.title as string | undefined,
      service: frontmatter.service as string,
      layout: frontmatter.layout as string | undefined,
      city: frontmatter.city as string,
      street: frontmatter.street as string | undefined,
    })
  ).replace(/\.mdx?$/, '');
}

function readProjectContent(): ProjectContentFile[] {
  return listProjectFiles(PROJECTS_DIR)
    .map((filePath) => {
      const frontmatter = parseFrontmatter(filePath);
      if (frontmatter.draft) return null;
      const stem = path.basename(filePath).replace(/\.mdx?$/i, '');
      const explicit = String(frontmatter.slug || '').trim();
      return {
        file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
        stem,
        explicitSlug: explicit || null,
        // audit-routes.mjs slugFromFile(): frontmatter.slug || filename stem
        auditSlug: explicit || stem,
        canonicalPublicSlug: canonicalSlugFor(frontmatter),
        parity: ((explicit || stem) === canonicalSlugFor(frontmatter) ? 'MATCH' : 'MISMATCH') as 'MATCH' | 'MISMATCH',
      };
    })
    .filter((entry): entry is ProjectContentFile => entry !== null);
}

function formatReport(entries: ProjectContentFile[]): string {
  const header = 'file | explicit slug | audit slug | canonical public slug | parity';
  const rows = entries.map((entry) =>
    [entry.file, entry.explicitSlug ?? '(none)', entry.auditSlug, entry.canonicalPublicSlug, entry.parity].join(' | ')
  );
  return [header, ...rows].join('\n');
}

describe('project audit/public slug parity', () => {
  test('report is non-empty and lists every non-draft project', () => {
    const entries = readProjectContent();
    console.log(`\n[parity] project files checked: ${entries.length}\n${formatReport(entries)}\n`);
    expect(entries.length).toBeGreaterThan(0);
  });

  test('every non-draft project has an explicit frontmatter slug', () => {
    const missing = readProjectContent()
      .filter((entry) => entry.explicitSlug === null)
      .map((entry) => `  ${entry.file} -> auditSlug="${entry.auditSlug}" canonical="${entry.canonicalPublicSlug}"`);
    expect(
      missing,
      `projects without an explicit slug fall back to the filename in the audit while Astro generates a different route:\n${missing.join('\n')}`
    ).toEqual([]);
  });

  test('audit slug equals the canonical public slug for every project', () => {
    const mismatches = readProjectContent()
      .filter((entry) => entry.parity === 'MISMATCH')
      .map(
        (entry) =>
          `  ${entry.file} -> auditSlug="${entry.auditSlug}" canonicalPublicSlug="${entry.canonicalPublicSlug}"`
      );
    expect(mismatches, `audit routes that Astro never generates (Lighthouse 404):\n${mismatches.join('\n')}`).toEqual(
      []
    );
  });

  test('the project routes produced by buildAuditRoutes match the canonical public slugs', async () => {
    const entries = readProjectContent();
    const { routes } = await buildAuditRoutes();
    const auditProjectSlugs = routes
      .filter((route: { type: string }) => route.type === 'project')
      .map((route: { path: string }) => route.path.replace(/^\/projects\//, ''))
      .sort();
    const canonicalSlugs = entries.map((entry) => entry.canonicalPublicSlug).sort();

    expect(
      auditProjectSlugs,
      'the project route set that Lighthouse audits must be exactly the set of generated public project pages'
    ).toEqual(canonicalSlugs);
  });

  test('the 404 route from run 36300389201 is not audited any more', async () => {
    const { routes } = await buildAuditRoutes();
    const audited = new Set(routes.map((route: { path: string }) => route.path));
    // The filename-derived slug that produced ERRORED_DOCUMENT_REQUEST in run 36300389201.
    expect(audited.has('/projects/raspashnoi-shkaf-s-antresolyu/')).toBe(false);
  });
});
