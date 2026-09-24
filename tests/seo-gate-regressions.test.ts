import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectCityHubIssues, extractCommercialNavigationLinks } from '../scripts/check-city-hubs-policy.mjs';
import { validateMoneyPages } from '../scripts/check-geo-signals.mjs';
import { countServiceCityBlocks } from '../scripts/check-indexable-coverage.mjs';
import { extractMainPublishedText, findForbiddenSeoJargon } from '../scripts/check-no-seo-jargon.mjs';

describe('city hub commercial nav guard', () => {
  it('ignores global navigation and privacy while keeping required commercial links', () => {
    const html = `
      <head>
        <meta name="robots" content="index,follow" />
        <link rel="canonical" href="https://example.com/irkutsk" />
      </head>
      <header>
        <nav>
          <a href="/">Главная</a>
          <a href="/projects">Проекты</a>
          <a href="/contacts">Контакты</a>
          <a href="/terms">Условия</a>
        </nav>
      </header>
      <main>
        <nav data-city-commercial-nav>
          <a href="/kuhni">Кухни</a>
          <a href="/shkafy">Шкафы</a>
          <a href="/garderobnye">Гардеробные</a>
          <a href="/privacy">Политика</a>
        </nav>
      </main>
    `;

    expect(extractCommercialNavigationLinks(html, '/irkutsk')).toEqual(
      new Set(['/kuhni', '/shkafy', '/garderobnye', '/privacy'])
    );
    expect(collectCityHubIssues(html, '/irkutsk', 'https://example.com')).toEqual([]);
  });

  it('fails when a required commercial link is removed', () => {
    const html = `
      <head>
        <meta name="robots" content="index,follow" />
        <link rel="canonical" href="https://example.com/irkutsk" />
      </head>
      <main>
        <nav data-city-commercial-nav>
          <a href="/kuhni">Кухни</a>
          <a href="/shkafy">Шкафы</a>
        </nav>
      </main>
    `;

    const issues = collectCityHubIssues(html, '/irkutsk', 'https://example.com');
    expect(issues.some((issue) => issue.includes('missing') && issue.includes('/garderobnye'))).toBe(true);
  });

  it('fails when an extra commercial link is inserted into the protected block', () => {
    const html = `
      <head>
        <meta name="robots" content="index,follow" />
        <link rel="canonical" href="https://example.com/irkutsk" />
      </head>
      <main>
        <nav data-city-commercial-nav>
          <a href="/kuhni">Кухни</a>
          <a href="/shkafy">Шкафы</a>
          <a href="/garderobnye">Гардеробные</a>
          <a href="/articles">Статьи</a>
        </nav>
      </main>
    `;

    const issues = collectCityHubIssues(html, '/irkutsk', 'https://example.com');
    expect(issues.some((issue) => issue.includes('/articles'))).toBe(true);
  });
});

describe('Irkutsk geo guard', () => {
  it('requires Irkutsk in LocalBusiness.areaServed and rejects Angarsk or Shelekhov', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-gate-'));
    const pagePath = path.join(tmpRoot, 'dist', 'kuhni');
    fs.mkdirSync(pagePath, { recursive: true });
    const validHtml = `
      <main>
        <article class="city-block">
          <div data-geo-mention-layer>Кухни на заказ в Иркутске</div>
        </article>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"LocalBusiness","areaServed":[{"@type":"City","name":"Иркутск"}]}
        </script>
      </main>
    `;
    fs.writeFileSync(path.join(pagePath, 'index.html'), validHtml, 'utf8');
    const pages = [{ pageSlug: '/kuhni', serviceId: 'kuhni-na-zakaz', serviceName: 'кухни' }];
    const localCityBlocks = {
      'kuhni-na-zakaz': {
        irkutsk: {
          city: 'irkutsk',
          cases: [
            { city: 'irkutsk', photos: ['/a.jpg', '/b.jpg'] },
            { city: 'irkutsk', photos: ['/c.jpg', '/d.jpg'] },
          ],
        },
      },
    };

    try {
      expect(validateMoneyPages(pages, localCityBlocks, path.join(tmpRoot, 'dist'))).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    const wrongHtml = `
      <main>
        <article class="city-block">
          <div data-geo-mention-layer>Кухни в Ангарске</div>
        </article>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"LocalBusiness","areaServed":[{"@type":"City","name":"Ангарск"}]}
        </script>
      </main>
    `;
    const wrongRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-gate-wrong-'));
    const wrongPath = path.join(wrongRoot, 'dist', 'kuhni');
    fs.mkdirSync(wrongPath, { recursive: true });
    fs.writeFileSync(path.join(wrongPath, 'index.html'), wrongHtml, 'utf8');
    const wrongLocalCityBlocks = {
      'kuhni-na-zakaz': {
        irkutsk: {
          city: 'irkutsk',
          cases: [
            { city: 'angarsk', photos: ['/a.jpg', '/b.jpg'] },
            { city: 'shelehov', photos: ['/c.jpg', '/d.jpg'] },
          ],
        },
      },
    };

    try {
      const issues = validateMoneyPages(pages, wrongLocalCityBlocks, path.join(wrongRoot, 'dist'));
      const issueText = issues.join('\n');
      expect(issueText).toContain('Irkutsk');
      expect(issueText).toContain('Angarsk');
      expect(issueText).toContain('Shelekhov');
    } finally {
      fs.rmSync(wrongRoot, { recursive: true, force: true });
    }
  });

  it('requires Irkutsk local-city-block evidence in service HTML', () => {
    expect(
      countServiceCityBlocks(
        '<article class="city-block"><div data-geo-mention-layer>Кухни на заказ в Иркутске</div></article>'
      )
    ).toBe(1);
    expect(countServiceCityBlocks('<article class="city-block">Шкафы в Ангарске</article>')).toBe(0);
  });
});

describe('no seo jargon guard', () => {
  it('catches a real internal SEO comment while ignoring the general menu text', () => {
    const html = `
      <header><nav><a href="/">Главная</a></nav></header>
      <main>
        <p>Кухня сделана под задачу семьи с двумя детьми.</p>
        <p>Для SEO этот проект полезен как пример удобного хранения в небольшом пространстве.</p>
      </main>
    `;

    const mainText = extractMainPublishedText(html);
    expect(mainText).toContain('Для SEO');
    expect(findForbiddenSeoJargon(mainText)).not.toHaveLength(0);
  });

  it('passes on ordinary user text and does not flag normal wording', () => {
    const html = `
      <header><nav><a href="/">Главная</a></nav></header>
      <main>
        <p>В шкафу удобно хранить одежду, бельё и сезонные вещи.</p>
        <p>Комнаты остаются светлыми и просторными.</p>
      </main>
    `;

    expect(findForbiddenSeoJargon(extractMainPublishedText(html))).toEqual([]);
  });
});
