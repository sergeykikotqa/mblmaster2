import type { RehypePlugin } from '@astrojs/markdown-remark';

type AutoLinkRule = {
  href: string;
  anchors: string[];
};

type FrontmatterLike = {
  title?: string;
  category?: string;
  mainKeyword?: string;
  tags?: string[];
  keywords?: string[];
  geoTarget?: string;
};

type AutoLinkState = {
  total: number;
  perTarget: Map<string, number>;
  preferredTarget?: string | null;
  allowedTargets?: Set<string>;
  maxLinksPerTarget: number;
  maxTotalLinks: number;
  paragraphCount: number;
  hasPassedFirstHeading: boolean;
};

type AutoLinkNode = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: AutoLinkNode[];
};

type AutoLinkTextNode = {
  type: 'text';
  value: string;
};

type AutoLinkElementNode = {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  children: AutoLinkNode[];
};

const AUTO_LINK_RULES: AutoLinkRule[] = [
  {
    href: '/kuhni',
    anchors: [
      'кухни на заказ',
      'кухня на заказ',
      'кухни в иркутске',
      'кухня в иркутске',
      'кухни иркутск',
      'кухня иркутск',
      'кухня 3 метра иркутск',
      'кухня 3 метра',
      'кухня 2 на 3 метра',
      'маленькая кухня на заказ иркутск',
      'маленькая кухня на заказ',
      'маленькая кухня',
      'угловая кухня недорого иркутск',
      'угловая кухня недорого',
      'кухня эконом класса иркутск',
      'кухня эконом класса',
      'кухня с барной стойкой иркутск',
      'кухня с барной стойкой',
      'белая кухня на заказ иркутск',
      'белая кухня на заказ',
      'кухня в хрущевке иркутск',
      'кухня в хрущевке',
      'кухня без верхних шкафов иркутск',
      'кухня без верхних шкафов',
      'кухня с островом иркутск',
      'кухня с островом',
      'матовая кухня иркутск',
      'матовая кухня',
      'кухня из массива иркутск',
      'кухня из массива',
      'кухня из мдф иркутск',
      'кухня из мдф',
      'кухня с мойкой у окна иркутск',
      'кухня с мойкой у окна',
      'кухня 4 метра иркутск',
      'кухня 4 метра',
      'кухня с подсветкой иркутск',
      'кухня с подсветкой',
      'кухня в стиле лофт иркутск',
      'кухня в стиле лофт',
      'кухня в стиле прованс иркутск',
      'кухня в стиле прованс',
      'кухня с нишей для холодильника иркутск',
      'кухня с нишей для холодильника',
    ],
  },
  {
    href: '/shkafy',
    anchors: [
      'шкафы-купе на заказ',
      'шкафы-купе',
      'шкафы на заказ',
      'шкаф на заказ',
      'шкафы в иркутске',
      'шкафы иркутск',
      'шкаф купе иркутск',
      'шкаф-купе иркутск',
      'встроенный шкаф иркутск',
      'шкаф в прихожую иркутск',
      'шкаф в спальню иркутск',
      'шкаф купе на заказ иркутск',
    ],
  },
  {
    href: '/garderobnye',
    anchors: [
      'гардеробные на заказ',
      'гардеробная на заказ',
      'гардеробные в иркутске',
      'гардеробные иркутск',
      'гардеробная иркутск',
      'гардеробная в квартире',
      'гардеробная в прихожей',
    ],
  },
  {
    href: '/projects/biruzovaya-uglovaya-kuhnya-irkutsk',
    anchors: ['кухня на богдана хмельницкого', 'кухня богдана хмельницкого'],
  },
  {
    href: '/projects/belaya-uglovaya-kuhnya-zagorodny-dom-irkutsk',
    anchors: ['кухня на байкальском тракте', 'кухня байкальский тракт'],
  },
  {
    href: '/projects/bezhevaya-uglovaya-kuhnya-irkutsk',
    anchors: ['кухня на красноказачьей', 'кухня красноказачья'],
  },
  {
    href: '/projects/uglovaya-kuhnya-s-podsvetkoy-irkutsk',
    anchors: ['кухня на пискунова', 'кухня пискунова'],
  },
  {
    href: '/projects/pryamaya-kuhnya-s-vysokimi-penalami-irkutsk',
    anchors: ['кухня на верхней набережной', 'кухня верхняя набережная'],
  },
  {
    href: '/projects/vstroennyi-shkaf-s-rabochey-zonoy-irkutsk',
    anchors: ['шкаф на депутатской', 'шкаф депутатская'],
  },
];

const MAX_TOTAL_LINKS = 3;
const MAX_LINKS_PER_TARGET = 1;
const MAX_LINKED_PARAGRAPHS = 2;

const SKIP_TAGS = new Set([
  'a',
  'code',
  'pre',
  'script',
  'style',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);

const ALLOWED_CONTAINER_TAGS = new Set(['p']);

const BLACKLIST_PHRASES = [
  'оставьте заявку',
  'оставить заявку',
  'получить расчет',
  'получить расчёт',
  'бесплатный замер',
  'заказать',
  'консультац',
  'позвон',
  'телефон',
  'контакты',
  'адрес',
  'политика конфиденциальности',
  'договор',
  'реквизиты',
  'скидк',
  'акци',
];

const normalizePath = (value: string) => value.replace(/\\/g, '/');

const normalizeText = (value: string) =>
  String(value || '')
    .trim()
    .toLowerCase();

const inferPreferredTarget = (frontmatter: FrontmatterLike | undefined): string | null => {
  if (!frontmatter) return null;
  const raw = normalizeText(
    [
      frontmatter.category,
      frontmatter.mainKeyword,
      frontmatter.geoTarget,
      frontmatter.title,
      ...(frontmatter.tags || []),
      ...(frontmatter.keywords || []),
    ].join(' ')
  );
  if (!raw) return null;
  if (raw.includes('кухн')) return '/kuhni';
  if (raw.includes('гардероб')) return '/garderobnye';
  if (raw.includes('шкаф')) return '/shkafy';
  return null;
};

const INFO_HINTS = ['гайд', 'совет', 'советы', 'инструкция', 'тренд', 'тренды', 'как выбрать', 'обзор', 'сравнение'];

const hasInfoHints = (raw: string) => INFO_HINTS.some((hint) => raw.includes(hint));

const inferCityTarget = (frontmatter: FrontmatterLike | undefined): string | null => {
  if (!frontmatter) return null;
  const raw = normalizeText(
    [
      frontmatter.category,
      frontmatter.mainKeyword,
      frontmatter.geoTarget,
      frontmatter.title,
      ...(frontmatter.tags || []),
      ...(frontmatter.keywords || []),
    ].join(' ')
  );
  if (!raw) return null;
  if (raw.includes('иркутск')) return '/contacts';
  return null;
};

const CLUSTER_TARGETS: Record<string, string[]> = {
  kitchen: [
    '/kuhni',
    '/projects/biruzovaya-uglovaya-kuhnya-irkutsk',
    '/projects/belaya-uglovaya-kuhnya-zagorodny-dom-irkutsk',
    '/projects/bezhevaya-uglovaya-kuhnya-irkutsk',
    '/projects/uglovaya-kuhnya-s-podsvetkoy-irkutsk',
    '/projects/pryamaya-kuhnya-s-vysokimi-penalami-irkutsk',
  ],
  storage: ['/shkafy', '/projects/vstroennyi-shkaf-s-rabochey-zonoy-irkutsk', '/projects/shkaf-kupe-na-vsyu-stenu-irkutsk'],
  wardrobe: ['/garderobnye', '/projects/garderobnaya-s-muzhskoy-i-zhenskoy-zonoy-irkutsk'],
  local: [],
};

const CLUSTER_LIMITS: Record<string, { total: number; perTarget: number }> = {
  kitchen: { total: 2, perTarget: 1 },
  storage: { total: 1, perTarget: 1 },
  wardrobe: { total: 1, perTarget: 1 },
  local: { total: 1, perTarget: 1 },
  info: { total: 1, perTarget: 1 },
};

const inferClusterId = (frontmatter: FrontmatterLike | undefined): string | null => {
  if (!frontmatter) return null;
  const raw = normalizeText(
    [
      frontmatter.category,
      frontmatter.mainKeyword,
      frontmatter.geoTarget,
      frontmatter.title,
      ...(frontmatter.tags || []),
      ...(frontmatter.keywords || []),
    ].join(' ')
  );
  if (!raw) return null;

  const preferred = inferPreferredTarget(frontmatter);
  if (preferred && hasInfoHints(raw)) return 'info';
  if (preferred === '/kuhni') return 'kitchen';
  if (preferred === '/shkafy') return 'storage';
  if (preferred === '/garderobnye') return 'wardrobe';
  if (raw.includes('иркутск') || raw.includes('город')) {
    return 'local';
  }
  return null;
};

const inferClusterTargets = (frontmatter: FrontmatterLike | undefined): string[] | null => {
  const clusterId = inferClusterId(frontmatter);
  return clusterId ? CLUSTER_TARGETS[clusterId] || null : null;
};

const isEligibleContentFile = (file: { path?: string; history?: string[] } | undefined) => {
  const rawPath = String(file?.path || file?.history?.[0] || '');
  if (!rawPath) return false;
  const normalized = normalizePath(rawPath);
  return normalized.includes('/src/content/articles/') || normalized.includes('/src/content/guides/');
};

const hasSkippableAncestor = (ancestors: AutoLinkNode[]) =>
  ancestors.some((node) => node.type === 'element' && node.tagName && SKIP_TAGS.has(String(node.tagName)));

const isAllowedContainer = (ancestors: AutoLinkNode[]) =>
  ancestors.some((node) => node.type === 'element' && node.tagName && ALLOWED_CONTAINER_TAGS.has(String(node.tagName)));

const buildAnchors = () =>
  AUTO_LINK_RULES.flatMap((rule) =>
    rule.anchors.map((anchor) => ({
      href: rule.href,
      anchor,
      anchorLower: anchor.toLowerCase(),
    }))
  ).sort((a, b) => b.anchor.length - a.anchor.length);

const anchors = buildAnchors();

const findNextMatch = (
  text: string,
  startIndex: number,
  state: AutoLinkState
): { index: number; length: number; href: string } | null => {
  const textLower = text.toLowerCase();
  let best: { index: number; length: number; href: string } | null = null;
  const preferredTarget = state.preferredTarget;
  const preferredAllowed = preferredTarget && (!state.allowedTargets || state.allowedTargets.has(preferredTarget));
  const preferredMatchExists = preferredAllowed
    ? anchors.some(
        (item) => item.href === preferredTarget && textLower.indexOf(item.anchorLower, startIndex) !== -1
      )
    : false;
  const shouldForcePreferred =
    preferredTarget &&
    preferredMatchExists &&
    (state.perTarget.get(preferredTarget) ?? 0) < state.maxLinksPerTarget;

  for (const item of anchors) {
    if (state.allowedTargets && !state.allowedTargets.has(item.href)) continue;
    if (shouldForcePreferred && item.href !== preferredTarget) continue;
    const usedCount = state.perTarget.get(item.href) ?? 0;
    if (usedCount >= state.maxLinksPerTarget) continue;
    const index = textLower.indexOf(item.anchorLower, startIndex);
    if (index === -1) continue;
    if (
      !best ||
      index < best.index ||
      (index === best.index && item.anchor.length > best.length)
    ) {
      best = { index, length: item.anchor.length, href: item.href };
    }
  }

  return best;
};

const linkifyText = (value: string, state: AutoLinkState): AutoLinkNode[] | null => {
  if (!value || state.total >= state.maxTotalLinks) return null;
  const lower = value.toLowerCase();
  if (BLACKLIST_PHRASES.some((phrase) => lower.includes(phrase))) return null;
  const nodes: AutoLinkNode[] = [];
  let cursor = 0;

  while (cursor < value.length && state.total < state.maxTotalLinks) {
    const match = findNextMatch(value, cursor, state);
    if (!match) break;

    if (match.index > cursor) {
      nodes.push({ type: 'text', value: value.slice(cursor, match.index) } satisfies AutoLinkTextNode);
    }

    const matchedText = value.slice(match.index, match.index + match.length);
    nodes.push(
      {
        type: 'element',
        tagName: 'a',
        properties: { href: match.href, 'data-auto-link': 'true' },
        children: [{ type: 'text', value: matchedText }],
      } satisfies AutoLinkElementNode
    );

    state.total += 1;
    state.perTarget.set(match.href, (state.perTarget.get(match.href) ?? 0) + 1);
    cursor = match.index + match.length;
  }

  if (cursor < value.length) {
    nodes.push({ type: 'text', value: value.slice(cursor) } satisfies AutoLinkTextNode);
  }

  return nodes.length > 0 ? nodes : null;
};

export const autoInternalLinksRehypePlugin: RehypePlugin = () => {
  return function (tree, file) {
    if (!tree?.children || !isEligibleContentFile(file)) return;

    const frontmatter = (file as { data?: { astro?: { frontmatter?: FrontmatterLike } } })?.data?.astro?.frontmatter;
    const clusterId = inferClusterId(frontmatter);
    const preferredTargetBase = inferPreferredTarget(frontmatter);
    const cityTarget = inferCityTarget(frontmatter);
    const preferredTarget = clusterId === 'local' ? cityTarget : preferredTargetBase;
    const clusterTargets =
      clusterId === 'info' && preferredTarget ? [preferredTarget] : inferClusterTargets(frontmatter);
    const allowedTargets = clusterTargets ? new Set(clusterTargets) : null;
    const clusterLimits = clusterId ? CLUSTER_LIMITS[clusterId] : null;
    const maxLinksPerTarget = clusterLimits?.perTarget ?? MAX_LINKS_PER_TARGET;
    const maxTotalLinks = clusterLimits?.total ?? MAX_TOTAL_LINKS;
    const state: AutoLinkState = {
      total: 0,
      perTarget: new Map(),
      preferredTarget,
      allowedTargets: allowedTargets || undefined,
      maxLinksPerTarget,
      maxTotalLinks,
      paragraphCount: 0,
      hasPassedFirstHeading: false,
    };

    const walk = (node: AutoLinkNode, ancestors: AutoLinkNode[], paragraphIndex: number) => {
      if (!node?.children || !Array.isArray(node.children)) return;

      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (!child) continue;

        if (child.type === 'text') {
          if (hasSkippableAncestor(ancestors)) continue;
          if (!isAllowedContainer(ancestors)) continue;
          if (!state.hasPassedFirstHeading) continue;
          if (paragraphIndex < 1 || paragraphIndex > MAX_LINKED_PARAGRAPHS) continue;
          const replacement = linkifyText(String(child.value || ''), state);
          if (replacement) {
            node.children.splice(i, 1, ...replacement);
            i += replacement.length - 1;
          }
          continue;
        }

        if (child.type === 'element') {
          let nextParagraphIndex = paragraphIndex;
          const tagName = String(child.tagName || '');
          if (/^h[2-6]$/.test(tagName)) {
            state.hasPassedFirstHeading = true;
            state.paragraphCount = 0;
          }
          if (tagName === 'p') {
            if (state.hasPassedFirstHeading) {
              state.paragraphCount += 1;
              nextParagraphIndex = state.paragraphCount;
            } else {
              nextParagraphIndex = 0;
            }
          }
          walk(child, [...ancestors, child], nextParagraphIndex);
          continue;
        }

        walk(child, ancestors, paragraphIndex);
      }
    };

    walk(tree, [], 0);
  };
};
