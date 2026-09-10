import type { AstroComponentFactory } from 'astro/runtime/server/index.js';
import type { ProjectViewModel } from '~/lib/projects/project-view-model';

export type ProjectBlock = NonNullable<ProjectViewModel['blocks']>[number];

export type ProjectBlockProps = {
  block: ProjectBlock;
  index: number;
  typeIndex?: number;
  viewModel: ProjectViewModel;
  Content?: AstroComponentFactory;
};
