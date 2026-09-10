import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const targets = [
  { slug: 'home', url: '/' },
  { slug: 'contacts', url: '/contacts' },
  { slug: 'about', url: '/o-kompanii' },
  { slug: 'city', url: '/irkutsk' },
  { slug: 'service', url: '/kuhni' },
  { slug: 'projects', url: '/projects' },
  { slug: 'article', url: '/articles/kak-vybrat-kuhnyu' },
];

const OUTPUT_DIR = path.join(process.cwd(), '.tmp', 'design-audit');

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1200 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test.describe(`design-audit:${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
    });

    for (const target of targets) {
      test(`capture ${target.slug}`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
        await page.goto(target.url, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('load').catch(() => {});

        // Stabilize layout for deterministic screenshots.
        await page.addStyleTag({
          content: `
            * {
              animation-duration: 0s !important;
              animation-delay: 0s !important;
              transition-duration: 0s !important;
              transition-delay: 0s !important;
              scroll-behavior: auto !important;
            }
            .cv-auto,
            .cv-auto-xl {
              content-visibility: visible !important;
              contain-intrinsic-size: auto !important;
            }
          `,
        });

        await page.evaluate(() => {
          for (const img of Array.from(document.images)) {
            img.loading = 'eager';
            img.decoding = 'sync';
          }
        });

        await page.evaluate(async () => {
          const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
          const total = document.body.scrollHeight;
          for (let y = 0; y <= total; y += step) {
            window.scrollTo(0, y);
            await new Promise((resolve) => window.setTimeout(resolve, 80));
          }
          window.scrollTo(0, 0);
        });

        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

        await page.evaluate(async () => {
          if ('fonts' in document) {
            await document.fonts.ready;
          }

          const images = Array.from(document.images);
          await Promise.all(
            images.map(
              (img) =>
                img.complete
                  ? Promise.resolve()
                  : new Promise((resolve) => {
                      img.addEventListener('load', resolve, { once: true });
                      img.addEventListener('error', resolve, { once: true });
                    })
            )
          );
        });

        await page.waitForTimeout(200);
        const title = await page.title();
        expect(title.trim().length).toBeGreaterThan(0);

        const viewportDir = path.join(OUTPUT_DIR, viewport.name);
        fs.mkdirSync(viewportDir, { recursive: true });
        await page.screenshot({
          path: path.join(viewportDir, `${target.slug}.png`),
          fullPage: true,
        });
      });
    }
  });
}
