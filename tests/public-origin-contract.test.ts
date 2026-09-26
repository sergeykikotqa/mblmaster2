import { describe, expect, test } from 'vitest';

import { validateOriginSignals } from '../scripts/check-public-origin-contract.mjs';

const expectedOrigin = 'https://site.example';
const validSignals = {
  expectedOrigin,
  htmlDocuments: [
    [
      'dist/index.html',
      '<link rel="canonical" href="https://site.example/"><meta property="og:url" content="https://site.example/">',
    ],
  ] as Array<[string, string]>,
  sitemapXml: '<url><loc>https://site.example/</loc></url>',
  robots: 'Sitemap: https://site.example/sitemap-index.xml\n',
  redirects: 'http://old.example/* https://site.example/:splat 301!\n',
  originConfig: 'default "https://site.example";\n"site.example" 1;',
  nginx: 'if ($mbl_public_host_allowed = 0) { return 421; }\nreturn 301 $mbl_public_origin$request_uri;',
};

describe('public origin contract', () => {
  test('accepts one origin across HTML, sitemap, robots, redirects and Nginx', () => {
    expect(validateOriginSignals(validSignals)).toEqual([]);
  });

  test.each([
    ['canonical', { htmlDocuments: [['dist/index.html', '<link rel="canonical" href="https://wrong.example/">']] }],
    ['sitemap', { sitemapXml: '<url><loc>https://wrong.example/</loc></url>' }],
    ['robots', { robots: 'Sitemap: https://wrong.example/sitemap-index.xml\n' }],
    ['redirect', { redirects: 'http://old.example/* https://wrong.example/:splat 301!\n' }],
    ['Nginx origin', { originConfig: 'default "https://wrong.example";\n"wrong.example" 1;' }],
  ])('rejects a mismatched %s signal', (_label, override) => {
    expect(validateOriginSignals({ ...validSignals, ...override })).not.toEqual([]);
  });

  test('allows noindex utility and redirect documents without social metadata', () => {
    const htmlDocuments: Array<[string, string]> = [
      ['dist/admin/index.html', '<meta name="robots" content="noindex, nofollow">'],
      [
        'dist/projects/legacy/index.html',
        '<meta name="robots" content="noindex"><link rel="canonical" href="https://site.example/projects/current">',
      ],
    ];

    expect(validateOriginSignals({ ...validSignals, htmlDocuments })).toEqual([]);
  });

  test('still requires canonical and og:url on indexable documents', () => {
    const htmlDocuments: Array<[string, string]> = [
      ['dist/index.html', '<meta name="robots" content="index,follow"><link rel="canonical" href="https://site.example/">'],
    ];

    expect(validateOriginSignals({ ...validSignals, htmlDocuments })).toContain(
      'dist/index.html og:url uses (missing), expected https://site.example',
    );
  });
});
