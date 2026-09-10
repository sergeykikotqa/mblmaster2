import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type ConsoleMessage } from '@playwright/test';

type RouteAudit = {
  route: string;
  overflowPx: number;
  offscreenCount: number;
  tinyTapTargets: number;
  consoleErrors: string[];
  overflowNodes?: Array<{
    selector: string;
    left: number;
    right: number;
    width: number;
  }>;
};

const DIST_DIR = path.join(process.cwd(), 'dist');
const OUTPUT_DIR = path.join(process.cwd(), '.tmp', 'mobile-audit');

function collectRoutesFromDist(): string[] {
  const routes = new Set<string>(['/']);

  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }

      if (entry.isFile() && entry.name === 'index.html') {
        const relDir = path.relative(DIST_DIR, path.dirname(absolute)).replace(/\\/g, '/');
        if (!relDir || relDir === '.') continue;
        const route = `/${relDir}`;
        if (route.startsWith('/admin') || route.startsWith('/decapcms')) continue;
        routes.add(route);
      }
    }
  };

  if (fs.existsSync(DIST_DIR)) {
    walk(DIST_DIR);
  }

  return [...routes].sort((a, b) => a.localeCompare(b));
}

function toScreenName(route: string): string {
  if (route === '/') return 'home';
  return route.replace(/^\//, '').replace(/[\\/]/g, '__');
}

test.describe('mobile adaptation audit', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('all built pages fit mobile viewport and stay usable', async ({ page }) => {
    test.setTimeout(8 * 60 * 1000);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const routes = collectRoutesFromDist();
    const audits: RouteAudit[] = [];

    for (const route of routes) {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const onConsole = (msg: ConsoleMessage) => {
        if (msg.type() !== 'error') return;
        const text = String(msg.text() || '');
        // Ignore generic failed-resource logs; resource checks are too noisy for mobile layout audit.
        if (text.includes('Failed to load resource')) return;
        // Ignore CSP inline-script warnings (JSON-LD and dev-time inline snippets are expected).
        if (text.includes('Content Security Policy')) return;
        // Ignore Astro dev toolbar audit noise when present.
        if (text.includes("audit's match function")) return;
        consoleErrors.push(text);
      };
      const onPageError = (error: Error) => {
        pageErrors.push(error.message);
      };

      page.on('console', onConsole);
      page.on('pageerror', onPageError);
      await page.goto(route, { waitUntil: 'networkidle' });
      await page.waitForTimeout(200);

      const metrics = await page.evaluate(() => {
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const doc = document.documentElement;
        const body = document.body;
        const scrollWidth = Math.max(doc?.scrollWidth || 0, body?.scrollWidth || 0);
        const overflowPx = Math.max(0, scrollWidth - viewportWidth);

        const visible = (el: Element): boolean => {
          if (el.closest('[aria-hidden="true"]')) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0)
            return false;
          const rect = (el as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        let offscreenCount = 0;
        for (const el of Array.from(document.querySelectorAll('body *'))) {
          if (!visible(el)) continue;
          const style = window.getComputedStyle(el);
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width < 12 || rect.height < 12) continue;
          if (rect.bottom <= 0 || rect.top >= viewportHeight) continue;
          if ((style.position === 'absolute' || style.position === 'fixed') && rect.left < -1000) continue;
          if (rect.right > viewportWidth + 1 || rect.left < -1) {
            offscreenCount += 1;
          }
        }

        const tapSelectors = 'a, button, input[type="button"], input[type="submit"], summary, [role="button"]';
        let tinyTapTargets = 0;
        for (const el of Array.from(document.querySelectorAll(tapSelectors))) {
          if (!visible(el)) continue;
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width < 40 || rect.height < 40) {
            tinyTapTargets += 1;
          }
        }

        return { overflowPx, offscreenCount, tinyTapTargets };
      });

      const overflowNodes =
        metrics.overflowPx > 0
          ? await page.evaluate(() => {
              const viewportWidth = window.innerWidth;

              const visible = (el: Element): boolean => {
                if (el.closest('[aria-hidden="true"]')) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0)
                  return false;
                const rect = (el as HTMLElement).getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
              };

              const makeSelector = (el: Element): string => {
                if (el.id) return `#${el.id}`;
                const classes = Array.from(el.classList).filter(Boolean).slice(0, 3);
                const classPart = classes.length ? `.${classes.join('.')}` : '';
                return `${el.tagName.toLowerCase()}${classPart}`;
              };

              return Array.from(document.querySelectorAll('body *'))
                .filter((el) => visible(el))
                .map((el) => {
                  const rect = (el as HTMLElement).getBoundingClientRect();
                  return {
                    selector: makeSelector(el),
                    left: Math.round(rect.left),
                    right: Math.round(rect.right),
                    width: Math.round(rect.width),
                  };
                })
                .filter((item) => item.right > viewportWidth + 1 || item.left < -1)
                .sort((a, b) => b.right - a.right)
                .slice(0, 12);
            })
          : undefined;

      const screenshotPath = path.join(OUTPUT_DIR, `${toScreenName(route)}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      page.off('console', onConsole);
      page.off('pageerror', onPageError);

      audits.push({
        route,
        overflowPx: metrics.overflowPx,
        offscreenCount: metrics.offscreenCount,
        tinyTapTargets: metrics.tinyTapTargets,
        consoleErrors: [...consoleErrors, ...pageErrors],
        overflowNodes,
      });
    }

    const reportLines: string[] = [
      '# Mobile Adaptation Audit',
      '',
      `Routes checked: ${audits.length}`,
      '',
      '| Route | Overflow px | Offscreen elements | Tiny tap targets | Console errors |',
      '| --- | ---: | ---: | ---: | ---: |',
    ];

    for (const row of audits) {
      reportLines.push(
        `| ${row.route} | ${row.overflowPx} | ${row.offscreenCount} | ${row.tinyTapTargets} | ${row.consoleErrors.length} |`
      );
    }

    fs.writeFileSync(path.join(OUTPUT_DIR, 'report.md'), reportLines.join('\n'), 'utf8');
    fs.writeFileSync(path.join(OUTPUT_DIR, 'report.json'), JSON.stringify(audits, null, 2), 'utf8');

    const overflowIssues = audits.filter((row) => row.overflowPx > 0);
    const severeOffscreenIssues = audits.filter((row) => row.offscreenCount > 40);
    const severeConsoleIssues = audits.filter((row) => row.consoleErrors.length > 0);

    expect(
      {
        overflowIssues: overflowIssues.map((row) => `${row.route}(${row.overflowPx}px)`),
        severeOffscreenIssues: severeOffscreenIssues.map((row) => `${row.route}(${row.offscreenCount})`),
        severeConsoleIssues: severeConsoleIssues.map((row) => row.route),
      },
      'Found mobile adaptation issues. See .tmp/mobile-audit/report.md'
    ).toEqual({
      overflowIssues: [],
      severeOffscreenIssues: [],
      severeConsoleIssues: [],
    });
  });
});
