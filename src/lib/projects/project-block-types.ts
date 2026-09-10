export const PROJECT_BLOCK_TYPES = [
  'hero',
  'task',
  'solution',
  'split',
  'materials',
  'process',
  'gallery',
  'beforeAfter',
  'video',
  'quote',
  'result',
  'cost',
  'specs',
  'faq',
  'links',
  'related',
  'cta',
] as const;

export type ProjectBlockType = (typeof PROJECT_BLOCK_TYPES)[number];
