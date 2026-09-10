import { describe, expect, it } from 'vitest';

import { resolveProjectImage } from '~/lib/projects/project-adapters';

describe('resolveProjectImage', () => {
  it('returns stable public project paths so Astro images can be optimized at render time', () => {
    const resolved = resolveProjectImage('raspashnoi-shkaf-s-antresolyu-irkutsk', '01.jpg', 'shkaf-raspashnoi-irkutsk');

    expect(resolved).toBe('/images/projects/shkaf-raspashnoi-irkutsk/01.jpg');
  });

  it('preserves explicit absolute paths for legacy public assets', () => {
    expect(resolveProjectImage('kuhnya-baykalskaya', '/images/projects/kuhnya-baykalskaya/01.jpg')).toBe(
      '/images/projects/kuhnya-baykalskaya/01.jpg'
    );
  });

  it('falls back to public-style project paths when no src asset is registered', () => {
    expect(resolveProjectImage('demo-project', '01.jpg', 'missing-project')).toBe('/images/projects/missing-project/01.jpg');
  });
});
