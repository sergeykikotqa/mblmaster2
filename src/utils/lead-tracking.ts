type PageType =
  | 'home'
  | 'service-money'
  | 'city-hub'
  | 'projects'
  | 'guides'
  | 'articles'
  | 'faq'
  | 'contacts'
  | 'about'
  | 'other';

interface LeadAttribution {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_term: string;
  utm_content: string;
  landingPath: string;
  currentPath: string;
  firstReferrer: string;
  deviceType: 'mobile' | 'tablet' | 'desktop';
  submittedAt: string;
}

declare global {
  interface Window {
    ym?: (id: number, action: string, target: string, params?: Record<string, unknown>) => void;
    gtag?: (...args: unknown[]) => void;
    __leadTrackingInit?: boolean;
  }
}

const STORAGE_KEYS = {
  source: 'lead_utm_source',
  medium: 'lead_utm_medium',
  campaign: 'lead_utm_campaign',
  term: 'lead_utm_term',
  content: 'lead_utm_content',
  landingPath: 'lead_landing_path',
  firstReferrer: 'lead_first_referrer',
} as const;

const ENABLED = String(import.meta.env.PUBLIC_ENABLE_LEAD_TRACKING ?? 'true') !== 'false';
const YANDEX_ID = Number(import.meta.env.PUBLIC_YANDEX_METRIKA_ID || 0);

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function getDeviceType(): 'mobile' | 'tablet' | 'desktop' {
  if (!isBrowser()) return 'desktop';
  const width = Math.min(window.innerWidth || 1280, window.screen?.width || 1280);
  if (width < 768) return 'mobile';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

function readStorage(key: string, fallback: string): string {
  if (!isBrowser()) return fallback;
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: string) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function ensureFirstTouch() {
  if (!isBrowser()) return;

  const params = new URLSearchParams(window.location.search);
  const hasStoredLanding = readStorage(STORAGE_KEYS.landingPath, '');

  if (!hasStoredLanding) {
    const firstLanding = window.location.pathname + window.location.search;
    writeStorage(STORAGE_KEYS.landingPath, firstLanding || '/');
  }

  const firstRef = readStorage(STORAGE_KEYS.firstReferrer, '');
  if (!firstRef) {
    const ref = document.referrer && document.referrer.trim() ? document.referrer : '(direct)';
    writeStorage(STORAGE_KEYS.firstReferrer, ref);
  }

  const mappings: Array<[keyof typeof STORAGE_KEYS, string, string]> = [
    ['source', 'utm_source', '(direct)'],
    ['medium', 'utm_medium', '(none)'],
    ['campaign', 'utm_campaign', '(none)'],
    ['term', 'utm_term', '(none)'],
    ['content', 'utm_content', '(none)'],
  ];

  for (const [storageKey, queryKey, fallback] of mappings) {
    const current = readStorage(STORAGE_KEYS[storageKey], '');
    if (!current) {
      writeStorage(STORAGE_KEYS[storageKey], params.get(queryKey)?.trim() || fallback);
    }
  }
}

export function resolvePageType(pathname?: string): PageType {
  const path =
    String(pathname || (isBrowser() ? window.location.pathname : '/'))
      .toLowerCase()
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '') || '/';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const moneyPaths = new Set(['/kuhni', '/shkafy', '/garderobnye', '/kuhni-3-metra']);
  const cityHubPaths = new Set(['/irkutsk']);

  if (normalizedPath === '/') return 'home';
  if (moneyPaths.has(normalizedPath)) return 'service-money';
  if (cityHubPaths.has(normalizedPath)) return 'city-hub';
  if (normalizedPath === '/projects' || normalizedPath.startsWith('/projects/')) return 'projects';
  if (normalizedPath === '/guides' || normalizedPath.startsWith('/guides/')) return 'guides';
  if (normalizedPath === '/articles' || normalizedPath.startsWith('/articles/')) return 'articles';
  if (normalizedPath === '/faq' || normalizedPath.startsWith('/faq/')) return 'faq';
  if (normalizedPath.startsWith('/contacts')) return 'contacts';
  if (normalizedPath.startsWith('/o-kompanii')) return 'about';
  return 'other';
}

function trackYandexGoal(goal: string, params: Record<string, unknown>) {
  if (!ENABLED || !isBrowser() || !YANDEX_ID || typeof window.ym !== 'function') return;
  window.ym(YANDEX_ID, 'reachGoal', goal, params);
}

function trackGAEvent(name: string, params: Record<string, unknown>) {
  if (!ENABLED || !isBrowser() || typeof window.gtag !== 'function') return;
  window.gtag('event', name, params);
}

export function getLeadAttribution(): LeadAttribution {
  ensureFirstTouch();
  const currentPath = isBrowser() ? window.location.pathname + window.location.search : '/';
  return {
    utm_source: readStorage(STORAGE_KEYS.source, '(direct)'),
    utm_medium: readStorage(STORAGE_KEYS.medium, '(none)'),
    utm_campaign: readStorage(STORAGE_KEYS.campaign, '(none)'),
    utm_term: readStorage(STORAGE_KEYS.term, '(none)'),
    utm_content: readStorage(STORAGE_KEYS.content, '(none)'),
    landingPath: readStorage(STORAGE_KEYS.landingPath, '/'),
    currentPath,
    firstReferrer: readStorage(STORAGE_KEYS.firstReferrer, '(direct)'),
    deviceType: getDeviceType(),
    submittedAt: new Date().toISOString(),
  };
}

export function trackLeadStart(formId: string, pageType: PageType) {
  const params = { form_id: formId, page_type: pageType };
  trackGAEvent('contact', params);
}

export function trackLeadSuccess(formId: string, pageType: PageType, leadId?: string) {
  const params = { form_id: formId, page_type: pageType, lead_id: leadId || '' };
  trackYandexGoal('lead_submit_success', params);
  trackGAEvent('generate_lead', params);
  trackGAEvent('lead_submit_success', params);
}

export function trackLeadError(formId: string, pageType: PageType, reason: string) {
  const params = { form_id: formId, page_type: pageType, reason };
  trackYandexGoal('lead_submit_error', params);
  trackGAEvent('lead_submit_error', params);
}

export function trackCallClick(phone: string, placement: string) {
  const params = { phone, placement };
  trackYandexGoal('call_click', params);
  trackGAEvent('click_call', params);
}

export function initLeadTracking() {
  if (!isBrowser() || window.__leadTrackingInit) return;
  window.__leadTrackingInit = true;

  ensureFirstTouch();

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const link = target.closest('a[href^="tel:"]') as HTMLAnchorElement | null;
      if (!link) return;

      const rawPhone = (link.getAttribute('href') || '').replace(/^tel:/, '');
      const placement =
        link.dataset.ctaPlacement ||
        link.closest('[data-cta-placement]')?.getAttribute('data-cta-placement') ||
        'section';
      trackCallClick(rawPhone, placement);
    },
    { capture: true }
  );
}
