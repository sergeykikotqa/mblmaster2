import servicesRaw from '../../data/services.json';
import { normalizePath } from './path-utils';

export { normalizePath };

function normalizeSegment(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '');
}

const PRIMARY_CITY_ID = String(import.meta.env.PUBLIC_PRIMARY_SEO_CITY_ID || 'irkutsk')
  .trim()
  .toLowerCase();
const services = servicesRaw as Array<{ id?: string; pathSegment?: string }>;
const serviceSegmentById = new Map<string, string>();
const serviceIdBySegment = new Map<string, string>();

for (const service of services) {
  const serviceId = normalizeSegment(service?.id || '');
  if (!serviceId) continue;
  const serviceSegment = normalizeSegment(service?.pathSegment || serviceId);
  if (!serviceSegment) continue;
  serviceSegmentById.set(serviceId, serviceSegment);
  serviceIdBySegment.set(serviceSegment, serviceId);
}

function resolveServiceSegment(serviceToken: string): string {
  const normalized = normalizeSegment(serviceToken);
  if (!normalized) return normalized;
  if (serviceSegmentById.has(normalized)) return serviceSegmentById.get(normalized) || normalized;
  if (serviceIdBySegment.has(normalized)) return normalized;
  return normalized;
}

export function resolveServiceId(serviceToken: string): string {
  const normalized = normalizeSegment(serviceToken);
  if (!normalized) return normalized;
  if (serviceIdBySegment.has(normalized)) return serviceIdBySegment.get(normalized) || normalized;
  if (serviceSegmentById.has(normalized)) return normalized;
  return normalized;
}

export function getPrimarySeoCityId(): string {
  return PRIMARY_CITY_ID || 'irkutsk';
}

export function buildCityPath(cityId: string): string {
  return normalizePath(`/${normalizeSegment(cityId)}`);
}

export function buildServicePath(serviceId: string): string {
  const serviceSegment = resolveServiceSegment(serviceId);
  return normalizePath(`/${serviceSegment}`);
}

export function toCanonical(pathname: string, site: URL | string | undefined): string {
  void site;
  return normalizePath(pathname);
}

export function toAbsoluteUrl(pathname: string, site: URL | string | undefined): string {
  const normalizedPath = normalizePath(pathname);
  if (!site) return normalizedPath;

  try {
    const siteUrl = typeof site === 'string' ? new URL(site) : site;
    return new URL(normalizedPath, siteUrl).toString();
  } catch {
    return normalizedPath;
  }
}
