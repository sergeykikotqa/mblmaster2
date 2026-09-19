import { expect, test, type Locator, type Page } from '@playwright/test';

const AFFECTED_PROJECTS = [
  'garderobnaya-p-obraznaya-shelekhov-5-i-mikroraion',
  'shkaf-vstroennyi-angarsk-84-i-kvartal',
  'garderobnaya-sovetskaya',
  'kuhnya-uglovaya-irkutsk-lermontova',
  'garderobnaya-angarsk-29-mikrorayon',
];

const PREVIOUSLY_BROKEN_PATHS = AFFECTED_PROJECTS.map(
  (slug) => `/images/projects/${slug}/01.jpg`
);

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1200 },
  { name: 'mobile', width: 390, height: 844 },
];

const expectLoadedImage = async (image: Locator) => {
  await expect(image).toHaveCount(1);
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
};

const scrollThroughPage = async (page: Page) => {
  await page.evaluate(async () => {
    const pause = (duration: number) => new Promise((resolve) => window.setTimeout(resolve, duration));
    const step = Math.max(320, Math.floor(window.innerHeight * 0.7));

    for (let position = 0; position < document.documentElement.scrollHeight; position += step) {
      window.scrollTo(0, position);
      await pause(60);
    }

    window.scrollTo(0, document.documentElement.scrollHeight);
    await pause(180);
  });
};

const monitorImages = (page: Page) => {
  const errors: string[] = [];
  const requestedPaths = new Set<string>();

  page.on('request', (request) => {
    if (request.resourceType() !== 'image') return;
    requestedPaths.add(new URL(request.url()).pathname);
  });
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'image' || response.status() < 400) return;
    errors.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    if (request.resourceType() !== 'image') return;
    errors.push(`${request.failure()?.errorText || 'request failed'} ${request.url()}`);
  });

  return { errors, requestedPaths };
};

const openProjectModal = async (page: Page, trigger: Locator) => {
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();

  const modal = page.locator('[data-project-modal]');
  await expect(modal).toBeVisible();
  await expectLoadedImage(modal.locator('[data-project-modal-image]'));
  await modal.locator('button[data-project-modal-close]').click();
  await expect(modal).toBeHidden();
};

for (const viewport of VIEWPORTS) {
  test(`project images stay available across cards, details and galleries on ${viewport.name}`, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    expect(baseURL).toBeTruthy();

    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    });
    await context.addCookies([
      {
        name: 'site_analytics_consent',
        value: 'denied',
        url: baseURL as string,
      },
    ]);

    const projectsPage = await context.newPage();
    const projectsMonitor = monitorImages(projectsPage);
    await projectsPage.goto(`${baseURL}/projects`, { waitUntil: 'domcontentloaded' });
    await scrollThroughPage(projectsPage);

    const cardImages = projectsPage.locator('.project-card .project-cover img');
    expect(await cardImages.count()).toBeGreaterThan(AFFECTED_PROJECTS.length);
    await expect
      .poll(() =>
        cardImages.evaluateAll((images: HTMLImageElement[]) =>
          images
            .filter((image) => !image.complete || image.naturalWidth === 0)
            .map((image) => image.currentSrc || image.src)
        )
      )
      .toEqual([]);

    for (const slug of AFFECTED_PROJECTS) {
      await openProjectModal(
        projectsPage,
        projectsPage.locator(`[data-project-modal-trigger][data-project-slug="${slug}"]`)
      );
    }

    expect(projectsMonitor.errors).toEqual([]);
    for (const brokenPath of PREVIOUSLY_BROKEN_PATHS) {
      expect(projectsMonitor.requestedPaths.has(brokenPath)).toBe(false);
    }
    await projectsPage.close();

    for (const slug of AFFECTED_PROJECTS) {
      const detailPage = await context.newPage();
      const detailMonitor = monitorImages(detailPage);
      await detailPage.goto(`${baseURL}/projects/${slug}`, { waitUntil: 'domcontentloaded' });
      await scrollThroughPage(detailPage);

      await expectLoadedImage(detailPage.locator('.project-hero__media img').first());

      const gallery = detailPage.locator('[data-project-gallery]').first();
      await expect(gallery).toBeVisible();
      const thumbs = gallery.locator('[data-gallery-thumb]');
      const thumbCount = await thumbs.count();

      if (thumbCount === 0) {
        await expectLoadedImage(gallery.locator('[data-gallery-slide].is-active img'));
      } else {
        for (let index = 0; index < thumbCount; index += 1) {
          await thumbs.nth(index).click();
          await expectLoadedImage(gallery.locator('[data-gallery-slide].is-active img'));
        }
      }

      await gallery.locator('[data-gallery-open]').click();
      const lightbox = gallery.locator('[data-gallery-lightbox]');
      await expect(lightbox).toBeVisible();
      await expectLoadedImage(lightbox.locator('[data-gallery-lightbox-image]'));
      await lightbox.locator('[data-gallery-close]').click();
      await expect(lightbox).toBeHidden();

      await openProjectModal(detailPage, detailPage.locator('[data-project-modal-trigger]:visible').first());
      expect(detailMonitor.errors).toEqual([]);
      await detailPage.close();
    }

    await context.close();
  });
}
