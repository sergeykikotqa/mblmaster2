import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const REQUIRED_HIDDEN_FIELDS = ['city', 'district', 'service', 'pageType', 'pageSlug'];

const MONEY_PAGE_FILES = ['src/pages/[service].astro'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readUtf8(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  assert(fs.existsSync(fullPath), `File is missing: ${relativePath}`);
  return fs.readFileSync(fullPath, 'utf8');
}

function checkContactFormHiddenFields() {
  const source = readUtf8('src/components/ContactForm.astro');
  const errors = [];

  for (const field of REQUIRED_HIDDEN_FIELDS) {
    const pattern = new RegExp(`<input\\s+type="hidden"\\s+name="${field}"\\s+value=`, 'i');
    if (!pattern.test(source)) {
      errors.push(`ContactForm is missing hidden input: ${field}`);
    }
  }

  assert(errors.length === 0, `Hidden fields check failed:\n${errors.map((item) => `- ${item}`).join('\n')}`);
}

function checkContactWidgetPropagation() {
  const source = readUtf8('src/components/widgets/Contact.astro');
  const hasResolver = source.includes('resolveLeadContext(');
  const hasInjection = source.includes('leadContext={resolvedLeadContext}');
  assert(hasResolver, 'Contact widget must resolve lead context server-side.');
  assert(hasInjection, 'Contact widget must pass resolved lead context into ContactForm.');
}

function checkMoneyPagesLeadContext() {
  const errors = [];

  for (const filePath of MONEY_PAGE_FILES) {
    const source = readUtf8(filePath);
    const hasExplicitLeadContext =
      source.includes('leadContext={{') ||
      source.includes('leadContext={leadContext}') ||
      source.includes('leadContext={resolvedLeadContext}');
    if (!hasExplicitLeadContext) {
      errors.push(`${filePath} must pass explicit leadContext into contact form`);
    }
  }

  assert(errors.length === 0, `Money page leadContext check failed:\n${errors.map((item) => `- ${item}`).join('\n')}`);
}

function main() {
  checkContactFormHiddenFields();
  checkContactWidgetPropagation();
  checkMoneyPagesLeadContext();
  console.log('Contact hidden fields guard passed: context is propagated to contact forms.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
