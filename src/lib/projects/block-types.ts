export const PROJECT_BLOCK_TYPES = [
  'hero',
  'gallery',
  'specs',
  'cost',
  'task',
  'solution',
  'split',
  'quote',
  'materials',
  'process',
  'beforeAfter',
  'video',
  'result',
  'faq',
  'links',
  'cta',
  'related',
] as const;

export type ProjectBlockType = (typeof PROJECT_BLOCK_TYPES)[number];
