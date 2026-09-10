export function normalizePath(pathname: string): string {
  const clean = String(pathname || '/').trim();
  if (!clean || clean === '/') return '/';

  const withLeadingSlash = clean.startsWith('/') ? clean : `/${clean}`;
  return withLeadingSlash.replace(/\/+$/, '') || '/';
}

