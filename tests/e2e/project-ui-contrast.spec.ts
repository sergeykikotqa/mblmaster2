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

function boxesOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number }
) {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

test.describe('Project detail visual contracts', () => {
  test('keeps project catalogue cards aligned within each grid row', async ({ page }) => {
    for (const viewport of [
      { width: 806, height: 884 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/projects', { waitUntil: 'domcontentloaded' });

      const [breadcrumbBox, headingBox] = await Promise.all([
        page.locator('nav[aria-label="Breadcrumb"]').boundingBox(),
        page.locator('.projects-head').boundingBox(),
      ]);
      const breadcrumbPanelBox = await page.locator('nav[aria-label="Breadcrumb"] ol').boundingBox();
      expect(breadcrumbBox).not.toBeNull();
      expect(breadcrumbPanelBox).not.toBeNull();
      expect(headingBox).not.toBeNull();
      expect(headingBox!.y - (breadcrumbBox!.y + breadcrumbBox!.height)).toBeGreaterThanOrEqual(23.5);
      expect(breadcrumbPanelBox!.width).toBeLessThan(260);
      expect(breadcrumbPanelBox!.height).toBeLessThanOrEqual(58);

      const cards = await page.locator('.projects-grid > li').evaluateAll((items) =>
        items.map((item) => {
          const card = item.querySelector<HTMLElement>('.project-card');
          const action = item.querySelector<HTMLElement>('.project-cta-primary');
          if (!card || !action) throw new Error('Project grid item is missing its card or primary action.');
          const itemBox = item.getBoundingClientRect();
          const cardBox = card.getBoundingClientRect();
          const actionBox = action.getBoundingClientRect();
          return {
            rowTop: itemBox.top,
            itemHeight: itemBox.height,
            cardHeight: cardBox.height,
            cardBottom: cardBox.bottom,
            actionTop: actionBox.top,
          };
        })
      );

      expect(cards.length).toBeGreaterThan(20);
      for (const card of cards) {
        expect(Math.abs(card.cardHeight - card.itemHeight)).toBeLessThan(0.5);
      }

      const rows = new Map<number, typeof cards>();
      for (const card of cards) {
        const rowKey = Math.round(card.rowTop);
        rows.set(rowKey, [...(rows.get(rowKey) ?? []), card]);
      }
      for (const row of rows.values()) {
        if (row.length < 2) continue;
        expect(
          Math.max(...row.map((card) => card.cardHeight)) - Math.min(...row.map((card) => card.cardHeight))
        ).toBeLessThan(0.5);
        expect(
          Math.max(...row.map((card) => card.cardBottom)) - Math.min(...row.map((card) => card.cardBottom))
        ).toBeLessThan(0.5);
        expect(
          Math.max(...row.map((card) => card.actionTop)) - Math.min(...row.map((card) => card.actionTop))
        ).toBeLessThan(0.5);
      }
    }
  });

  test('keeps article recommendations readable and recognizable as links', async ({ page }) => {
    await page.setViewportSize({ width: 806, height: 884 });
    await page.goto('/articles/malenkaya-kuhnya-na-zakaz-irkutsk');

    const midRelated = page.locator('.article-mid-related');
    await expect(midRelated).toBeVisible();
    await expectElementContrast(midRelated.locator(':scope > div:first-child'), midRelated);
    for (const link of await midRelated.locator('a').all()) {
      await expectElementContrast(link.locator(':scope > div:nth-child(2)'), link);
      for (const supportingText of await link.locator(':scope > div:not(:nth-child(2))').all()) {
        await expectElementContrast(supportingText, link);
      }
    }

    const relatedPanel = page.locator('.article-related-links');
    await expect(relatedPanel).toBeVisible();
    await expectElementContrast(relatedPanel.locator('h3'), relatedPanel);
    const relatedLinks = relatedPanel.locator('a');
    expect(await relatedLinks.count()).toBeGreaterThan(0);
    for (const link of await relatedLinks.all()) {
      await expectElementContrast(link);
      expect(await link.evaluate((element) => getComputedStyle(element).display)).toBe('flex');
      expect(await link.evaluate((element) => getComputedStyle(element, '::after').content)).toContain('→');
    }
  });

  test('keeps portfolio card content readable on secondary pages', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/o-kompanii');

    const cards = page.locator('.portfolio-card');
    expect(await cards.count()).toBeGreaterThan(0);

    for (const card of await cards.all()) {
      await expectElementContrast(card.locator('.portfolio-price strong'), card);
      await expectElementContrast(card.locator('.portfolio-body h3'), card);
      for (const metadata of await card.locator('.portfolio-meta li').all()) {
        await expectElementContrast(metadata);
      }
      await expectElementContrast(card.locator('.portfolio-btn'));
    }
  });

  test('keeps every published project primary CTA readable', async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 806, height: 884 });
    await page.goto('/projects');
    const projectRoutes = await page
      .locator('a.project-link[href^="/projects/"]')
      .evaluateAll((links) =>
        Array.from(
          new Set(links.map((link) => link.getAttribute('href')).filter((href): href is string => Boolean(href)))
        )
      );
    expect(projectRoutes.length).toBeGreaterThan(20);
    let finalCtaPages = 0;
    let specsPages = 0;
    let videoRailPages = 0;
    let modalPages = 0;
    let costPages = 0;
    let breadcrumbPages = 0;
    let aboutHighlightPages = 0;
    let aboutHighlightItems = 0;

    for (const route of projectRoutes) {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      const actions = page.locator('.project-page .ds-action-primary');
      expect(await actions.count(), `${route} should expose at least one primary CTA`).toBeGreaterThan(0);
      for (let index = 0; index < (await actions.count()); index += 1) {
        await expectElementContrast(actions.nth(index));
      }

      const finalCta = page.locator('.project-cta-card');
      if ((await finalCta.count()) > 0) {
        finalCtaPages += 1;
        await expect(finalCta, `${route} final project CTA should be visible`).toBeVisible();
        await expectElementContrast(finalCta.locator('h2'), finalCta);
        await expectElementContrast(finalCta.locator('.project-cta-highlight'), finalCta);
      }

      const specsCard = page.locator('.project-specs-card');
      if ((await specsCard.count()) > 0) {
        specsPages += 1;
        await expect(specsCard, `${route} project specs should be visible`).toBeVisible();
        for (const label of await specsCard.locator('dt').all()) {
          await expectElementContrast(label, specsCard);
        }
        for (const value of await specsCard.locator('dd').all()) {
          await expectElementContrast(value, specsCard);
        }
        const note = specsCard.locator('.specs-note');
        if ((await note.count()) > 0) {
          await expectElementContrast(note, specsCard);
        }
      }

      const costCard = page.locator('.project-cost-card');
      if ((await costCard.count()) > 0) {
        costPages += 1;
        const offerBadge = costCard.locator('.project-cost-badge');
        const highlight = costCard.locator('.project-cost-highlight');
        const freeBadge = highlight.locator('.project-cost-highlight-badge');
        await expectElementContrast(offerBadge.locator(':scope > span'), offerBadge);
        await expectElementContrast(offerBadge.locator(':scope > strong'), offerBadge);
        await expectElementContrast(highlight.locator(':scope > div > strong'), highlight);
        await expectElementContrast(highlight.locator(':scope > div > span'), highlight);
        await expectElementContrast(freeBadge);

        const [cardBox, highlightBox] = await Promise.all([costCard.boundingBox(), highlight.boundingBox()]);
        expect(cardBox, `${route} cost card should have a box`).not.toBeNull();
        expect(highlightBox, `${route} cost highlight should have a box`).not.toBeNull();
        expect(highlightBox!.width, `${route} cost highlight should stay compact`).toBeLessThanOrEqual(512.5);
        expect(highlightBox!.width).toBeLessThan(cardBox!.width);
      }

      const aboutHighlights = page.locator('.project-about-highlight');
      if ((await aboutHighlights.count()) > 0) {
        aboutHighlightPages += 1;
        aboutHighlightItems += await aboutHighlights.count();
        for (const highlight of await aboutHighlights.all()) {
          const iconContainer = highlight.locator('.project-about-icon');
          const icon = iconContainer.locator('svg');
          const [containerBox, iconBox] = await Promise.all([iconContainer.boundingBox(), icon.boundingBox()]);
          expect(containerBox, `${route} about icon container should have a box`).not.toBeNull();
          expect(iconBox, `${route} about icon should have a box`).not.toBeNull();
          expect(iconBox!.width).toBeGreaterThanOrEqual(18);
          expect(iconBox!.height).toBeGreaterThanOrEqual(18);
          expect(
            Math.abs(iconBox!.x + iconBox!.width / 2 - (containerBox!.x + containerBox!.width / 2)),
            `${route} about icon should be horizontally centered`
          ).toBeLessThan(0.5);
          expect(
            Math.abs(iconBox!.y + iconBox!.height / 2 - (containerBox!.y + containerBox!.height / 2)),
            `${route} about icon should be vertically centered`
          ).toBeLessThan(0.5);
        }
      }

      const heroInner = page.locator('.project-hero__content-inner');
      const breadcrumbs = heroInner.locator('.project-hero-breadcrumbs');
      if ((await breadcrumbs.count()) > 0 && (await breadcrumbs.isVisible())) {
        breadcrumbPages += 1;
        const [heroInnerBox, breadcrumbsBox] = await Promise.all([heroInner.boundingBox(), breadcrumbs.boundingBox()]);
        expect(heroInnerBox, `${route} hero content should have a box`).not.toBeNull();
        expect(breadcrumbsBox, `${route} breadcrumbs should have a box`).not.toBeNull();
        expect(breadcrumbsBox!.width, `${route} breadcrumbs should not stretch across the hero`).toBeLessThan(
          heroInnerBox!.width / 2
        );
      }

      const videoRail = page.locator('.project-rail-video');
      if ((await videoRail.count()) > 0) {
        videoRailPages += 1;
        await expectElementContrast(videoRail.locator('.project-rail-kicker'), videoRail);
        await expectElementContrast(videoRail.locator('h3'), videoRail);
        await expectElementContrast(videoRail.locator('.project-video-link'), videoRail);
        for (const chip of await videoRail.locator('.project-video-chip').all()) {
          await expectElementContrast(chip);
        }
        expect(
          await videoRail.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
        ).toBe(1);
      }

      const { modal } = await openProjectModal(page);
      modalPages += 1;
      const closeButton = modal.locator('button[data-project-modal-close]');
      const heading = modal.locator('.project-modal-right .lead-contact-form h3');
      const phone = modal.locator('.project-modal-right input[name="phone"]');
      const [closeBox, headingBox, phoneBox] = await Promise.all([
        closeButton.boundingBox(),
        heading.boundingBox(),
        phone.boundingBox(),
      ]);
      expect(closeBox, `${route} modal close should have a box`).not.toBeNull();
      expect(headingBox, `${route} modal heading should have a box`).not.toBeNull();
      expect(phoneBox, `${route} modal phone should have a box`).not.toBeNull();
      expect(closeBox?.width).toBeGreaterThanOrEqual(44);
      expect(closeBox?.height).toBeGreaterThanOrEqual(44);
      expect(boxesOverlap(closeBox!, headingBox!)).toBe(false);
      expect(boxesOverlap(closeBox!, phoneBox!)).toBe(false);
      await closeButton.click();
      await expect(modal).toBeHidden();

      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        `${route} should not overflow horizontally`
      ).toBe(0);
    }

    expect(finalCtaPages).toBeGreaterThan(0);
    expect(specsPages).toBeGreaterThan(0);
    expect(videoRailPages).toBeGreaterThan(1);
    expect(modalPages).toBe(projectRoutes.length);
    expect(costPages).toBe(24);
    expect(breadcrumbPages).toBe(projectRoutes.length);
    expect(aboutHighlightPages).toBe(projectRoutes.length);
    expect(aboutHighlightItems).toBe(75);
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
    expect(boxesOverlap(closeBox!, headingBox!)).toBe(false);
    expect(boxesOverlap(closeBox!, phoneBox!)).toBe(false);

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
