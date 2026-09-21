type ServiceLinkTarget = {
  id?: string;
  name: string;
  href: string;
};

import { selectServiceAnchor, hashString, type AnchorType } from './anchor-strategy';

type EarlyServiceLinkParams = {
  html: string;
  service: ServiceLinkTarget | null;
  articleSlug: string;
  seoReady: boolean;
  geoTarget?: string | null;
  minChars?: number;
  minParagraphs?: number;
};

type EarlyServiceLinkResult = {
  html: string;
  inserted: boolean;
  hasServiceLink: boolean;
  href?: string;
};

const EARLY_SERVICE_MARKER = 'data-early-service="true"';
const MIN_CONTENT_CHARS = 1200;
const MIN_PARAGRAPHS = 2;
const MIN_PARAGRAPH_LENGTH = 200;
const EARLY_LINK_RATIO = 0.4;
const MAX_EXISTING_SERVICE_LINKS = 2;

const CITY_CASES: Record<string, { name: string; in: string }> = {
  иркутск: { name: 'Иркутск', in: 'Иркутске' },
};

const SERVICE_TEMPLATES: Record<string, Record<AnchorType, string[]>> = {
  kuhni: {
    exact: [
      'Когда важны точные размеры и эргономика, чаще всего выбирают {anchor} — так проект подстраивают под помещение.',
      'Если нужен точный проект под планировку, логичным выбором будет {anchor}.',
    ],
    partial: [
      'Когда важны точные размеры и эргономика, чаще всего выбирают {anchor} — так проект подстраивают под помещение.',
      'Если планировка нестандартная, уместно рассмотреть {anchor}, где всё делают под конкретные размеры.',
      'Практичный вариант — {anchor}, когда кухню собирают под ваши размеры и сценарии использования.',
    ],
    natural: [
      'Для сложной планировки лучше подходит {anchor} — так всё рассчитывают под вашу геометрию.',
      'Когда нужно сохранить эргономику, помогают {anchor} с аккуратной настройкой под быт семьи.',
    ],
    generic: [
      'Чтобы сравнить варианты, можно {anchor} и подобрать формат под вашу планировку.',
    ],
  },
  shkafy: {
    exact: [
      'Чтобы точно попасть в размеры ниши, обычно выбирают {anchor} и сразу закладывают нужное наполнение.',
      'Если важна точная посадка по габаритам, помогает {anchor}.',
    ],
    partial: [
      'Чтобы сохранить полезную площадь, обычно выбирают {anchor} — размеры и наполнение подбирают индивидуально.',
      'Когда нужна аккуратная встроенная система хранения, помогает {anchor} с проектом под ваши габариты.',
      'В таких случаях часто выбирают {anchor}, чтобы шкаф идеально встал в нишу и по высоте.',
    ],
    natural: [
      'Если важно сохранить полезный объём, лучше подходит {anchor} с продуманными зонами хранения.',
      'Когда важна эргономика, помогает {anchor} под реальную нагрузку семьи.',
    ],
    generic: [
      'Чтобы сравнить решения, можно {anchor} и выбрать наполнение под свои задачи.',
    ],
  },
  garderobnye: {
    exact: [
      'Если нужен проект под ваши размеры, часто выбирают {anchor} — это упрощает организацию хранения.',
      'Когда важно точное попадание в планировку, помогает {anchor}.',
    ],
    partial: [
      'Когда важно организовать хранение без потери площади, часто выбирают {anchor} — решение собирают под планировку.',
      'Если место ограничено, уместно рассмотреть {anchor}: систему хранения подстраивают под ваши размеры.',
      'Практичный путь — {anchor}, когда гардеробная делается под конкретное помещение.',
    ],
    natural: [
      'Когда нужно разложить хранение по зонам, помогает {anchor} с понятной структурой.',
      'Если важно задействовать всю высоту, подходит {anchor} с гибким наполнением.',
    ],
    generic: [
      'Чтобы понять варианты планировок, можно {anchor} и выбрать удобную схему.',
    ],
  },
};

const SERVICE_KEY_OVERRIDES: Record<string, string> = {
  'kuhni-na-zakaz': 'kuhni',
  'shkafy-kupe': 'shkafy',
  garderobnye: 'garderobnye',
};

const escapeHtml = (value: string) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const stripHtml = (html: string) =>
  String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const countParagraphs = (html: string): number => {
  const matches = String(html || '').match(/<p\b[^>]*>/gi);
  return matches ? matches.length : 0;
};

const resolveCity = (raw: string | null | undefined): { name: string; in: string } | null => {
  const normalized = String(raw || '').toLowerCase();
  for (const key of Object.keys(CITY_CASES)) {
    if (normalized.includes(key)) return CITY_CASES[key];
  }
  return null;
};

const buildServiceHrefRegex = (href: string, flags = 'i'): RegExp => {
  const normalized = String(href || '').replace(/\/+$/, '');
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`href=["'](?:https?:\\/\\/[^"']+)?${escaped}\\/?["']`, flags);
};

const findParagraphs = (html: string, limit = 2) => {
  const paragraphs: Array<{ open: number; close: number; length: number }> = [];
  const regex = /<p\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const open = match.index;
    const close = html.indexOf('</p>', open);
    if (close === -1) continue;
    const raw = html.slice(open, close + 4);
    paragraphs.push({ open, close: close + 4, length: stripHtml(raw).length });
    if (paragraphs.length >= limit) break;
  }

  return paragraphs;
};

const findServiceLinkStats = (html: string, href: string) => {
  const regex = buildServiceHrefRegex(href, 'gi');
  let match: RegExpExecArray | null;
  let count = 0;
  let firstIndex = -1;
  while ((match = regex.exec(html)) !== null) {
    count += 1;
    if (firstIndex === -1) {
      firstIndex = match.index;
    }
  }
  return { count, firstIndex };
};

const buildEarlyLinkHtml = (
  serviceKey: string,
  serviceHref: string,
  city: { name: string; in: string } | null,
  slug: string
) => {
  const templates = SERVICE_TEMPLATES[serviceKey];
  if (!templates) return null;

  const seed = hashString(`${slug}:${serviceKey}`);
  const anchorResult = selectServiceAnchor({
    serviceKey,
    seed,
    city,
    allowedTypes: ['exact', 'partial', 'natural', 'generic'],
  });
  if (!anchorResult) return null;

  const templatePool = templates[anchorResult.type] || templates.partial;
  if (!templatePool || templatePool.length === 0) return null;
  const template = templatePool[seed % templatePool.length];
  const anchorHtml = `<a href="${escapeHtml(serviceHref)}">${escapeHtml(anchorResult.text)}</a>`;
  const sentence = template.replace('{anchor}', anchorHtml);

  return `<p class="early-service-link" ${EARLY_SERVICE_MARKER}>${sentence}</p>`;
};

export function injectEarlyServiceLink({
  html,
  service,
  articleSlug,
  seoReady,
  geoTarget,
  minChars = MIN_CONTENT_CHARS,
  minParagraphs = MIN_PARAGRAPHS,
}: EarlyServiceLinkParams): EarlyServiceLinkResult {
  if (!html || !service || !seoReady) {
    return { html, inserted: false, hasServiceLink: false };
  }

  if (html.includes(EARLY_SERVICE_MARKER)) {
    return { html, inserted: false, hasServiceLink: true, href: service.href };
  }

  const { count: existingCount, firstIndex } = findServiceLinkStats(html, service.href);
  if (existingCount > 0) {
    const ratio = firstIndex >= 0 ? firstIndex / Math.max(1, html.length) : 1;
    const isEarlyEnough = ratio <= EARLY_LINK_RATIO;
    if (isEarlyEnough || existingCount >= MAX_EXISTING_SERVICE_LINKS) {
      return { html, inserted: false, hasServiceLink: true, href: service.href };
    }
  }

  const textLength = stripHtml(html).length;
  if (textLength < minChars) {
    return { html, inserted: false, hasServiceLink: false };
  }

  if (countParagraphs(html) < minParagraphs) {
    return { html, inserted: false, hasServiceLink: false };
  }

  const paragraphs = findParagraphs(html, 2);
  if (paragraphs.length === 0) {
    return { html, inserted: false, hasServiceLink: false };
  }

  const insertAfterFirst = paragraphs[0].length >= MIN_PARAGRAPH_LENGTH;
  const insertTarget = insertAfterFirst || paragraphs.length === 1 ? paragraphs[0] : paragraphs[1];
  const rawServiceId = String(service.id || '').trim();
  const fallbackKey = String(service.href || '').replace(/\//g, '').trim();
  const serviceKey = SERVICE_KEY_OVERRIDES[rawServiceId] || fallbackKey;
  const city = resolveCity(geoTarget);
  const linkHtml = buildEarlyLinkHtml(serviceKey, service.href, city, articleSlug);
  if (!linkHtml) {
    return { html, inserted: false, hasServiceLink: false };
  }

  const insertIndex = insertTarget.close;
  const output = `${html.slice(0, insertIndex)}${linkHtml}${html.slice(insertIndex)}`;

  return { html: output, inserted: true, hasServiceLink: true, href: service.href };
}

export { EARLY_SERVICE_MARKER };
