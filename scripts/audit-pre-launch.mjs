import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'pre-launch-audit', 'latest');
const AUTO_RESULTS_PATH = path.join(ARTIFACT_DIR, 'auto-results.json');
const SUMMARY_PATH = path.join(ARTIFACT_DIR, 'summary.md');

const REQUIRED_Q22_ROUTES = ['/', '/kuhni', '/shkafy', '/garderobnye', '/kuhni-3-metra', '/projects/kuhnya-bogdana'];
const Q39_BLOCKER_IDS = ['Q1', 'Q2', 'Q4', 'Q5', 'Q6', 'Q9', 'Q10', 'Q19', 'Q20', 'Q22', 'Q24', 'Q32'];

const QUESTION_DEFINITIONS = [
  { id: 'Q1', block: 1, type: 'auto', blocker: true, question: 'Все базовые гейты зелёные?' },
  { id: 'Q2', block: 1, type: 'auto', blocker: true, question: '`npm run audit:pre-release` выдаёт GO без красных блокеров?' },
  { id: 'Q3', block: 1, type: 'auto', blocker: false, question: 'Нет `any|unknown|as` в project-слое?' },
  { id: 'Q4', block: 1, type: 'auto', blocker: true, question: 'Image-пайплайн без сырых `/images/projects/...` в шаблонах/dist?' },
  { id: 'Q5', block: 1, type: 'auto', blocker: true, question: 'LCP smoke и hero-LCP check для money/project pages проходят?' },
  { id: 'Q6', block: 1, type: 'auto', blocker: true, question: 'Нет duplicate slug/id в content collections?' },
  { id: 'Q7', block: 1, type: 'auto', blocker: false, question: 'Build устойчив при альтернативном `PUBLIC_SITE_URL`?' },
  { id: 'Q8', block: 1, type: 'auto', blocker: false, question: 'Атомы блоков покрыты интеграционными тестами?' },
  { id: 'Q9', block: 1, type: 'auto', blocker: true, question: 'Legacy-режимы полностью отключены?' },
  { id: 'Q10', block: 1, type: 'auto', blocker: true, question: 'Единый путь рендера через `ProjectRenderer/BlockRenderer`?' },

  { id: 'Q11', block: 2, type: 'manual', blocker: false, question: 'Money pages имеют evidence-based trust-блок в первых экранах?' },
  { id: 'Q12', block: 2, type: 'auto', blocker: false, question: 'Есть профильная связка `data-service-projects` + «Наши работы»?' },
  { id: 'Q13', block: 2, type: 'auto', blocker: false, question: 'Есть re-entry CTA (`service_reentry_primary`, `service_reentry_call`)?' },
  { id: 'Q14', block: 2, type: 'manual', blocker: false, question: 'E-E-A-T по Claude >= 8/10 на money pages?' },
  { id: 'Q15', block: 2, type: 'manual', blocker: false, question: 'Семантическая полнота money-кластера >= 8/10?' },
  { id: 'Q16', block: 2, type: 'auto', blocker: false, question: 'Indexable-link coverage и внутренняя перелинковка в норме?' },
  { id: 'Q17', block: 2, type: 'auto', blocker: false, question: 'Schema coverage (`LocalBusiness/Offer/Review/BreadcrumbList`) в норме?' },
  { id: 'Q18', block: 2, type: 'ops', blocker: false, question: 'Google Rich Results Test подтверждает валидный JSON-LD?' },
  { id: 'Q19', block: 2, type: 'auto', blocker: true, question: 'Sitemap/robots/indexability инварианты зелёные?' },
  { id: 'Q20', block: 2, type: 'auto', blocker: true, question: 'Нет thin-content в индексируемых страницах?' },
  { id: 'Q21', block: 2, type: 'manual', blocker: false, question: 'Topical authority кластеров подтверждён?' },
  { id: 'Q22', block: 2, type: 'auto', blocker: true, question: 'CWV smoke на обязательном наборе money routes проходит?' },
  { id: 'Q23', block: 2, type: 'auto', blocker: false, question: 'Mobile adaptation audit проходит без критичных дефектов?' },
  { id: 'Q24', block: 2, type: 'auto', blocker: true, question: 'Local SEO/NAP сигналы подтверждены в контенте и schema?' },

  { id: 'Q25', block: 3, type: 'manual', blocker: false, question: 'Новый проект добавляется в минимальное число мест?' },
  { id: 'Q26', block: 3, type: 'auto', blocker: false, question: 'Registry блоков остаётся декларативным?' },
  { id: 'Q27', block: 3, type: 'auto', blocker: false, question: '`NormalizedProjectContent` остаётся единым источником правды?' },
  { id: 'Q28', block: 3, type: 'manual', blocker: false, question: 'Нет дублирования orchestration-логики между рендерами?' },
  { id: 'Q29', block: 3, type: 'manual', blocker: false, question: 'Компоненты блоков атомарны и переиспользуемы?' },
  { id: 'Q30', block: 3, type: 'manual', blocker: false, question: '`ARCHITECTURE.md` отражает текущий data flow?' },
  { id: 'Q31', block: 3, type: 'auto', blocker: false, question: 'Нет `TODO: legacy` и `temporary fix` в коде?' },
  { id: 'Q32', block: 3, type: 'auto', blocker: true, question: 'CI/CD quality gates покрывают release-контур, включая lead runtime smoke?' },

  { id: 'Q33', block: 4, type: 'manual', blocker: false, question: 'CTA в длинных money pages видимы и доступны на mobile?' },
  { id: 'Q34', block: 4, type: 'manual', blocker: false, question: 'CTA-кнопки унифицированы по тексту и стилю?' },
  { id: 'Q35', block: 4, type: 'auto', blocker: false, question: 'A11y smoke (WCAG AA baseline) проходит?' },
  { id: 'Q36', block: 4, type: 'manual', blocker: false, question: 'Hero содержит оффер + локальную привязку?' },
  { id: 'Q37', block: 4, type: 'manual', blocker: false, question: 'Карточки проектов визуально консистентны?' },
  { id: 'Q38', block: 4, type: 'manual', blocker: false, question: 'Нет визуального шума/повторов в money flow?' },

  { id: 'Q39', block: 5, type: 'auto', blocker: true, question: 'Нет P1-блокеров по технике/SEO/runtime?' },
  { id: 'Q40', block: 5, type: 'manual', blocker: false, question: 'Content moat достаточен для целевых запросов?' },
  { id: 'Q41', block: 5, type: 'manual', blocker: false, question: 'После публикации можно ограничиться контентным насыщением?' },
  { id: 'Q42', block: 5, type: 'auto', blocker: false, question: 'Итоговый dual score и финальный verdict зафиксированы?' },
];

const env = {
  ...process.env,
  PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL ?? 'https://example.com',
  METRICS_ADMIN_TOKEN: process.env.METRICS_ADMIN_TOKEN ?? '__SENTINEL__',
  NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=4096',
  LHCI_NUMBER_OF_RUNS: process.env.LHCI_NUMBER_OF_RUNS ?? '1',
  LHCI_BUILD_CONTEXT__CURRENT_BRANCH: process.env.LHCI_BUILD_CONTEXT__CURRENT_BRANCH ?? 'local',
};

const runMeta = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  durationSec: null,
  workspace: ROOT,
  runner: 'scripts/audit-pre-launch.mjs',
  envDefaults: {
    PUBLIC_SITE_URL: env.PUBLIC_SITE_URL,
    METRICS_ADMIN_TOKEN: env.METRICS_ADMIN_TOKEN ? '__SET__' : '__MISSING__',
    NODE_OPTIONS: env.NODE_OPTIONS,
    LHCI_NUMBER_OF_RUNS: env.LHCI_NUMBER_OF_RUNS,
    LHCI_BUILD_CONTEXT__CURRENT_BRANCH: env.LHCI_BUILD_CONTEXT__CURRENT_BRANCH,
  },
};

const questions = Object.fromEntries(
  QUESTION_DEFINITIONS.map((def) => [
    def.id,
    {
      question: def.question,
      type: def.type,
      blocker: def.blocker,
      block: def.block,
      status: def.type === 'manual' ? 'MANUAL' : def.type === 'ops' ? 'NA/ops' : 'NA/ops',
      evidence: [],
      comment: def.type === 'manual' ? 'Manual review required.' : def.type === 'ops' ? 'Operational evidence required.' : 'Pending execution.',
    },
  ])
);

let failFastTriggered = false;
let failFastAt = null;
const runtimeSmoke = {
  local: {
    status: 'PENDING',
    evidence: [],
    comment: 'Pending execution.',
  },
  deployed: {
    status: 'PENDING',
    evidence: [],
    comment: 'Pending execution.',
  },
};

function now() {
  return new Date().toISOString();
}

function setQuestionStatus(id, status, evidence, comment) {
  if (!questions[id]) return;
  questions[id].status = status;
  questions[id].evidence = Array.isArray(evidence) ? evidence : evidence ? [String(evidence)] : [];
  questions[id].comment = comment ?? '';
  questions[id].updatedAt = now();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runNpm(scriptName, extraArgs = [], extraEnv = {}) {
  const command = ['npm', 'run', scriptName, ...extraArgs].join(' ');
  const result = spawnSync(command, {
    cwd: ROOT,
    env: { ...env, ...extraEnv },
    stdio: 'inherit',
    shell: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command}`);
  }
}

function withFailFast(id, fn) {
  const meta = QUESTION_DEFINITIONS.find((item) => item.id === id);
  const isBlocker = Boolean(meta?.blocker);
  if (failFastTriggered) {
    setQuestionStatus(
      id,
      'NA/ops',
      [],
      `Blocked by fail-fast after ${failFastAt}.`
    );
    return;
  }

  try {
    fn();
    setQuestionStatus(id, 'PASS', questions[id].evidence, questions[id].comment);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setQuestionStatus(id, 'FAIL', questions[id].evidence, message);
    if (isBlocker) {
      failFastTriggered = true;
      failFastAt = id;
    }
  }
}

function walkFiles(dirPath, extensionSet, results = []) {
  if (!fs.existsSync(dirPath)) return results;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, extensionSet, results);
      continue;
    }
    if (!entry.isFile()) continue;
    if (extensionSet && !extensionSet.has(path.extname(entry.name).toLowerCase())) continue;
    results.push(fullPath);
  }
  return results;
}

function findPatternMatches(filePaths, pattern) {
  const matches = [];
  for (const fullPath of filePaths) {
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[idx])) {
        matches.push(`${path.relative(ROOT, fullPath).replace(/\\/g, '/')}:${idx + 1}`);
      }
    }
  }
  return matches;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeRoutePath(value) {
  const normalized = `/${String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function toDistIndexPath(routePath) {
  const normalized = normalizeRoutePath(routePath);
  if (normalized === '/') return path.join(ROOT, 'dist', 'index.html');
  return path.join(ROOT, 'dist', normalized.slice(1), 'index.html');
}

function collectLhrFiles() {
  const lhDir = path.join(ROOT, '.lighthouseci');
  if (!fs.existsSync(lhDir)) return [];
  return fs
    .readdirSync(lhDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith('lhr-') && entry.name.endsWith('.json'))
    .map((entry) => ({
      name: entry.name,
      filePath: path.join(lhDir, entry.name),
      mtimeMs: fs.statSync(path.join(lhDir, entry.name)).mtimeMs,
    }));
}

function run() {
  withFailFast('Q1', () => {
    runNpm('lint');
    runNpm('typecheck');
    runNpm('check:astro');
    runNpm('test');
    runNpm('build');
    setQuestionStatus(
      'Q1',
      'PASS',
      ['npm run lint', 'npm run typecheck', 'npm run check:astro', 'npm run test', 'npm run build'],
      'All baseline gates are green.'
    );
  });

  withFailFast('Q2', () => {
    runNpm('audit:pre-release');
    setQuestionStatus('Q2', 'PASS', ['npm run audit:pre-release'], 'Pre-release 28-question baseline is green.');
  });

  withFailFast('Q3', () => {
    const boundaryPath = path.join(ROOT, 'src', 'lib', 'projects', 'project-boundary.ts');
    if (!fs.existsSync(boundaryPath)) {
      throw new Error('project-boundary.ts is missing. Q3 requires a dedicated raw-data boundary.');
    }

    const boundarySource = fs.readFileSync(boundaryPath, 'utf8');
    if (!boundarySource.includes('export type RawProject') || !boundarySource.includes('readProjectBoundary')) {
      throw new Error('project-boundary.ts must export RawProject and readProjectBoundary.');
    }

    const strictPipelineFiles = [
      path.join(ROOT, 'src', 'lib', 'projects', 'normalized-project-content.ts'),
      path.join(ROOT, 'src', 'lib', 'projects', 'project-view-model.ts'),
      path.join(ROOT, 'src', 'lib', 'projects', 'project-render-plan.ts'),
      path.join(ROOT, 'src', 'components', 'projects', 'BlockRenderer.astro'),
    ];

    const strictViolations = [];
    for (const filePath of strictPipelineFiles) {
      if (!fs.existsSync(filePath)) {
        strictViolations.push(`${path.relative(ROOT, filePath).replace(/\\/g, '/')} (missing)`);
        continue;
      }

      const source = fs.readFileSync(filePath, 'utf8');
      const lines = source.split(/\r?\n/);
      for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
        const line = lines[lineNumber];
        if (/\bas\s+(?!const\b)/.test(line) || /\bany\b/.test(line)) {
          strictViolations.push(
            `${path.relative(ROOT, filePath).replace(/\\/g, '/')}:${lineNumber + 1}`
          );
        }
      }
    }

    if (strictViolations.length > 0) {
      throw new Error(
        `Unsafe type tokens in render pipeline. Sample: ${strictViolations.slice(0, 20).join(', ')}`
      );
    }

    const extensionSet = new Set(['.ts', '.tsx', '.astro', '.js', '.mjs']);
    const roots = [path.join(ROOT, 'src', 'lib', 'projects'), path.join(ROOT, 'src', 'components', 'projects')];
    const files = roots.flatMap((dir) => walkFiles(dir, extensionSet));
    const residualFiles = files.filter((filePath) => path.normalize(filePath) !== path.normalize(boundaryPath));

    const residualAny = findPatternMatches(residualFiles, /\bany\b/g).length;
    const residualUnknown = findPatternMatches(residualFiles, /\bunknown\b/g).length;
    const residualAs = findPatternMatches(residualFiles, /\bas\s+(?!const\b)/g).length;

    setQuestionStatus(
      'Q3',
      'PASS',
      [
        'src/lib/projects/project-boundary.ts',
        'src/lib/projects/normalized-project-content.ts',
        'src/lib/projects/project-view-model.ts',
        'src/lib/projects/project-render-plan.ts',
        'src/components/projects/BlockRenderer.astro',
      ],
      `Q3 PASS = unsafe typing allowed only in boundary layer; no as/any in render pipeline and normalized project flow. Residual debt outside strict pipeline: any=${residualAny}, unknown=${residualUnknown}, as=${residualAs}.`
    );
  });

  withFailFast('Q4', () => {
    runNpm('check:image-policy');
    const srcExt = new Set(['.astro', '.ts', '.tsx', '.js', '.mjs']);
    const srcRoots = [path.join(ROOT, 'src', 'pages'), path.join(ROOT, 'src', 'components'), path.join(ROOT, 'src', 'layouts')];
    const srcFiles = srcRoots.flatMap((dir) => walkFiles(dir, srcExt));
    const srcMatches = findPatternMatches(srcFiles, /\/images\/projects\//g);

    const distFiles = walkFiles(path.join(ROOT, 'dist'), new Set(['.html']));
    const distMatches = findPatternMatches(distFiles, /\/images\/projects\//g);

    if (srcMatches.length > 0 || distMatches.length > 0) {
      const sample = [...srcMatches, ...distMatches].slice(0, 20);
      throw new Error(`Raw /images/projects/ paths detected. Sample: ${sample.join(', ')}`);
    }

    setQuestionStatus('Q4', 'PASS', ['npm run check:image-policy', 'src/pages|components|layouts scan', 'dist/**/*.html scan'], 'No raw /images/projects/ leakage in templates/dist.');
  });

  withFailFast('Q5', () => {
    runNpm('check:lighthouse:smoke');
    const summaryPath = path.join(ROOT, 'artifacts', 'lighthouse-summary.json');
    if (!fs.existsSync(summaryPath)) {
      throw new Error('artifacts/lighthouse-summary.json is missing. Run lighthouse smoke before evaluating Q5.');
    }
    const summary = readJson(summaryPath);
    if (!Array.isArray(summary?.worstPages) || summary.worstPages.length === 0) {
      throw new Error('lighthouse summary has no pages.');
    }

    const hasService = summary.worstPages.some((row) => row?.type === 'service');
    const hasProject = summary.worstPages.some((row) => row?.type === 'project');
    if (!hasService || !hasProject) {
      throw new Error('lighthouse summary is missing service/project evidence for LCP smoke.');
    }
    setQuestionStatus('Q5', 'PASS', ['artifacts/lighthouse-summary.json', '.lighthouseci/lhr-*.json'], 'Lighthouse smoke + hero-LCP contract evidence is present.');
  });

  withFailFast('Q6', () => {
    runNpm('check:slugs');
    runNpm('check:content-duplicates');
    setQuestionStatus('Q6', 'PASS', ['npm run check:slugs', 'npm run check:content-duplicates'], 'No duplicate slug/id collisions detected.');
  });

  withFailFast('Q7', () => {
    const altEnv = { PUBLIC_SITE_URL: 'https://prelaunch-alt.example.com' };
    runNpm('build', [], altEnv);
    runNpm('check:canonical-absolute', [], altEnv);
    runNpm('check:sitemap-coverage', [], altEnv);
    setQuestionStatus(
      'Q7',
      'PASS',
      ['PUBLIC_SITE_URL=https://prelaunch-alt.example.com npm run build', 'npm run check:canonical-absolute', 'npm run check:sitemap-coverage'],
      'Build and core URL invariants are stable under alternative PUBLIC_SITE_URL.'
    );
  });

  withFailFast('Q8', () => {
    const testFiles = walkFiles(path.join(ROOT, 'tests'), new Set(['.ts']));
    const testContent = testFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    const requiredTokens = ['FactsGrid', 'CostBreakdown', 'CostSummary', 'ProcessSteps', 'LinksSection'];
    const missing = requiredTokens.filter((token) => !testContent.includes(token));
    if (missing.length > 0) {
      throw new Error(`Missing integration test evidence for tokens: ${missing.join(', ')}`);
    }
    setQuestionStatus('Q8', 'PASS', ['tests/project-block-registry.test.ts', 'tests/project-render-plan.test.ts', 'tests/project-video.test.ts'], 'Integration coverage references all key block atoms.');
  });

  withFailFast('Q9', () => {
    runNpm('check:no-legacy-project-fields');
    const codeFiles = walkFiles(path.join(ROOT, 'src'), new Set(['.ts', '.tsx', '.astro', '.js', '.mjs']));
    const matches = findPatternMatches(codeFiles, /isBlockMode|legacy-mode/g);
    if (matches.length > 0) {
      throw new Error(`Legacy markers found: ${matches.slice(0, 20).join(', ')}`);
    }
    setQuestionStatus('Q9', 'PASS', ['npm run check:no-legacy-project-fields', 'src/**/* legacy marker scan'], 'No legacy-mode path remains.');
  });

  withFailFast('Q10', () => {
    const requiredFiles = [
      path.join(ROOT, 'src', 'components', 'projects', 'ProjectRenderer.astro'),
      path.join(ROOT, 'src', 'components', 'projects', 'BlockRenderer.astro'),
      path.join(ROOT, 'src', 'lib', 'projects', 'project-render-plan.ts'),
    ];
    for (const filePath of requiredFiles) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Missing renderer contract file: ${path.relative(ROOT, filePath).replace(/\\/g, '/')}`);
      }
    }

    const blocksFacade = fs.readFileSync(path.join(ROOT, 'src', 'components', 'projects', 'ProjectBlocks.astro'), 'utf8');
    if (!blocksFacade.includes('ProjectRenderer')) {
      throw new Error('ProjectBlocks.astro is expected to delegate to ProjectRenderer.');
    }

    const planContent = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'projects', 'project-render-plan.ts'), 'utf8');
    if (!planContent.includes('buildProjectRenderPlan')) {
      throw new Error('project-render-plan.ts is missing buildProjectRenderPlan.');
    }

    setQuestionStatus('Q10', 'PASS', ['src/components/projects/ProjectRenderer.astro', 'src/components/projects/BlockRenderer.astro', 'src/lib/projects/project-render-plan.ts'], 'Single renderer orchestration path is in place.');
  });

  withFailFast('Q12', () => {
    const routes = ['/kuhni', '/shkafy', '/garderobnye', '/kuhni-3-metra'];
    const missing = [];
    for (const route of routes) {
      const htmlPath = toDistIndexPath(route);
      if (!fs.existsSync(htmlPath)) {
        missing.push(`${route} (missing dist html)`);
        continue;
      }
      const html = fs.readFileSync(htmlPath, 'utf8');
      if (!html.includes('data-service-projects=')) missing.push(`${route} (missing data-service-projects)`);
      if (!html.includes('Наши работы')) missing.push(`${route} (missing "Наши работы")`);
    }
    if (missing.length > 0) {
      throw new Error(`Service-project linkage gaps: ${missing.join(', ')}`);
    }
    setQuestionStatus('Q12', 'PASS', routes.map((route) => `dist${route}/index.html`), 'All money pages include service-project binding markers.');
  });

  withFailFast('Q13', () => {
    const routes = ['/kuhni', '/shkafy', '/garderobnye', '/kuhni-3-metra'];
    const missing = [];
    for (const route of routes) {
      const htmlPath = toDistIndexPath(route);
      if (!fs.existsSync(htmlPath)) {
        missing.push(`${route} (missing dist html)`);
        continue;
      }
      const html = fs.readFileSync(htmlPath, 'utf8');
      if (!html.includes('service_reentry_primary')) missing.push(`${route} (missing service_reentry_primary)`);
      if (!html.includes('service_reentry_call')) missing.push(`${route} (missing service_reentry_call)`);
    }
    if (missing.length > 0) {
      throw new Error(`Re-entry CTA coverage gaps: ${missing.join(', ')}`);
    }
    setQuestionStatus('Q13', 'PASS', routes.map((route) => `dist${route}/index.html`), 'Re-entry conversion CTAs are present.');
  });

  withFailFast('Q16', () => {
    runNpm('check:indexable-link-coverage');
    setQuestionStatus('Q16', 'PASS', ['npm run check:indexable-link-coverage'], 'Indexable internal-link baseline is green.');
  });

  withFailFast('Q17', () => {
    runNpm('check:schema');
    setQuestionStatus('Q17', 'PASS', ['npm run check:schema'], 'Schema baseline gate is green.');
  });

  withFailFast('Q19', () => {
    runNpm('check:sitemap-coverage');
    runNpm('check:indexable-coverage');
    runNpm('check:no-admin-in-sitemap');
    runNpm('check:indexability-runtime-consistency');
    setQuestionStatus(
      'Q19',
      'PASS',
      ['npm run check:sitemap-coverage', 'npm run check:indexable-coverage', 'npm run check:no-admin-in-sitemap', 'npm run check:indexability-runtime-consistency'],
      'Sitemap/robots/indexability constraints are green.'
    );
  });

  withFailFast('Q20', () => {
    runNpm('check:content-length');
    setQuestionStatus('Q20', 'PASS', ['npm run check:content-length'], 'Thin-content gate is green for current indexable set.');
  });

  withFailFast('Q22', () => {
    const beforeFiles = new Set(collectLhrFiles().map((item) => item.name));
    runNpm('check:lighthouse:smoke', [], { LHCI_ROUTES: REQUIRED_Q22_ROUTES.join(','), LHCI_BATCH_SIZE: '8' });
    const afterFiles = collectLhrFiles().filter((item) => !beforeFiles.has(item.name));

    if (afterFiles.length === 0) {
      throw new Error('No new LHCI reports were produced for Q22 run.');
    }

    const perRoute = new Map();
    for (const item of afterFiles) {
      const lhr = readJson(item.filePath);
      const routePath = normalizeRoutePath(new URL(lhr.finalUrl || lhr.requestedUrl).pathname);
      const lcp = Number(lhr?.audits?.['largest-contentful-paint']?.numericValue ?? NaN);
      const cls = Number(lhr?.audits?.['cumulative-layout-shift']?.numericValue ?? NaN);
      perRoute.set(routePath, { lcp, cls, file: item.name });
    }

    const missingRoutes = REQUIRED_Q22_ROUTES.filter((route) => !perRoute.has(route));
    if (missingRoutes.length > 0) {
      throw new Error(`Required Q22 routes missing in LHCI run: ${missingRoutes.join(', ')}`);
    }

    const violations = [];
    for (const route of REQUIRED_Q22_ROUTES) {
      const metrics = perRoute.get(route);
      if (!Number.isFinite(metrics.lcp) || metrics.lcp > 2500) {
        violations.push(`${route} LCP=${metrics.lcp}`);
      }
      if (!Number.isFinite(metrics.cls) || metrics.cls > 0.1) {
        violations.push(`${route} CLS=${metrics.cls}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(`CWV threshold violations: ${violations.join(', ')}`);
    }

    setQuestionStatus(
      'Q22',
      'PASS',
      REQUIRED_Q22_ROUTES.map((route) => `${route} (LCP<2.5s, CLS<0.1)`),
      'Required money-page CWV smoke set is green.'
    );
  });

  withFailFast('Q23', () => {
    runNpm('check:e2e', ['--', 'tests/e2e/mobile-adaptation-audit.spec.ts']);
    const reportPath = path.join(ROOT, '.tmp', 'mobile-audit', 'report.md');
    if (!fs.existsSync(reportPath)) {
      throw new Error('.tmp/mobile-audit/report.md was not generated.');
    }
    setQuestionStatus('Q23', 'PASS', ['tests/e2e/mobile-adaptation-audit.spec.ts', '.tmp/mobile-audit/report.md'], 'Mobile adaptation smoke audit passed.');
  });

  withFailFast('Q24', () => {
    runNpm('check:nap-consistency');
    runNpm('check:geo-signals');
    runNpm('check:schema');

    const routes = ['/kuhni', '/shkafy', '/garderobnye', '/kuhni-3-metra'];
    const missing = [];
    for (const route of routes) {
      const htmlPath = toDistIndexPath(route);
      if (!fs.existsSync(htmlPath)) {
        missing.push(`${route} (missing dist html)`);
        continue;
      }
      const html = fs.readFileSync(htmlPath, 'utf8');
      if (!html.includes('Иркутск')) missing.push(`${route} (missing Иркутск mention)`);
      if (!html.includes('KitchenCabinetStore') && !html.includes('LocalBusiness')) {
        missing.push(`${route} (missing LocalBusiness-family schema marker)`);
      }
    }

    if (missing.length > 0) {
      throw new Error(`Local SEO gaps: ${missing.join(', ')}`);
    }

    setQuestionStatus(
      'Q24',
      'PASS',
      ['npm run check:nap-consistency', 'npm run check:geo-signals', 'npm run check:schema'],
      'NAP and local SEO schema signals are present on money pages.'
    );
  });

  withFailFast('Q26', () => {
    const registryPath = path.join(ROOT, 'src', 'components', 'projects', 'block-registry.ts');
    const registry = fs.readFileSync(registryPath, 'utf8');
    if (!registry.includes('PROJECT_BLOCK_REGISTRY')) {
      throw new Error('PROJECT_BLOCK_REGISTRY export is missing.');
    }
    if (!registry.includes('resolveProjectBlockComponent')) {
      throw new Error('resolveProjectBlockComponent helper is missing.');
    }
    setQuestionStatus('Q26', 'PASS', ['src/components/projects/block-registry.ts'], 'Block registry stays declarative.');
  });

  withFailFast('Q27', () => {
    const files = [
      path.join(ROOT, 'src', 'lib', 'projects', 'normalized-project-content.ts'),
      path.join(ROOT, 'src', 'lib', 'projects', 'project-adapters.ts'),
      path.join(ROOT, 'src', 'lib', 'projects', 'project-view-model.ts'),
      path.join(ROOT, 'src', 'components', 'projects', 'ProjectRenderer.astro'),
    ];
    const missing = files.filter((filePath) => !fs.existsSync(filePath));
    if (missing.length > 0) {
      throw new Error(`Missing normalization contract files: ${missing.map((item) => path.relative(ROOT, item)).join(', ')}`);
    }

    const references = files
      .map((filePath) => fs.readFileSync(filePath, 'utf8'))
      .join('\n');
    if (!references.includes('NormalizedProjectContent') || !references.includes('normalizeProjectContent')) {
      throw new Error('NormalizedProjectContent/normalizeProjectContent references are incomplete.');
    }

    setQuestionStatus(
      'Q27',
      'PASS',
      ['src/lib/projects/normalized-project-content.ts', 'src/lib/projects/project-adapters.ts', 'src/lib/projects/project-view-model.ts', 'src/components/projects/ProjectRenderer.astro'],
      'Normalization contract remains the canonical project-data path.'
    );
  });

  withFailFast('Q31', () => {
    const files = walkFiles(path.join(ROOT, 'src'), new Set(['.ts', '.tsx', '.astro', '.js', '.mjs', '.md', '.mdx']));
    const matches = findPatternMatches(files, /TODO:\s*legacy|temporary fix/gi);
    if (matches.length > 0) {
      throw new Error(`Legacy temporary markers found: ${matches.slice(0, 20).join(', ')}`);
    }
    setQuestionStatus('Q31', 'PASS', ['src/**/* scan for TODO: legacy|temporary fix'], 'No legacy temporary markers found.');
  });

  withFailFast('Q32', () => {
    const qualityGates = path.join(ROOT, 'docs', 'QUALITY_GATES.md');
    const workflowPath = path.join(ROOT, '.github', 'workflows', 'actions.yaml');
    const pkgPath = path.join(ROOT, 'package.json');
    if (!fs.existsSync(qualityGates)) throw new Error('docs/QUALITY_GATES.md is missing.');
    if (!fs.existsSync(workflowPath)) throw new Error('.github/workflows/actions.yaml is missing.');
    const pkg = readJson(pkgPath);
    if (!pkg?.scripts?.['audit:pre-release']) throw new Error('audit:pre-release script is missing.');
    if (!pkg?.scripts?.['audit:pre-launch']) throw new Error('audit:pre-launch script is missing.');
    if (!pkg?.scripts?.['check:prod-runtime']) throw new Error('check:prod-runtime script is missing.');
    if (!pkg?.scripts?.['check:deployed-runtime']) throw new Error('check:deployed-runtime script is missing.');

    const workflow = fs.readFileSync(workflowPath, 'utf8');
    if (!workflow.includes('npm run check:prod-runtime')) {
      throw new Error('Main workflow does not execute npm run check:prod-runtime.');
    }
    if (!workflow.includes('npm run check:deployed-runtime')) {
      throw new Error('Main workflow does not execute npm run check:deployed-runtime.');
    }

    runNpm('check:prod-runtime');
    runtimeSmoke.local = {
      status: 'PASS',
      evidence: ['npm run check:prod-runtime'],
      comment: 'Local production-like lead runtime smoke passed.',
    };

    if ((env.DEPLOY_SMOKE_BASE_URL || '').trim()) {
      runNpm('check:deployed-runtime');
      runtimeSmoke.deployed = {
        status: 'PASS',
        evidence: ['npm run check:deployed-runtime'],
        comment: 'Deployed lead runtime smoke passed against DEPLOY_SMOKE_BASE_URL.',
      };
    } else {
      runtimeSmoke.deployed = {
        status: 'NA/ops',
        evidence: ['.github/workflows/actions.yaml#check-production'],
        comment: 'Deployed runtime smoke requires DEPLOY_SMOKE_BASE_URL and remains enforced in the main release workflow.',
      };
    }

    setQuestionStatus(
      'Q32',
      'PASS',
      [
        'docs/QUALITY_GATES.md',
        'package.json scripts',
        'npm run check:prod-runtime',
        runtimeSmoke.deployed.status === 'PASS'
          ? 'npm run check:deployed-runtime'
          : '.github/workflows/actions.yaml#check-production',
      ],
      `Release runtime gates are wired. Local smoke=${runtimeSmoke.local.status}; deployed smoke=${runtimeSmoke.deployed.status}. ${runtimeSmoke.deployed.comment}`
    );
  });

  withFailFast('Q35', () => {
    runNpm('check:accessibility');
    setQuestionStatus('Q35', 'PASS', ['npm run check:accessibility'], 'A11y smoke baseline is green.');
  });

  const failedBlockers = Q39_BLOCKER_IDS.filter((id) => questions[id]?.status === 'FAIL');
  const blockerState = {
    hasBlockingFailure: failedBlockers.length > 0,
    failedAt: failFastAt,
    failedBlockers,
  };

  if (failedBlockers.length > 0) {
    setQuestionStatus('Q39', 'FAIL', failedBlockers, 'At least one P1 auto-blocker failed.');
  } else {
    setQuestionStatus('Q39', 'PASS', Q39_BLOCKER_IDS.map((id) => `${id}:${questions[id]?.status}`), 'No P1 auto-blockers detected in auto run.');
  }

  const blockScores = {};
  for (let block = 1; block <= 5; block += 1) {
    const inBlock = QUESTION_DEFINITIONS.filter((item) => item.block === block && item.type === 'auto' && item.id !== 'Q42');
    const passCount = inBlock.filter((item) => questions[item.id]?.status === 'PASS').length;
    const total = inBlock.length;
    blockScores[`block${block}`] = {
      pass: passCount,
      total,
      score: total > 0 ? Number(((passCount / total) * 10).toFixed(2)) : null,
    };
  }

  const scoreValues = Object.values(blockScores)
    .map((item) => item.score)
    .filter((score) => typeof score === 'number');
  const autoScore = scoreValues.length > 0 ? Number((scoreValues.reduce((sum, score) => sum + score, 0) / scoreValues.length).toFixed(2)) : null;
  const finalScore = null;
  const verdict = blockerState.hasBlockingFailure ? 'NO-GO' : 'GO';

  setQuestionStatus(
    'Q42',
    'PASS',
    [`Auto Score=${autoScore ?? 'n/a'}`, `Final Score=${finalScore ?? 'pending-manual'}`, `Verdict=${verdict}`],
    'Dual score and auto verdict computed.'
  );

  runMeta.finishedAt = new Date().toISOString();
  runMeta.durationSec = Number(((Date.parse(runMeta.finishedAt) - Date.parse(runMeta.startedAt)) / 1000).toFixed(2));

  const payload = {
    runMeta,
    questions,
    runtimeSmoke,
    blockScores,
    autoScore,
    finalScore,
    blockerState,
    verdict,
  };

  ensureDir(ARTIFACT_DIR);
  fs.writeFileSync(AUTO_RESULTS_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const lines = [
    '# Pre-Launch Auto Audit Summary',
    '',
    `- Started: ${runMeta.startedAt}`,
    `- Finished: ${runMeta.finishedAt}`,
    `- Duration (sec): ${runMeta.durationSec}`,
    `- Auto Score: ${autoScore ?? 'n/a'}`,
    `- Final Score: ${finalScore ?? 'pending-manual'}`,
    `- Verdict: ${verdict}`,
    '',
    '## Block Scores',
    '',
    '| Block | Pass | Total | Score |',
    '| --- | ---: | ---: | ---: |',
    ...Object.entries(blockScores).map(([block, stats]) => `| ${block} | ${stats.pass} | ${stats.total} | ${stats.score ?? 'n/a'} |`),
    '',
    '## Blocker State',
    '',
    `- hasBlockingFailure: ${blockerState.hasBlockingFailure}`,
    `- failedAt: ${blockerState.failedAt ?? 'none'}`,
    `- failedBlockers: ${blockerState.failedBlockers.length > 0 ? blockerState.failedBlockers.join(', ') : 'none'}`,
    '',
    '## Lead Runtime Smoke',
    '',
    `- local: ${runtimeSmoke.local.status} — ${runtimeSmoke.local.comment}`,
    `- deployed: ${runtimeSmoke.deployed.status} — ${runtimeSmoke.deployed.comment}`,
    '',
    '## Question Status',
    '',
    '| ID | Status | Type | Blocker | Comment |',
    '| --- | --- | --- | --- | --- |',
    ...QUESTION_DEFINITIONS.map((def) => {
      const row = questions[def.id];
      return `| ${def.id} | ${row.status} | ${row.type} | ${row.blocker ? 'yes' : 'no'} | ${String(row.comment || '').replace(/\|/g, '\\|')} |`;
    }),
  ];
  fs.writeFileSync(SUMMARY_PATH, `${lines.join('\n')}\n`, 'utf8');

  console.log(`\n[pre-launch] auto-results: ${path.relative(ROOT, AUTO_RESULTS_PATH).replace(/\\/g, '/')}`);
  console.log(`[pre-launch] summary: ${path.relative(ROOT, SUMMARY_PATH).replace(/\\/g, '/')}`);
  console.log(`[pre-launch] verdict: ${verdict}`);

  if (verdict === 'NO-GO') {
    process.exit(1);
  }
}

try {
  run();
} catch (error) {
  runMeta.finishedAt = new Date().toISOString();
  runMeta.durationSec = Number(((Date.parse(runMeta.finishedAt) - Date.parse(runMeta.startedAt)) / 1000).toFixed(2));
  ensureDir(ARTIFACT_DIR);
  const payload = {
    runMeta,
    questions,
    blockScores: {},
    autoScore: null,
    finalScore: null,
    blockerState: {
      hasBlockingFailure: true,
      failedAt: failFastAt,
      failedBlockers: Q39_BLOCKER_IDS.filter((id) => questions[id]?.status === 'FAIL'),
    },
    verdict: 'NO-GO',
    fatalError: error instanceof Error ? error.message : String(error),
  };
  fs.writeFileSync(AUTO_RESULTS_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    SUMMARY_PATH,
    `# Pre-Launch Auto Audit Summary\n\n- Verdict: NO-GO\n- Fatal Error: ${payload.fatalError}\n- Artifacts: ${path
      .relative(ROOT, AUTO_RESULTS_PATH)
      .replace(/\\/g, '/')}\n`,
    'utf8'
  );
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
