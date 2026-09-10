import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('project block registry api', () => {
  it('keeps a thin resolve helper next to the declarative registry map', () => {
    const registryPath = path.join(process.cwd(), 'src', 'components', 'projects', 'block-registry.ts');
    const source = fs.readFileSync(registryPath, 'utf8');

    expect(source).toContain('export const PROJECT_BLOCK_REGISTRY = {');
    expect(source).toContain('export const resolveProjectBlockComponent = (type: string) =>');
    expect(source).toContain("?? null");
  });
});
