import path from 'path';
import { fileURLToPath } from 'url';

import { defineConfig } from 'astro/config';

import tailwind from '@astrojs/tailwind';
import mdx from '@astrojs/mdx';
import partytown from '@astrojs/partytown';
import netlify from '@astrojs/netlify';
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
const NETLIFY_IMAGE_CDN_ENV = String(process.env.NETLIFY_IMAGE_CDN || '').trim().toLowerCase();
const USE_NETLIFY_IMAGE_CDN =
  NETLIFY_IMAGE_CDN_ENV === '' ? true : !['0', 'false', 'no'].includes(NETLIFY_IMAGE_CDN_ENV);

const hasExternalScripts = false;
const whenExternalScripts = (items: (() => AstroIntegration) | (() => AstroIntegration)[] = []) =>
  hasExternalScripts ? (Array.isArray(items) ? items.map((item) => item()) : [items()]) : [];

export default defineConfig({
  // P0 decision: keep static output and deploy /api/* as platform functions.
  // Current adapter: Netlify Functions. If platform changes, switch adapter accordingly.
  output: 'static',
  trailingSlash: 'never',
  adapter: netlify({ imageCDN: USE_NETLIFY_IMAGE_CDN }),
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
