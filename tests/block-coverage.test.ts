import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { PROJECT_BLOCK_TYPES } from '../src/lib/projects/project-block-types';

function extractRegistryKeys(source: string): string[] {
  const match = source.match(/PROJECT_BLOCK_REGISTRY\s*=\s*{([\s\S]*?)}\s*as const/);
  if (!match) return [];
  const body = match[1] || '';
  const keys = Array.from(body.matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)).map((item) => item[1]);
  return keys;
}

test('project block registry covers all configured block types', () => {
  const registryPath = path.join(process.cwd(), 'src', 'components', 'projects', 'block-registry.ts');
  const source = fs.readFileSync(registryPath, 'utf8');
  const registryKeys = extractRegistryKeys(source);
  const registryTypes = new Set(registryKeys);

  const missing = PROJECT_BLOCK_TYPES.filter((type) => !registryTypes.has(type));
  const extra = registryKeys.filter((type) => !PROJECT_BLOCK_TYPES.includes(type as never));

  expect(missing).toEqual([]);
  expect(extra).toEqual([]);
});
