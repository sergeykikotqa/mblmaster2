import { EARLY_SERVICE_MARKER } from './early-service-link';

type MidRelatedProject = {
  title: string;
  href: string;
  meta?: string;
};

type MidRelatedArticle = {
  title: string;
  href: string;
  description?: string;
};

type InjectMidRelatedParams = {
  html: string;
  project?: MidRelatedProject | null;
  article?: MidRelatedArticle | null;
  minChars?: number;
  minParagraphs?: number;
};

const DEFAULT_MIN_CHARS = 3000;
const DEFAULT_MIN_PARAGRAPHS = 3;
const MIN_PARAGRAPH_LENGTH = 200;
const MIN_DISTANCE_AFTER_EARLY = 400;
const MID_RELATED_MARKER = 'data-mid-related="true"';

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

const escapeHtml = (value: string) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const findNextParagraphClose = (html: string, fromIndex: number): number => {
  const openIndex = html.indexOf('<p', fromIndex);
  if (openIndex === -1) return -1;
  const closeIndex = html.indexOf('</p>', openIndex);
  if (closeIndex === -1) return -1;
  return closeIndex + '</p>'.length;
};

const adjustInsertIndexForEarly = (html: string, insertIndex: number): number => {
  const markerIndex = html.indexOf(EARLY_SERVICE_MARKER);
  if (markerIndex === -1) return insertIndex;

  const earlyCloseIndex = html.indexOf('</p>', markerIndex);
  if (earlyCloseIndex === -1) return insertIndex;

  const earlyEnd = earlyCloseIndex + '</p>'.length;
  if (insertIndex >= earlyEnd + MIN_DISTANCE_AFTER_EARLY) return insertIndex;

  const nextParagraphClose = findNextParagraphClose(html, earlyEnd);
  if (nextParagraphClose !== -1 && nextParagraphClose > insertIndex) {
    return nextParagraphClose;
  }

  return insertIndex;
};

const findMidInsertIndex = (html: string): number => {
  const h2Regex = /<h2\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  let count = 0;

  while ((match = h2Regex.exec(html)) !== null) {
    count += 1;
    if (count !== 2) continue;

    const h2CloseIndex = html.indexOf('</h2>', match.index);
    if (h2CloseIndex === -1) return -1;
    const afterH2Index = h2CloseIndex + '</h2>'.length;

    const rest = html.slice(afterH2Index);
    const pOpenMatch = /<p\b[^>]*>/i.exec(rest);
    if (pOpenMatch && typeof pOpenMatch.index === 'number') {
      const pOpenAbs = afterH2Index + pOpenMatch.index;
      const pCloseIndex = html.indexOf('</p>', pOpenAbs);
      if (pCloseIndex !== -1) {
        const firstParagraphHtml = html.slice(pOpenAbs, pCloseIndex + '</p>'.length);
        const firstParagraphLength = stripHtml(firstParagraphHtml).length;
        if (firstParagraphLength >= MIN_PARAGRAPH_LENGTH) {
          return pCloseIndex + '</p>'.length;
        }

        const restAfterFirst = html.slice(pCloseIndex + '</p>'.length);
        const secondOpenMatch = /<p\b[^>]*>/i.exec(restAfterFirst);
        if (secondOpenMatch && typeof secondOpenMatch.index === 'number') {
          const secondOpenAbs = pCloseIndex + '</p>'.length + secondOpenMatch.index;
          const secondCloseIndex = html.indexOf('</p>', secondOpenAbs);
          if (secondCloseIndex !== -1) {
            return secondCloseIndex + '</p>'.length;
          }
        }
      }
    }

    // fallback: insert right after the second h2 closing tag
    return afterH2Index;
  }

  return -1;
};

const buildBlockHtml = (project: MidRelatedProject, article: MidRelatedArticle): string => {
  const projectMeta = escapeHtml(project.meta || '');
  const articleDescription = escapeHtml(article.description || '');

  return `
<div class="article-mid-related not-prose card card-soft card-shadow my-8" ${MID_RELATED_MARKER}>
  <div class="text-xs uppercase tracking-wide text-[#7f5438] mb-3">Смотрите также</div>
  <div class="grid gap-4 md:grid-cols-2">
    <a href="${escapeHtml(project.href)}" class="block ui-btn-state rounded-lg border border-[#e9dfd7] p-4 no-underline hover:border-[#d6c5b7]">
      <div class="text-[11px] uppercase tracking-wide text-[#7a6f68] mb-1">Проект</div>
      <div class="font-semibold text-[#1f1a17] mb-1">${escapeHtml(project.title)}</div>
      ${projectMeta ? `<div class="text-sm text-[#665f5a]">${projectMeta}</div>` : ''}
    </a>
    <a href="${escapeHtml(article.href)}" class="block ui-btn-state rounded-lg border border-[#e9dfd7] p-4 no-underline hover:border-[#d6c5b7]">
      <div class="text-[11px] uppercase tracking-wide text-[#7a6f68] mb-1">Статья</div>
      <div class="font-semibold text-[#1f1a17] mb-1">${escapeHtml(article.title)}</div>
      ${articleDescription ? `<div class="text-sm text-[#665f5a]">${articleDescription}</div>` : ''}
    </a>
  </div>
</div>
`;
};

export const injectMidRelatedBlock = ({
  html,
  project,
  article,
  minChars = DEFAULT_MIN_CHARS,
  minParagraphs = DEFAULT_MIN_PARAGRAPHS,
}: InjectMidRelatedParams): string => {
  if (!html || !project || !article) return html;
  if (html.includes(MID_RELATED_MARKER)) return html;

  const textLength = stripHtml(html).length;
  if (textLength < minChars) return html;
  if (countParagraphs(html) < minParagraphs) return html;

  const insertIndex = findMidInsertIndex(html);
  if (insertIndex === -1) return html;

  const adjustedIndex = adjustInsertIndexForEarly(html, insertIndex);
  const blockHtml = buildBlockHtml(project, article);
  return `${html.slice(0, adjustedIndex)}${blockHtml}${html.slice(adjustedIndex)}`;
};

