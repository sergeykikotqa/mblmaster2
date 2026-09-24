(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const scriptEl = document.currentScript || document.querySelector('script[data-google-analytics-id]');
  const analyticsId = String(scriptEl?.getAttribute('data-google-analytics-id') || '').trim();
  if (!analyticsId) return;

  const disableKey = `ga-disable-${analyticsId}`;
  let initialized = false;

  function hasConsent() {
    return Boolean(window.__analyticsConsent?.hasConsent?.());
  }

  function gtag() {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(arguments);
  }

  function ensureLoader() {
    const selector = `script[data-mbl-google-analytics="${analyticsId}"]`;
    if (document.querySelector(selector)) return;
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(analyticsId)}`;
    script.dataset.mblGoogleAnalytics = analyticsId;
    document.head.appendChild(script);
  }

  function loadAnalytics() {
    if (!hasConsent()) return;
    window[disableKey] = false;
    window.gtag = window.gtag || gtag;
    if (initialized) {
      window.gtag('consent', 'update', { analytics_storage: 'granted' });
      return;
    }
    initialized = true;
    window.gtag('consent', 'default', { analytics_storage: 'granted' });
    window.gtag('js', new Date());
    window.gtag('config', analyticsId);
    ensureLoader();
  }

  function disableAnalytics() {
    window[disableKey] = true;
    if (typeof window.gtag === 'function') {
      window.gtag('consent', 'update', { analytics_storage: 'denied' });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAnalytics, { once: true });
  } else {
    loadAnalytics();
  }

  window.addEventListener('analytics-consent-change', (event) => {
    if (event?.detail?.state === 'granted') loadAnalytics();
    if (event?.detail?.state === 'denied') disableAnalytics();
  });
})();
