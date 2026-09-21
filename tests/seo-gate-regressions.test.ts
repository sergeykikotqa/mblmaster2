import { describe, expect, it } from 'vitest';

import {
  collectCityHubIssues,
  extractCommercialNavigationLinks,
} from '../scripts/check-city-hubs-policy.mjs';
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
