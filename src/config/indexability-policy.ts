import fs from 'node:fs';
import path from 'node:path';

const ARTICLE_SEO_STATE_PATH = path.join(process.cwd(), 'data', 'article-seo-state.json');

const INDEX_PATHS = Object.freeze([
  '/',
  '/contacts',
  '/o-kompanii',
  '/kuhni',
  '/kuhni-3-metra',
  '/shkafy',
  '/garderobnye',
  '/projects',
  '/projects/*',
  '/guides/*',
  '/faq',
  '/faq/*',
  '/irkutsk',
  '/angarsk',
  '/shelekhov',
]);

const TEMP_NOINDEX_PATHS = Object.freeze(['/articles', '/articles/*']);

const NOINDEX_FOLLOW_PATHS = Object.freeze(['/guides', '/privacy', '/terms', '/projects/kuhnya-baykalskaya']);

const BLOCKED_PATHS = Object.freeze(['/404', '/410', '/thanks', '/admin/*', '/api/*', '/decapcms', '/decapcms/*']);

export { INDEX_PATHS, TEMP_NOINDEX_PATHS, NOINDEX_FOLLOW_PATHS, BLOCKED_PATHS };

// Backward-compatible export: article indexing is enabled via seoReady rollout, not sitewide.
export const ARTICLE_INDEXING_ENABLED = true;

type ArticleSeoState = {
  readyArticlePaths: string[];
  readyArticlePathSet: Set<string>;
  archivedArticlePaths: string[];
  archivedArticlePathSet: Set<string>;
  noindexArticlePaths: string[];
  noindexArticlePathSet: Set<string>;
  hasReadyArticles: boolean;
};

type RawArticleSeoState = {
  readyArticlePaths?: string[];
  archivedArticlePaths?: string[];
  noindexArticlePaths?: string[];
  hasReadyArticles?: boolean;
};

let cachedArticleSeoState: ArticleSeoState | undefined;

function uniquePatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns)];
}

export function normalizePolicyPath(value: string): string {
  const raw = String(value || '/').trim();
  if (!raw || raw === '/') return '/';

  const withoutOrigin = raw.replace(/^[a-z]+:\/\/[^/]+/i, '');
  const withoutQueryHash = withoutOrigin.split(/[?#]/)[0] || '/';
  const withLeadingSlash = withoutQueryHash.startsWith('/') ? withoutQueryHash : `/${withoutQueryHash}`;
  return withLeadingSlash.replace(/\/+$/, '') || '/';
}

function normalizePattern(pattern: string): string {
  const raw = String(pattern || '').trim();
  if (!raw) return '';
  if (raw.endsWith('/*')) {
    const base = normalizePolicyPath(raw.slice(0, -2));
    return `${base}/*`;
  }
  return normalizePolicyPath(raw);
}

function matchesPattern(pattern: string, pathname: string): boolean {
  const normalizedPattern = normalizePattern(pattern);
  const normalizedPath = normalizePolicyPath(pathname);
  if (!normalizedPattern) return false;

  if (normalizedPattern.endsWith('/*')) {
    const base = normalizedPattern.slice(0, -2);
    return normalizedPath === base || normalizedPath.startsWith(`${base}/`);
  }

  return normalizedPath === normalizedPattern;
}

function loadArticleSeoState(): ArticleSeoState {
  if (cachedArticleSeoState) {
    return cachedArticleSeoState;
  }

  let rawState = {};

  try {
    if (fs.existsSync(ARTICLE_SEO_STATE_PATH)) {
      rawState = JSON.parse(fs.readFileSync(ARTICLE_SEO_STATE_PATH, 'utf8'));
    }
  } catch {
    rawState = {};
  }

  const parsedState = rawState as RawArticleSeoState;

  const readyArticlePaths: string[] = uniquePatterns(
    Array.isArray(parsedState.readyArticlePaths)
      ? parsedState.readyArticlePaths.map((item: string) => normalizePolicyPath(item))
      : []
  ).sort();
  const archivedArticlePaths: string[] = uniquePatterns(
    Array.isArray(parsedState.archivedArticlePaths)
      ? parsedState.archivedArticlePaths.map((item: string) => normalizePolicyPath(item))
      : []
  ).sort();
  const noindexArticlePaths: string[] = uniquePatterns(
    Array.isArray(parsedState.noindexArticlePaths)
      ? parsedState.noindexArticlePaths.map((item: string) => normalizePolicyPath(item))
      : []
  ).sort();

  cachedArticleSeoState = {
    readyArticlePaths,
    readyArticlePathSet: new Set(readyArticlePaths),
    archivedArticlePaths,
    archivedArticlePathSet: new Set(archivedArticlePaths),
    noindexArticlePaths,
    noindexArticlePathSet: new Set(noindexArticlePaths),
    hasReadyArticles:
      typeof parsedState.hasReadyArticles === 'boolean' ? parsedState.hasReadyArticles : readyArticlePaths.length > 0,
  } satisfies ArticleSeoState;

  return cachedArticleSeoState;
}

export function getArticleSeoState() {
  const state = loadArticleSeoState();
  return {
    readyArticlePaths: [...state.readyArticlePaths],
    archivedArticlePaths: [...state.archivedArticlePaths],
    noindexArticlePaths: [...state.noindexArticlePaths],
    hasReadyArticles: state.hasReadyArticles,
  };
}

function createKnownPolicy(
  pathname: string,
  overrides: {
    classification: string;
    matchedPattern: string;
    index: boolean;
    follow: boolean;
    includeInSitemap: boolean;
  }
) {
  return {
    pathname,
    canonicalPath: pathname,
    classification: overrides.classification,
    matchedPattern: overrides.matchedPattern,
    index: overrides.index,
    follow: overrides.follow,
    includeInSitemap: overrides.includeInSitemap,
    isKnown: true,
  };
}

function getArticlePolicy(pathname: string) {
  const normalizedPath = normalizePolicyPath(pathname);
  if (normalizedPath !== '/articles' && !normalizedPath.startsWith('/articles/')) {
    return null;
  }

  const articleSeoState = loadArticleSeoState();

  if (normalizedPath === '/articles') {
    if (articleSeoState.hasReadyArticles) {
      return createKnownPolicy(normalizedPath, {
        classification: 'index',
        matchedPattern: '/articles',
        index: true,
        follow: true,
        includeInSitemap: true,
      });
    }

    return createKnownPolicy(normalizedPath, {
      classification: 'temp-noindex',
      matchedPattern: '/articles',
      index: false,
      follow: true,
      includeInSitemap: false,
    });
  }

  if (articleSeoState.archivedArticlePathSet.has(normalizedPath)) {
    return createKnownPolicy(normalizedPath, {
      classification: 'archived',
      matchedPattern: '/articles/*',
      index: false,
      follow: false,
      includeInSitemap: false,
    });
  }

  if (articleSeoState.noindexArticlePathSet.has(normalizedPath)) {
    return createKnownPolicy(normalizedPath, {
      classification: 'noindex',
      matchedPattern: '/articles/*',
      index: false,
      follow: false,
      includeInSitemap: false,
    });
  }

  if (articleSeoState.readyArticlePathSet.has(normalizedPath)) {
    return createKnownPolicy(normalizedPath, {
      classification: 'index',
      matchedPattern: '/articles/*',
      index: true,
      follow: true,
      includeInSitemap: true,
    });
  }

  return createKnownPolicy(normalizedPath, {
    classification: 'temp-noindex',
    matchedPattern: '/articles/*',
    index: false,
    follow: true,
    includeInSitemap: false,
  });
}

function getPolicyGroups() {
  return [
    {
      classification: 'blocked',
      patterns: uniquePatterns(BLOCKED_PATHS),
      index: false,
      follow: false,
      includeInSitemap: false,
    },
    {
      classification: 'temp-noindex',
      patterns: uniquePatterns([]),
      index: false,
      follow: true,
      includeInSitemap: false,
    },
    {
      classification: 'noindex-follow',
      patterns: uniquePatterns(NOINDEX_FOLLOW_PATHS),
      index: false,
      follow: true,
      includeInSitemap: false,
    },
    {
      classification: 'index',
      patterns: uniquePatterns(INDEX_PATHS),
      index: true,
      follow: true,
      includeInSitemap: true,
    },
  ];
}

export function getIndexabilityPolicy(pathname: string) {
  const normalizedPath = normalizePolicyPath(pathname);
  const articlePolicy = getArticlePolicy(normalizedPath);
  if (articlePolicy) {
    return articlePolicy;
  }

  for (const group of getPolicyGroups()) {
    const matchedPattern = group.patterns.find((pattern) => matchesPattern(pattern, normalizedPath));
    if (!matchedPattern) continue;

    return {
      pathname: normalizedPath,
      canonicalPath: normalizedPath,
      classification: group.classification,
      matchedPattern,
      index: group.index,
      follow: group.follow,
      includeInSitemap: group.includeInSitemap,
      isKnown: true,
    };
  }

  return {
    pathname: normalizedPath,
    canonicalPath: normalizedPath,
    classification: 'unclassified',
    matchedPattern: null,
    index: false,
    follow: false,
    includeInSitemap: false,
    isKnown: false,
  };
}

export function isSitemapIncluded(pathname: string) {
  return getIndexabilityPolicy(pathname).includeInSitemap;
}
