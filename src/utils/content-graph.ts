export type ContentCluster = 'kitchen' | 'storage' | 'local' | 'general';

type EntryWithSeoData = {
  id: string;
  data: {
    category?: string;
    mainKeyword?: string;
    tags?: string[];
    publishDate?: Date;
  };
};

export function getSlugFromEntryId(id: string): string {
  return id.replace(/\.mdx?$/, '');
}

export function normalizeCluster(entry: EntryWithSeoData): ContentCluster {
  const raw = `${entry.data.category || ''} ${entry.data.mainKeyword || ''} ${(entry.data.tags || []).join(' ')}`
    .trim()
    .toLowerCase();

  if (raw.includes('кухн')) return 'kitchen';
  if (raw.includes('шкаф') || raw.includes('гардероб') || raw.includes('хранен')) return 'storage';
  if (raw.includes('район') || raw.includes('иркут')) return 'local';
  return 'general';
}

export function scoreRelated(base: EntryWithSeoData, candidate: EntryWithSeoData): number {
  const baseTags = new Set((base.data.tags || []).map((tag) => String(tag).trim().toLowerCase()));
  const candidateTags = (candidate.data.tags || []).map((tag) => String(tag).trim().toLowerCase());
  let score = 0;

  for (const tag of candidateTags) {
    if (baseTags.has(tag)) score += 2;
  }

  if (
    String(base.data.mainKeyword || '')
      .trim()
      .toLowerCase() ===
    String(candidate.data.mainKeyword || '')
      .trim()
      .toLowerCase()
  ) {
    score += 1;
  }

  return score;
}

export function buildAutoRelated<T extends EntryWithSeoData>(base: T, entries: T[], limit = 3): T[] {
  const currentSlug = getSlugFromEntryId(base.id);
  const cluster = normalizeCluster(base);

  return entries
    .filter((entry) => getSlugFromEntryId(entry.id) !== currentSlug)
    .filter((entry) => normalizeCluster(entry) === cluster)
    .sort((a, b) => {
      const scoreDiff = scoreRelated(base, b) - scoreRelated(base, a);
      if (scoreDiff !== 0) return scoreDiff;
      const aDate = new Date(a.data.publishDate || 0).getTime();
      const bDate = new Date(b.data.publishDate || 0).getTime();
      return bDate - aDate;
    })
    .slice(0, limit);
}
