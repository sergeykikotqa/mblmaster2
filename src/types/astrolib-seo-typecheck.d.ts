declare module '@astrolib/seo' {
  import type { AstroComponentFactory } from 'astro/runtime/server/index.js';

  export type OpenGraph = {
    url?: string;
    site_name?: string;
    images?: Array<{ url?: string; width?: number; height?: number }>;
    locale?: string;
    type?: string;
  };

  export interface Props {
    title?: string;
    titleTemplate?: string;
    canonical?: string;
    noindex?: boolean;
    nofollow?: boolean;
    description?: string;
    openGraph?: OpenGraph;
    twitter?: Record<string, unknown>;
  }

  export const AstroSeo: AstroComponentFactory;
}
