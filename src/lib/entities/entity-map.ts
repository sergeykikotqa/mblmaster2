import type { CollectionEntry } from 'astro:content';

import { getCities, getServices } from '~/lib/geo-data';
import { resolveProjectSlug } from '~/lib/projects/project-adapters';

export type EntityType = 'business' | 'service' | 'city' | 'project' | 'article';

export type EntityId = `${EntityType}:${string}`;

export type Entity = {
  id: EntityId;
  type: EntityType;
  name: string;
  url?: string;
  attributes?: Record<string, string>;
};

export type EntityLinkType = 'offers' | 'located_in' | 'serves' | 'about' | 'related_to';

export type EntityLink = {
  from: EntityId;
  to: EntityId;
  relation: EntityLinkType;
};

export type EntityMap = {
  entities: Record<EntityId, Entity>;
  links: EntityLink[];
};

type ProjectEntry = CollectionEntry<'projects'>;
type ArticleEntry = CollectionEntry<'articles'>;

export type EntityContext = {
  slug: string;
  serviceId: string | null;
  cityId: string | null;
  tags: Set<string>;
};

export type ProjectEntityRef = {
  projectId: EntityId;
  serviceId: EntityId;
  cityId: EntityId;
  slug: string;
};

export type ProjectEntityIndex = Map<string, ProjectEntityRef>;

export function createEntityId(type: EntityType, slug: string): EntityId {
  return `${type}:${slug}` as EntityId;
}

export function normalizeEntitySlug(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '');
}

const normalizeEntityToken = (value: string): string =>
  String(value || '')
    .trim()
    .toLowerCase();

const splitEntityTokens = (value: string): string[] =>
  normalizeEntityToken(value)
    .split(/[^a-z0-9а-яё]+/giu)
    .map((token) => token.trim())
    .filter(Boolean);

const services = getServices();
const cities = getCities();

const serviceById = new Map(
  services.map((service) => [normalizeEntitySlug(service.id), service])
);
const serviceBySegment = new Map(
  services.map((service) => [normalizeEntitySlug(service.pathSegment || service.id), service])
);

const cityByToken = new Map<string, (typeof cities)[number]>();
for (const city of cities) {
  const tokens = [
    normalizeEntitySlug(city.id),
    normalizeEntityToken(city.name || ''),
    normalizeEntityToken(city.nameIn || ''),
    normalizeEntityToken(city.nameGenitive || ''),
  ];
  tokens.filter(Boolean).forEach((token) => cityByToken.set(token, city));
}

export function resolveServiceId(value: string): string | null {
  const token = normalizeEntitySlug(value);
  if (!token) return null;
  if (serviceById.has(token)) return serviceById.get(token)?.id || token;
  if (serviceBySegment.has(token)) return serviceBySegment.get(token)?.id || token;
  return token;
}

export function resolveServiceSlug(value: string): string | null {
  const token = normalizeEntitySlug(value);
  if (!token) return null;
  if (serviceBySegment.has(token)) return token;
  if (serviceById.has(token)) {
    const service = serviceById.get(token);
    return normalizeEntitySlug(service?.pathSegment || service?.id || token);
  }
  return token;
}

export function inferServiceFromArticle(article: ArticleEntry): string | null {
  const raw = normalizeEntityToken(
    `${article.data.category || ''} ${article.data.mainKeyword || ''} ${(article.data.tags || []).join(' ')}`
  );
  if (!raw) return null;
  if (raw.includes('гардероб')) return 'garderobnye';
  if (raw.includes('шкаф') || raw.includes('купе')) return 'shkafy';
  if (raw.includes('кухн')) return 'kuhni';
  return null;
}

function inferCityFromText(raw: string): string | null {
  const normalized = normalizeEntityToken(raw);
  if (!normalized) return null;
  for (const [token, city] of cityByToken.entries()) {
    if (token && normalized.includes(token)) {
      return city.id;
    }
  }
  return null;
}

export function inferCityFromArticle(article: ArticleEntry): string | null {
  const geoTarget = normalizeEntityToken(String(article.data.geoTarget || ''));
  if (geoTarget) {
    const direct = cityByToken.get(geoTarget);
    if (direct) return direct.id;
    const inferred = inferCityFromText(geoTarget);
    if (inferred) return inferred;
  }

  return inferCityFromText(
    `${article.data.title || ''} ${article.data.mainKeyword || ''} ${(article.data.tags || []).join(' ')}`
  );
}

function collectProjectTags(entry: ProjectEntry): Set<string> {
  const materials = entry.data.materials || {};
  const tokens = [
    entry.data.layout || '',
    entry.data.style || '',
    materials.facade || '',
    materials.tabletop || '',
    materials.hardware || '',
  ]
    .flatMap((value) => splitEntityTokens(String(value || '')))
    .filter(Boolean);
  return new Set(tokens);
}

function collectArticleTags(entry: ArticleEntry): Set<string> {
  const tokens = [
    entry.data.category || '',
    entry.data.mainKeyword || '',
    entry.data.title || '',
    ...(entry.data.tags || []),
  ]
    .flatMap((value) => splitEntityTokens(String(value || '')))
    .filter(Boolean);

  return new Set(tokens);
}

export function buildProjectContext(entry: ProjectEntry): EntityContext | null {
  if (entry.data.draft) return null;
  const slug = normalizeEntitySlug(resolveProjectSlug(entry));
  if (!slug) return null;
  const serviceId = resolveServiceId(String(entry.data.service || ''));
  const cityId = normalizeEntitySlug(String(entry.data.city || '')) || null;
  return {
    slug,
    serviceId,
    cityId,
    tags: collectProjectTags(entry),
  };
}

export function buildArticleContext(entry: ArticleEntry): EntityContext | null {
  if (entry.data.draft) return null;
  const slug = normalizeEntitySlug(String(entry.data.slug || entry.id).replace(/\.mdx?$/, ''));
  if (!slug) return null;
  const serviceId = resolveServiceId(String(inferServiceFromArticle(entry) || ''));
  const cityId = inferCityFromArticle(entry);
  return {
    slug,
    serviceId,
    cityId,
    tags: collectArticleTags(entry),
  };
}

export function createEntityMap(): EntityMap {
  return { entities: {}, links: [] };
}

export function addEntity(map: EntityMap, entity: Entity): void {
  map.entities[entity.id] = entity;
}

export function addLink(map: EntityMap, link: EntityLink): void {
  map.links.push(link);
}

export function getLinkedEntityIds(
  map: EntityMap,
  fromId: EntityId,
  relation?: EntityLinkType
): EntityId[] {
  return map.links
    .filter((link) => link.from === fromId && (!relation || link.relation === relation))
    .map((link) => link.to);
}

export function getLinkSources(map: EntityMap, toId: EntityId, relation?: EntityLinkType): EntityId[] {
  return map.links
    .filter((link) => link.to === toId && (!relation || link.relation === relation))
    .map((link) => link.from);
}

export function buildProjectEntityMap(entries: ProjectEntry[]): { map: EntityMap; projectIndex: ProjectEntityIndex } {
  const map = createEntityMap();
  const projectIndex: ProjectEntityIndex = new Map();

  const serviceNameBySlug = new Map(
    services.map((service) => [
      normalizeEntitySlug(service.pathSegment || service.id),
      String(service.name || service.pathSegment || service.id).trim(),
    ])
  );
  const cityNameBySlug = new Map(
    cities.map((city) => [normalizeEntitySlug(city.id), String(city.name || city.id).trim()])
  );

  const ensureEntity = (entity: Entity) => {
    if (!map.entities[entity.id]) {
      addEntity(map, entity);
    }
  };

  for (const entry of entries) {
    if (entry.data.draft) continue;
    const slug = normalizeEntitySlug(resolveProjectSlug(entry));
    if (!slug) continue;
    const serviceSlug = normalizeEntitySlug(String(entry.data.service || ''));
    const citySlug = normalizeEntitySlug(String(entry.data.city || ''));
    if (!serviceSlug || !citySlug) continue;

    const projectId = createEntityId('project', slug);
    const serviceId = createEntityId('service', serviceSlug);
    const cityId = createEntityId('city', citySlug);

    ensureEntity({
      id: serviceId,
      type: 'service',
      name: serviceNameBySlug.get(serviceSlug) || serviceSlug,
      url: `/${serviceSlug}`,
    });
    ensureEntity({
      id: cityId,
      type: 'city',
      name: cityNameBySlug.get(citySlug) || citySlug,
      url: `/${citySlug}`,
    });
    addEntity(map, {
      id: projectId,
      type: 'project',
      name: String(entry.data.title || slug).trim() || slug,
      url: `/projects/${slug}`,
      attributes: {
        service: serviceSlug,
        city: citySlug,
      },
    });
    addLink(map, { from: projectId, to: serviceId, relation: 'about' });
    addLink(map, { from: projectId, to: cityId, relation: 'located_in' });

    projectIndex.set(slug, { projectId, serviceId, cityId, slug });
  }

  return { map, projectIndex };
}
