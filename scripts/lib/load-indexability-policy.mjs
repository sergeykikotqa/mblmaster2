import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const INDEXABILITY_POLICY_PATH = path.join(process.cwd(), 'src', 'config', 'indexability-policy.ts');

let cachedModulePromise;

export async function loadIndexabilityPolicyModule() {
  if (!cachedModulePromise) {
    cachedModulePromise = fs.readFile(INDEXABILITY_POLICY_PATH, 'utf8').then((source) => {
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: INDEXABILITY_POLICY_PATH,
      }).outputText;
      const encoded = Buffer.from(transpiled, 'utf8').toString('base64');
      return import(`data:text/javascript;base64,${encoded}`);
    });
  }

  return cachedModulePromise;
}
