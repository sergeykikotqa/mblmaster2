import { describe, expect, it } from 'vitest';

import { normalizeProjectContent, type ProjectEntry } from '~/lib/projects/normalized-project-content';

const makeEntry = (overrides: Partial<ProjectEntry['data']> = {}, body = '') =>
  ({
    id: 'demo-project',
    slug: 'demo-project',
    body,
    collection: 'projects',
    data: {
      title: 'Демо проект',
      description: '',
      publishDate: '2026-03-21T00:00:00.000Z',
      city: 'irkutsk',
      service: 'shkafy',
      layout: 'линейная',
      style: 'современный',
      images: ['01.jpg'],
      duration: 12,
      ...overrides,
    },
  }) as unknown as ProjectEntry;

describe('normalizeProjectContent', () => {
  it('normalizes slug, imageBaseDir and derived labels in one place', () => {
    const entry = makeEntry({
      slug: 'tv-zona-demo',
      imageBaseDir: 'src/assets/images/projects/tv-zona-s-podvesnymi-modulyami-irkutsk',
      serviceLabelOverride: {
        noun: 'тв-зона',
        plural: 'тв-зоны',
        genitive: 'тв-зоны',
        accusative: 'тв-зону',
      },
    });

    const normalized = normalizeProjectContent(entry);

    expect(normalized.slug).toBe('tv-zona-demo');
    expect(normalized.href).toBe('/projects/tv-zona-demo');
    expect(normalized.imageBaseDir).toBe('tv-zona-s-podvesnymi-modulyami-irkutsk');
    expect(normalized.data.imageBaseDir).toBe('tv-zona-s-podvesnymi-modulyami-irkutsk');
    expect(normalized.serviceLabels.noun).toBe('тв-зона');
    expect(normalized.coverImage).toMatch(/01\.jpg$/);
  });

  it('falls back imageBaseDir to the resolved slug when frontmatter omits it', () => {
    const entry = makeEntry({
      slug: 'rabochaya-zona-pod-skatom-irkutsk',
      imageBaseDir: undefined,
    });

    const normalized = normalizeProjectContent(entry);

    expect(normalized.imageBaseDir).toBe('rabochaya-zona-pod-skatom-irkutsk');
    expect(normalized.data.imageBaseDir).toBe('rabochaya-zona-pod-skatom-irkutsk');
  });

  it('normalizes price fallbacks and body for downstream builders', () => {
    const entry = makeEntry(
      {
        price: undefined,
        estimatedPrice: 182000,
      },
      'Описание проекта из markdown body.'
    );

    const normalized = normalizeProjectContent(entry);

    expect(normalized.hasActualPrice).toBe(false);
    expect(normalized.hasEstimatedPrice).toBe(true);
    expect(normalized.resolvedPriceValue).toBe(182000);
    expect(normalized.body).toContain('markdown body');
  });
});
