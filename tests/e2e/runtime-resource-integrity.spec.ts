import { expect, test, type Page } from '@playwright/test';

const ROUTES = [
  '/',
  '/kuhni',
  '/projects',
  '/projects/kuhnya-bogdana',
  '/articles',
  '/articles/cveta-kuhni-trendy',
  '/contacts',
];
const RUNTIME_RESOURCE_TYPES = new Set(['stylesheet', 'script', 'image', 'font']);

async function scrollThroughPage(page: Page) {
  await page.evaluate(async () => {
    const pause = (duration: number) => new Promise((resolve) => window.setTimeout(resolve, duration));
    const step = Math.max(320, Math.floor(window.innerHeight * 0.75));
    for (let position = 0; position < document.documentElement.scrollHeight; position += step) {
      window.scrollTo(0, position);
      await pause(50);
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await pause(250);
  });
}

for (const route of ROUTES) {
  test(`local runtime resources load through Nginx on ${route}`, async ({ page, baseURL }) => {
    test.setTimeout(60_000);
    expect(baseURL).toBeTruthy();
    const publicOrigin = new URL(baseURL as string).origin;
    const failures: string[] = [];

    page.on('response', (response) => {
      const request = response.request();
      if (!RUNTIME_RESOURCE_TYPES.has(request.resourceType())) return;
      if (new URL(response.url()).origin !== publicOrigin || response.status() < 400) return;
      failures.push(`${response.status()} ${response.url()}`);
    });
    page.on('requestfailed', (request) => {
      if (!RUNTIME_RESOURCE_TYPES.has(request.resourceType())) return;
      if (new URL(request.url()).origin !== publicOrigin) return;
      failures.push(`${request.failure()?.errorText || 'request failed'} ${request.url()}`);
    });

    const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);
    await scrollThroughPage(page);
    expect(failures).toEqual([]);
  });
}
