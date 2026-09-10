import { expect, test } from 'vitest';

import { getTrailingSlashRedirect } from '../src/lib/trailing-slash';

test('does not redirect the root route', () => {
  expect(getTrailingSlashRedirect('/')).toBeNull();
});

test('normalizes content routes without a trailing slash', () => {
  expect(getTrailingSlashRedirect('/kuhni/')).toBe('/kuhni');
  expect(getTrailingSlashRedirect('/projects/demo/')).toBe('/projects/demo');
});

test('does not touch already normalized routes', () => {
  expect(getTrailingSlashRedirect('/kuhni')).toBeNull();
  expect(getTrailingSlashRedirect('/contacts')).toBeNull();
});

test('does not redirect internal or asset-like paths', () => {
  expect(getTrailingSlashRedirect('/_astro/app.js/')).toBeNull();
  expect(getTrailingSlashRedirect('/images/logo.svg/')).toBeNull();
});
