import { expect, test, type Locator, type Page } from '@playwright/test';

const VIDEO_PROJECT = '/projects/kuhnya-grafitovaya';

type Rgb = { red: number; green: number; blue: number; alpha: number };

function parseRgb(value: string): Rgb {
  const components = value.match(/[\d.]+/g)?.map(Number) ?? [];
  if (components.length < 3) throw new Error(`Unsupported computed color: ${value}`);
  return {
    red: components[0],
    green: components[1],
    blue: components[2],
    alpha: components[3] ?? 1,
  };
}

function relativeLuminance({ red, green, blue }: Rgb): number {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

function contrastRatio(foreground: Rgb, background: Rgb): number {
  if (foreground.alpha !== 1 || background.alpha !== 1) {
    throw new Error('Contrast assertions require opaque computed colors.');
  }
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function expectElementContrast(locator: Locator, background?: Locator, minimum = 4.5) {
  const foregroundValue = await locator.evaluate((element) => getComputedStyle(element).color);
  const backgroundValue = await (background ?? locator).evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );
  expect(
    contrastRatio(parseRgb(foregroundValue), parseRgb(backgroundValue)),
    `${await locator.first().textContent()} contrast against ${backgroundValue}`
  ).toBeGreaterThanOrEqual(minimum);
}

async function openProjectModal(page: Page) {
  const trigger = page.locator('[data-project-modal-trigger]:visible').first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  const modal = page.locator('[data-project-modal]');
  await expect(modal).toBeVisible();
  return { trigger, modal };
}

test.describe('Project detail visual contracts', () => {
  test('keeps every published project primary CTA readable', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/projects');
    const projectRoutes = await page
      .locator('a.project-link[href^="/projects/"]')
      .evaluateAll((links) =>
        Array.from(
          new Set(links.map((link) => link.getAttribute('href')).filter((href): href is string => Boolean(href)))
        )
      );
    expect(projectRoutes.length).toBeGreaterThan(20);

    for (const route of projectRoutes) {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      const actions = page.locator('.project-page .ds-action-primary');
      expect(await actions.count(), `${route} should expose at least one primary CTA`).toBeGreaterThan(0);
      for (let index = 0; index < (await actions.count()); index += 1) {
        await expectElementContrast(actions.nth(index));
      }
    }
  });

  test('uses readable, single-column video rail typography and metadata', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(VIDEO_PROJECT);

    const card = page.locator('.project-rail-video');
    const kicker = card.locator('.project-rail-kicker');
    const title = card.locator('h3');
    const link = card.locator('.project-video-link');
    await expect(card).toBeVisible();
    await expect(kicker).toBeVisible();
    await expect(title).toBeVisible();
    await expect(link).toBeVisible();

    await expectElementContrast(kicker, card);
    await expectElementContrast(title, card);
    await expectElementContrast(link, card);
    for (const chip of await card.locator('.project-video-chip').all()) {
      await expectElementContrast(chip);
    }

    expect(await card.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
    const alignedBoxes = await Promise.all(
      [kicker, title, card.locator('.project-video-meta'), link].map((element) => element.boundingBox())
    );
    expect(alignedBoxes.every(Boolean)).toBe(true);
    const alignedX = alignedBoxes[0]?.x ?? 0;
    for (const box of alignedBoxes) {
      expect(Math.abs((box?.x ?? 0) - alignedX)).toBeLessThan(0.5);
    }

    await link.hover();
    await expectElementContrast(link, card);
    await link.focus();
    await expect(link).toBeFocused();
    expect(await link.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none');
  });

  test('keeps modal close control separate, reachable and operable on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(VIDEO_PROJECT);
    const { trigger, modal } = await openProjectModal(page);
    const closeButton = modal.locator('button[data-project-modal-close]');
    const heading = modal.locator('.project-modal-right .lead-contact-form h3');
    const phone = modal.locator('.project-modal-right input[name="phone"]');

    const closeBox = await closeButton.boundingBox();
    const headingBox = await heading.boundingBox();
    const phoneBox = await phone.boundingBox();
    expect(closeBox).not.toBeNull();
    expect(headingBox).not.toBeNull();
    expect(phoneBox).not.toBeNull();
    expect(closeBox?.width).toBeGreaterThanOrEqual(44);
    expect(closeBox?.height).toBeGreaterThanOrEqual(44);
    const overlaps = (first: NonNullable<typeof closeBox>, second: NonNullable<typeof headingBox>) =>
      first.x < second.x + second.width &&
      first.x + first.width > second.x &&
      first.y < second.y + second.height &&
      first.y + first.height > second.y;
    expect(overlaps(closeBox!, headingBox!)).toBe(false);
    expect(overlaps(closeBox!, phoneBox!)).toBe(false);

    await closeButton.click();
    await expect(modal).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(modal).toBeVisible();
    await closeButton.focus();
    await expect(closeButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(modal).toBeHidden();

    await trigger.click();
    await expect(modal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
  });

  test('keeps mobile CTA and modal controls readable without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(VIDEO_PROJECT);
    const primaryAction = page.locator('.project-page .ds-action-primary').first();
    await expect(primaryAction).toBeVisible();
    await expectElementContrast(primaryAction);

    const { modal } = await openProjectModal(page);
    const closeButton = modal.locator('button[data-project-modal-close]');
    await expect(closeButton).toBeVisible();
    await expect(closeButton).toBeInViewport();
    const closeBox = await closeButton.boundingBox();
    expect(closeBox?.width).toBeGreaterThanOrEqual(44);
    expect(closeBox?.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => ({
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        modalOverflow:
          (document.querySelector('.project-modal-panel')?.scrollWidth ?? 0) -
          (document.querySelector('.project-modal-panel')?.clientWidth ?? 0),
      }))
    ).toEqual({ documentOverflow: 0, modalOverflow: 0 });

    await closeButton.click();
    await expect(modal).toBeHidden();
  });
});
