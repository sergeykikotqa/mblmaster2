type PageType =
  'home' | 'service-money' | 'city-hub' | 'projects' | 'guides' | 'articles' | 'faq' | 'contacts' | 'about' | 'other';

interface LeadAttribution {
  deviceType: 'mobile' | 'tablet' | 'desktop';
}

declare global {
  interface Window {
    ym?: (id: number, action: string, target: string, params?: Record<string, unknown>) => void;
    __leadTrackingInit?: boolean;
  }
}

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

export function resolvePageType(pathname?: string): PageType {
  const path =
    String(pathname || (isBrowser() ? window.location.pathname : '/'))
      .toLowerCase()
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '') || '/';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const moneyPaths = new Set(['/kuhni', '/shkafy', '/garderobnye', '/kuhni-3-metra']);

  if (normalizedPath === '/') return 'home';
  if (moneyPaths.has(normalizedPath)) return 'service-money';
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
  if (!document.cookie.split(';').some((part) => part.trim() === 'site_analytics_consent=granted')) return;
  window.ym(YANDEX_ID, 'reachGoal', goal, params);
}

export function getLeadAttribution(): LeadAttribution {
  return { deviceType: getDeviceType() };
}

export function trackLeadStart(formId: string, pageType: PageType) {
  trackYandexGoal('form_opened', { form_id: formId, page_type: pageType });
}

export function trackLeadSuccess(formId: string, pageType: PageType) {
  const params = { form_id: formId, page_type: pageType };
  trackYandexGoal('form_submitted', params);
}

export function trackLeadError(formId: string, pageType: PageType, reason: string) {
  // Error diagnostics stay internal; no per-attempt data is sent to external analytics.
  void formId;
  void pageType;
  void reason;
}

export function trackCallClick(_phone: string, placement: string) {
  const params = { placement };
  trackYandexGoal('cta_click', params);
}

export function initLeadTracking() {
  if (!isBrowser() || window.__leadTrackingInit) return;
  window.__leadTrackingInit = true;

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
