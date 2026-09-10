import { isIP } from 'node:net';

export function normalizeIp(value: string): string {
  let candidate = String(value || '').trim();
  if (!candidate) return '';

  if (candidate.startsWith('[') && candidate.endsWith(']')) {
    candidate = candidate.slice(1, -1).trim();
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.replace(/:\d+$/, '');
  }

  const lower = candidate.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const mapped = candidate.slice(7);
    if (isIP(mapped) === 4) {
      candidate = mapped;
    }
  }

  return candidate.toLowerCase();
}

export function validateIp(value: string): boolean {
  const normalized = normalizeIp(value);
  return isIP(normalized) !== 0;
}

function firstIpFromList(value: string | null): string {
  if (!value) return '';
  const candidates = value
    .split(',')
    .map((item) => normalizeIp(item))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (isIP(candidate) !== 0) return candidate;
  }

  return '';
}

function firstForwardedIp(value: string | null): string {
  if (!value) return '';
  const candidates = value
    .split(',')
    .map((item) => item.trim())
    .map((item) => {
      const match = item.match(/for="?([^;"]+)"?/i);
      return normalizeIp(match?.[1] || '');
    })
    .filter(Boolean);

  for (const candidate of candidates) {
    if (isIP(candidate) !== 0) return candidate;
  }

  return '';
}

export function resolveClientIp(request: Request, trustProxyHeaders: boolean, clientAddress?: string): string {
  const directCandidates = [normalizeIp(clientAddress || '')];
  const trustedProxyCandidates = [
    normalizeIp(request.headers.get('cf-connecting-ip') || ''),
    normalizeIp(request.headers.get('x-nf-client-connection-ip') || ''),
    normalizeIp(request.headers.get('true-client-ip') || ''),
    normalizeIp(request.headers.get('x-real-ip') || ''),
    firstIpFromList(request.headers.get('x-vercel-forwarded-for')),
    firstIpFromList(request.headers.get('x-forwarded-for')),
    firstForwardedIp(request.headers.get('forwarded')),
  ];

  const candidates = trustProxyHeaders ? [...trustedProxyCandidates, ...directCandidates] : directCandidates;

  for (const candidate of candidates) {
    if (candidate && isIP(candidate) !== 0) return candidate;
  }

  return '';
}
