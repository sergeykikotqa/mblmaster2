export interface OpenGraphMedia {
  url?: string;
  width?: number;
  height?: number;
  alt?: string;
  type?: string;
  secureUrl?: string;
}

export interface OpenGraph {
  url?: string;
  title?: string;
  description?: string;
  site_name?: string;
  images?: ReadonlyArray<OpenGraphMedia>;
  locale?: string;
  type?: string;
}

export interface TwitterMeta {
  handle?: string;
  site?: string;
  cardType?: string;
}

export interface SeoHeadProps {
  title?: string;
  titleTemplate?: string;
  canonical?: string;
  noindex?: boolean;
  nofollow?: boolean;
  description?: string;
  openGraph?: OpenGraph;
  twitter?: TwitterMeta;
}
