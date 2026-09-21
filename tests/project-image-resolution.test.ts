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

  it('maps legacy Figma case references to real MBL project images', () => {
    expect(
      resolveProjectImage('kuhnya-legacy-demo', '/images/figma/portfolio-modern-light.jpg', undefined, 0)
    ).toBe('/images/projects/kuhnya-trilissera/01.jpg');
    expect(
      resolveProjectImage('kuhnya-legacy-demo', '/images/figma/portfolio-detail-wood.png', undefined, 1)
    ).toBe('/images/projects/kuhnya-trilissera/02.jpg');
    expect(
      resolveProjectImage(
        'shkaf-vstroennyi-angarsk-84-i-kvartal',
        '/images/figma/portfolio-detail-drawer.png',
        undefined,
        1
      )
    ).toBe('/images/projects/shkaf-kupe-na-vsyu-stenu-irkutsk/03.jpg');
  });

  it('keeps explicit project asset paths stable when the slug differs', () => {
    expect(
      resolveProjectImage('legacy-case', '/images/projects/kuhnya-piskunova/02.jpg')
    ).toBe('/images/projects/kuhnya-piskunova/02.jpg');
  });
});
