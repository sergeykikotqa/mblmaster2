import { PROJECT_BLOCK_TYPES, type ProjectBlockType } from './project-block-types';
import type { ProjectViewModel } from './project-view-model';

export type ProjectRenderableBlock = NonNullable<ProjectViewModel['blocks']>[number];

export type ProjectRenderableBlockRef = {
  block: ProjectRenderableBlock;
  index: number;
  type: string;
  typeIndex: number;
};

export type ProjectRenderPlan = {
  source: 'blocks';
  blocksByType: Map<string, ProjectRenderableBlockRef[]>;
  hasRelatedBlock: boolean;
  hasVideoBlock: boolean;
  unknownBlocks: ProjectRenderableBlockRef[];
};

const KNOWN_BLOCK_TYPES = new Set<string>(PROJECT_BLOCK_TYPES);

export const getPresentProjectBlockTypes = (
  plan: ProjectRenderPlan,
  orderedTypes: readonly ProjectBlockType[] = PROJECT_BLOCK_TYPES
): ProjectBlockType[] => orderedTypes.filter((type) => (plan.blocksByType.get(type) ?? []).length > 0);

export const buildProjectRenderPlan = (viewModel: ProjectViewModel): ProjectRenderPlan => {
  const sourceBlocks = Array.isArray(viewModel.blocks) ? [...viewModel.blocks] : [];
  const blocksByType = new Map<string, ProjectRenderableBlockRef[]>();
  const unknownBlocks: ProjectRenderableBlockRef[] = [];
  const unknownCounters = new Map<string, number>();

  sourceBlocks.forEach((block, index) => {
    const type = String(block.type || 'unsupported');

    if (KNOWN_BLOCK_TYPES.has(type)) {
      const group = blocksByType.get(type) ?? [];
      const entry = { block, index, type, typeIndex: group.length };
      blocksByType.set(type, [...group, entry]);
      return;
    }

    const typeIndex = unknownCounters.get(type) ?? 0;
    unknownCounters.set(type, typeIndex + 1);
    unknownBlocks.push({ block, index, type, typeIndex });
  });

  return {
    source: 'blocks',
    blocksByType,
    hasRelatedBlock: (blocksByType.get('related') ?? []).length > 0,
    hasVideoBlock: (blocksByType.get('video') ?? []).length > 0,
    unknownBlocks,
  };
};
