import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('build:data pipeline runs and produces 3 generated pages', () => {
  execSync('npm run build:data', {
    cwd: process.cwd(),
    stdio: 'pipe',
  });

  const generatedPath = path.join(process.cwd(), 'data/generated-pages.json');
  const pages = JSON.parse(fs.readFileSync(generatedPath, 'utf8')) as unknown[];
  expect(Array.isArray(pages)).toBe(true);
  expect(pages).toHaveLength(3);
}, 120000);
