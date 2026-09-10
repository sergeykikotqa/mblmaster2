type CanonicalConfig = {
  publicSiteUrl?: string;
  isProduction?: boolean;
};

function normalizePath(pathname: string): string {
  const clean = String(pathname || '/').trim();
  if (!clean || clean === '/') return '/';

  const withLeadingSlash = clean.startsWith('/') ? clean : `/${clean}`;
  return withLeadingSlash.replace(/\/+$/, '') || '/';
}

function readPublicSiteUrl(): string {
  const fromProcess =
    typeof process !== 'undefined' && process.env ? String(process.env.PUBLIC_SITE_URL || '') : '';
  if (fromProcess.trim()) return fromProcess.trim();

  const metaEnv = typeof import.meta !== 'undefined' ? (import.meta as ImportMeta).env : undefined;
  const fromMeta = metaEnv ? String((metaEnv as { PUBLIC_SITE_URL?: string }).PUBLIC_SITE_URL || '') : '';
  return fromMeta.trim();
}

function isProductionMode(): boolean {
  const metaEnv = typeof import.meta !== 'undefined' ? (import.meta as ImportMeta).env : undefined;
  if (metaEnv && typeof (metaEnv as { PROD?: boolean }).PROD === 'boolean') {
    return Boolean((metaEnv as { PROD?: boolean }).PROD);
  }
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function isNonProductionHost(hostname: string): boolean {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '0.0.0.0') return true;
  if (normalized.endsWith('.local') || normalized.endsWith('.localhost')) return true;
  return false;
}

export function getCanonicalUrl(input: URL, config: CanonicalConfig = {}): string {
  if (!(input instanceof URL)) {
    throw new Error('[canonical] getCanonicalUrl expects a URL instance');
  }

  const url = new URL(input.toString());
  url.search = '';
  url.hash = '';
  url.pathname = normalizePath(url.pathname);

  const publicSiteUrl = String(config.publicSiteUrl || readPublicSiteUrl() || '').trim();
  const isProduction = typeof config.isProduction === 'boolean' ? config.isProduction : isProductionMode();

  if (publicSiteUrl) {
    const publicUrl = new URL(publicSiteUrl);
    url.protocol = publicUrl.protocol;
    url.host = publicUrl.host;
  } else if (isProduction && isNonProductionHost(url.hostname)) {
    throw new Error(
      `[canonical] invalid host "${url.hostname}". Set PUBLIC_SITE_URL to enforce production canonical URLs.`
    );
  }

  return url.toString();
}
