import { describe, expect, it } from 'vitest';

import {
  buildProjectRenderPlan,
  getPresentProjectBlockTypes,
  type ProjectRenderableBlock,
} from '~/lib/projects/project-render-plan';
import type { ProjectViewModel } from '~/lib/projects/project-view-model';

const createViewModel = (overrides: Partial<ProjectViewModel> = {}): ProjectViewModel =>
  ({
    hasBlocks: false,
    blocks: null,
    task: { text: 'Нужно разместить хранение', bullets: [], constraints: [] },
    solution: { text: 'Собрали систему под нишу', splitImage: '', anchor: undefined },
    gallery: {
      images: ['01.jpg'],
      imagesForBlocks: ['01.jpg'],
      alt: 'Демо проект',
      captions: {},
      heroImage: '01.jpg',
    },
    materials: { items: [], summary: '', railItems: [] },
    process: { steps: [], image: '', railSteps: [] },
    beforeAfter: { items: [] },
    video: { data: undefined, poster: '', thumbnailUrl: '', hasVideo: false },
    hasBodyContent: false,
    cost: { hasCost: false, label: '', note: '', breakdown: [], summaryPrice: '' },
    faq: { items: [] },
    internalLinks: [],
    ...overrides,
  }) as ProjectViewModel;

const block = (type: string): ProjectRenderableBlock => ({ type } as ProjectRenderableBlock);

describe('buildProjectRenderPlan', () => {
  it('returns an empty plan when no blocks are authored', () => {
    const viewModel = createViewModel();

    const plan = buildProjectRenderPlan(viewModel);

    expect(plan.source).toBe('blocks');
    expect(getPresentProjectBlockTypes(plan)).toEqual([]);
    expect(plan.hasRelatedBlock).toBe(false);
    expect(plan.hasVideoBlock).toBe(false);
  });

  it('uses authored blocks as-is without injecting legacy fallbacks', () => {
    const viewModel = createViewModel({
      hasBlocks: true,
      blocks: [block('gallery'), block('quote'), block('cta')],
      cost: {
        hasCost: true,
        label: '210 000 ₽',
        note: '',
        breakdown: [],
        summaryPrice: '210 000 ₽',
      },
      hasBodyContent: true,
    });

    const plan = buildProjectRenderPlan(viewModel);

    expect(plan.source).toBe('blocks');
    expect(getPresentProjectBlockTypes(plan)).toEqual(['gallery', 'quote', 'cta']);
    expect(plan.hasRelatedBlock).toBe(false);
  });

  it('keeps unsupported block types visible for dev diagnostics', () => {
    const viewModel = createViewModel({
      hasBlocks: true,
      blocks: [block('gallery'), block('customProof')],
    });

    const plan = buildProjectRenderPlan(viewModel);

    expect(getPresentProjectBlockTypes(plan)).toEqual(['gallery']);
    expect(plan.unknownBlocks).toHaveLength(1);
    expect(plan.unknownBlocks[0]?.type).toBe('customProof');
  });
});
