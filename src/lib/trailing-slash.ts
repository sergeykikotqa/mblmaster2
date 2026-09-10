const INTERNAL_PREFIXES = ['/_', '/@', '/.', '//'];
const FILE_EXTENSION_PATTERN = /\/[^/]+\.\w+$/;

export function getTrailingSlashRedirect(pathname: string): string | null {
  if (pathname === '/' || pathname.length <= 1) return null;
  if (!pathname.endsWith('/')) return null;
  if (INTERNAL_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;
  const normalizedPath = pathname.slice(0, -1) || '/';
  if (FILE_EXTENSION_PATTERN.test(normalizedPath)) return null;

  return normalizedPath;
}
