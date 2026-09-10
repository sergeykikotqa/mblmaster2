import type { CollectionEntry } from 'astro:content';

import { getServiceById } from '~/lib/geo-data';
import { buildProjectCards, resolveProjectSlug } from '~/lib/projects/project-adapters';
import type { ProjectCardData } from '~/types/project';

import {
  buildArticleContext,
  buildProjectContext,
  normalizeEntitySlug,
  resolveServiceId,
  resolveServiceSlug,
  type EntityContext,
} from './entity-map';

type ProjectEntry = CollectionEntry<'projects'>;
type ArticleEntry = CollectionEntry<'articles'>;

export type RelatedService = {
  id: string;
  name: string;
  href: string;
};

export type RelatedEntitiesResult = {
  projects: ProjectCardData[];
  articles: ArticleEntry[];
  service: RelatedService | null;
};

export type RelatedEntitiesParams = {
  type: 'project' | 'article' | 'service';
  slug: string;
  projects: ProjectEntry[];
  articles: ArticleEntry[];
  limits?: {
    projects?: number;
    articles?: number;
    services?: number;
  };
};

const DEFAULT_LIMITS = {
  projects: 3,
  articles: 2,
  services: 1,
};

const resolveArticleSlug = (entry: ArticleEntry): string =>
  normalizeEntitySlug(String(entry.data.slug || entry.id).replace(/\.mdx?$/, ''));

function resolveServiceLink(token: string | null): RelatedService | null {
  if (!token) return null;
  const serviceId = resolveServiceId(token);
  const serviceSlug = resolveServiceSlug(token);
  if (!serviceId || !serviceSlug) return null;
  const service = getServiceById(serviceId);
  return {
    id: serviceId,
    name: String(service?.name || serviceSlug).trim() || serviceSlug,
    href: `/${serviceSlug}`,
  };
}

function hasSharedTags(base: Set<string>, candidate: Set<string>): boolean {
  if (!base.size || !candidate.size) return false;
  for (const tag of candidate) {
    if (base.has(tag)) return true;
  }
  return false;
}

function scoreCandidate(base: EntityContext, candidate: EntityContext): number {
  if (base.slug === candidate.slug) return Number.NEGATIVE_INFINITY;
  let score = 0;
  if (base.serviceId && candidate.serviceId && base.serviceId === candidate.serviceId) score += 3;
  if (base.cityId && candidate.cityId && base.cityId === candidate.cityId) score += 2;
  if (hasSharedTags(base.tags, candidate.tags)) score += 1;
  return score;
}

function shouldConsider(base: EntityContext, candidate: EntityContext): boolean {
  if (base.slug === candidate.slug) return false;
  if (base.serviceId && candidate.serviceId) {
    return base.serviceId === candidate.serviceId;
  }
  return hasSharedTags(base.tags, candidate.tags);
}

export function getRelatedEntities({
  type,
  slug,
  projects,
  articles,
  limits = {},
}: RelatedEntitiesParams): RelatedEntitiesResult {
  const resolvedLimits = {
    projects: limits.projects ?? DEFAULT_LIMITS.projects,
    articles: limits.articles ?? DEFAULT_LIMITS.articles,
    services: limits.services ?? DEFAULT_LIMITS.services,
  };

  let baseContext: EntityContext | null = null;

  if (type === 'project') {
    const entry = projects.find(
      (item) => normalizeEntitySlug(resolveProjectSlug(item)) === normalizeEntitySlug(slug)
    );
    baseContext = entry ? buildProjectContext(entry) : null;
  } else if (type === 'article') {
    const entry = articles.find((item) => resolveArticleSlug(item) === normalizeEntitySlug(slug));
    baseContext = entry ? buildArticleContext(entry) : null;
  } else if (type === 'service') {
    baseContext = {
      slug: normalizeEntitySlug(slug),
      serviceId: resolveServiceId(slug),
      cityId: null,
      tags: new Set(),
    };
  }

  if (!baseContext) {
    return { projects: [], articles: [], service: null };
  }

  const relatedService =
    resolvedLimits.services > 0 ? resolveServiceLink(baseContext.serviceId || '') : null;

  const projectCandidates = projects
    .map((entry) => ({
      entry,
      context: buildProjectContext(entry),
    }))
    .filter((item) => item.context && shouldConsider(baseContext, item.context))
    .map((item) => ({
      entry: item.entry,
      score: scoreCandidate(baseContext, item.context!),
      date: new Date(item.entry.data.publishDate || 0).getTime(),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.date - a.date;
    })
    .slice(0, resolvedLimits.projects)
    .map((item) => item.entry);

  const relatedProjects = buildProjectCards(projectCandidates);

  const eligibleArticles = articles.filter((entry) => !entry.data.isArchived && !entry.data.noindex);

  const articleCandidates = eligibleArticles
    .map((entry) => ({
      entry,
      context: buildArticleContext(entry),
    }))
    .filter((item) => item.context && shouldConsider(baseContext, item.context))
    .map((item) => ({
      entry: item.entry,
      score: scoreCandidate(baseContext, item.context!),
      ready: item.entry.data.seoReady === true ? 1 : 0,
      date: new Date(item.entry.data.publishDate || 0).getTime(),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.ready !== a.ready) return b.ready - a.ready;
      return b.date - a.date;
    })
    .slice(0, resolvedLimits.articles)
    .map((item) => item.entry);

  return {
    projects: relatedProjects,
    articles: articleCandidates,
    service: relatedService,
  };
}
