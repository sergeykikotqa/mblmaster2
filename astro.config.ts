import path from 'path';
import { fileURLToPath } from 'url';

import { defineConfig } from 'astro/config';

import mdx from '@astrojs/mdx';
import partytown from '@astrojs/partytown';
import { unified } from '@astrojs/markdown-remark';
import node from '@astrojs/node';
import icon from 'astro-icon';
import type { AstroIntegration } from 'astro';

import astrowind from './vendor/integration';

import {
  readingTimeRemarkPlugin,
  responsiveTablesRehypePlugin,
  lazyImagesRehypePlugin,
  normalizeMarkdownHeadingsRehypePlugin,
} from './src/utils/frontmatter';
import { autoInternalLinksRehypePlugin } from './src/utils/auto-internal-links';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_SITE_URL = String(process.env.PUBLIC_SITE_URL || 'https://example.com').trim();
const IS_E2E = String(process.env.PUBLIC_E2E || '').trim() === '1';
const RUNTIME_SITE_URL = new URL(PUBLIC_SITE_URL);

const hasExternalScripts = false;
const whenExternalScripts = (items: (() => AstroIntegration) | (() => AstroIntegration)[] = []) =>
  hasExternalScripts ? (Array.isArray(items) ? items.map((item) => item()) : [items()]) : [];

export default defineConfig({
  // Public pages stay prerendered; routes with prerender=false run in Node.
  output: 'static',
  trailingSlash: 'never',
  adapter: node({
    mode: 'standalone',
    bodySizeLimit: 1024 * 1024,
  }),
  session: false,
  // Preserve Astro 6 whitespace semantics during the framework migration.
  compressHTML: true,
  // Keep the established public artifact path used by SEO/image/a11y gates.
  // Server code must be outside the public directory, never served as an asset.
  build: {
    client: './',
    server: '../.output/server/',
  },
  security: {
    // Only the canonical reverse-proxy host may influence Astro.url.
    allowedDomains: [{ protocol: RUNTIME_SITE_URL.protocol.slice(0, -1), hostname: RUNTIME_SITE_URL.hostname }],
  },
  site: PUBLIC_SITE_URL || undefined,
  devToolbar: {
    enabled: !IS_E2E,
  },

  integrations: [
    mdx(),
    icon({
      include: {
        tabler: ['*'],
        'flat-color-icons': [
          'template',
          'gallery',
          'approval',
          'document',
          'advertising',
          'currency-exchange',
          'voice-presentation',
          'business-contact',
          'database',
        ],
      },
    }),

    ...whenExternalScripts(() =>
      partytown({
        config: { forward: ['dataLayer.push'] },
      })
    ),

    astrowind({
      config: './src/config.yaml',
    }),
  ],

  image: {
    service: {
      entrypoint: 'astro/assets/services/sharp',
    },
    domains: ['cdn.pixabay.com'],
  },

  markdown: {
    // Astro 7 defaults to Satteri. These existing plugins use the unified pipeline.
    processor: unified({
      remarkPlugins: [readingTimeRemarkPlugin],
      rehypePlugins: [
        normalizeMarkdownHeadingsRehypePlugin,
        responsiveTablesRehypePlugin,
        lazyImagesRehypePlugin,
        autoInternalLinksRehypePlugin,
      ],
    }),
  },

  vite: {
    resolve: {
      alias: {
        '~': path.resolve(__dirname, './src'),
        '@': path.resolve(__dirname, './src'),
      },
    },
  },
});
