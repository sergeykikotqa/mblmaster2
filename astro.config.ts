import path from 'path';
import { fileURLToPath } from 'url';

import { defineConfig } from 'astro/config';

import tailwind from '@astrojs/tailwind';
import mdx from '@astrojs/mdx';
import partytown from '@astrojs/partytown';
import node from '@astrojs/node';
import icon from 'astro-icon';
import compress from 'astro-compress';
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
const PUBLIC_SITE_URL = String(process.env.PUBLIC_SITE_URL || '').trim();
const IS_E2E = String(process.env.PUBLIC_E2E || '').trim() === '1';
const RUNTIME_SITE_URL = new URL(PUBLIC_SITE_URL || 'https://mebel-irkutsk.ru');

const hasExternalScripts = false;
const whenExternalScripts = (items: (() => AstroIntegration) | (() => AstroIntegration)[] = []) =>
  hasExternalScripts ? (Array.isArray(items) ? items.map((item) => item()) : [items()]) : [];

export default defineConfig({
  // Public pages stay prerendered; routes with prerender=false run in Node.
  output: 'static',
  trailingSlash: 'never',
  adapter: node({ mode: 'standalone' }),
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
    tailwind({
      applyBaseStyles: false,
    }),
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

    compress({
      CSS: true,
      HTML: {
        'html-minifier-terser': {
          removeAttributeQuotes: false,
        },
      },
      Image: false,
      JavaScript: true,
      SVG: false,
      Logger: 1,
    }),

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
    remarkPlugins: [readingTimeRemarkPlugin],
    rehypePlugins: [
      normalizeMarkdownHeadingsRehypePlugin,
      responsiveTablesRehypePlugin,
      lazyImagesRehypePlugin,
      autoInternalLinksRehypePlugin,
    ],
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
