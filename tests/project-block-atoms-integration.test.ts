import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('project block atoms integration', () => {
  it('keeps critical proof/conversion atoms wired into renderer and block components', () => {
    const renderer = readSource('src/components/projects/ProjectRenderer.astro');
    const costBlock = readSource('src/components/projects/blocks/CostBlock.astro');
    const processBlock = readSource('src/components/projects/blocks/ProcessBlock.astro');
    const linksBlock = readSource('src/components/projects/blocks/LinksBlock.astro');

    expect(renderer).toContain("import FactsGrid from '~/components/projects/blocks/atoms/FactsGrid.astro';");
    expect(renderer).toContain('<FactsGrid');

    expect(costBlock).toContain("import CostBreakdown from './atoms/CostBreakdown.astro';");
    expect(costBlock).toContain("import CostSummary from './atoms/CostSummary.astro';");
    expect(costBlock).toContain('<CostSummary');
    expect(costBlock).toContain('<CostBreakdown');

    expect(processBlock).toContain("import ProcessSteps from './atoms/ProcessSteps.astro';");
    expect(processBlock).toContain('<ProcessSteps');

    expect(linksBlock).toContain("import LinksSection from './atoms/LinksSection.astro';");
    expect(linksBlock).toContain('<LinksSection');
  });
});
