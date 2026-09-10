import HeroBlock from './blocks/HeroBlock.astro';
import TaskBlock from './blocks/TaskBlock.astro';
import SolutionBlock from './blocks/SolutionBlock.astro';
import SplitBlock from './blocks/SplitBlock.astro';
import MaterialsBlock from './blocks/MaterialsBlock.astro';
import ProcessBlock from './blocks/ProcessBlock.astro';
import GalleryBlock from './blocks/GalleryBlock.astro';
import BeforeAfterBlock from './blocks/BeforeAfterBlock.astro';
import VideoBlock from './blocks/VideoBlock.astro';
import QuoteBlock from './blocks/QuoteBlock.astro';
import ResultBlock from './blocks/ResultBlock.astro';
import CostBlock from './blocks/CostBlock.astro';
import SpecsBlock from './blocks/SpecsBlock.astro';
import FaqBlock from './blocks/FaqBlock.astro';
import LinksBlock from './blocks/LinksBlock.astro';
import RelatedBlock from './blocks/RelatedBlock.astro';
import CtaBlock from './blocks/CtaBlock.astro';

export const PROJECT_BLOCK_REGISTRY = {
  hero: HeroBlock,
  task: TaskBlock,
  solution: SolutionBlock,
  split: SplitBlock,
  materials: MaterialsBlock,
  process: ProcessBlock,
  gallery: GalleryBlock,
  beforeAfter: BeforeAfterBlock,
  video: VideoBlock,
  quote: QuoteBlock,
  result: ResultBlock,
  cost: CostBlock,
  specs: SpecsBlock,
  faq: FaqBlock,
  links: LinksBlock,
  related: RelatedBlock,
  cta: CtaBlock,
} as const;

export type ProjectBlockType = keyof typeof PROJECT_BLOCK_REGISTRY;

export const resolveProjectBlockComponent = (type: string) =>
  PROJECT_BLOCK_REGISTRY[type as ProjectBlockType] ?? null;
