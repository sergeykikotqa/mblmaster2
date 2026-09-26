(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const scriptEl = document.currentScript || document.querySelector('script[data-metrika-id]');
  const metrikaId = Number(scriptEl?.getAttribute('data-metrika-id') || 0);
  if (!metrikaId) return;

  let initialized = false;
  const scriptSrc = 'https://mc.yandex.ru/metrika/tag.js';

  function hasConsent() {
    return Boolean(
      window.__analyticsConsent &&
      typeof window.__analyticsConsent.hasConsent === 'function' &&
      window.__analyticsConsent.hasConsent()
    );
  }

  function ensureLoader() {
    if (document.querySelector('script[src="' + scriptSrc + '"]')) return;
    const script = document.createElement('script');
    script.async = true;
    script.src = scriptSrc;
    script.dataset.mblAnalyticsProvider = 'yandex';
    const firstScript = document.getElementsByTagName('script')[0];
    if (firstScript && firstScript.parentNode) {
      firstScript.parentNode.insertBefore(script, firstScript);
      return;
    }
    document.head.appendChild(script);
  }

  function loadMetrika() {
    if (initialized || !hasConsent()) return;
    initialized = true;
    window.ym =
      window.ym ||
      function () {
        (window.ym.a = window.ym.a || []).push(arguments);
      };
    window.ym.l = Date.now();
    ensureLoader();
    window.ym(metrikaId, 'init', {
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
      webvisor: true,
    });
  }

  function disableMetrika() {
    if (!initialized) return;
    if (typeof window.ym === 'function') {
      window.ym(metrikaId, 'destruct');
    }
    initialized = false;
    document.querySelector('script[data-mbl-analytics-provider="yandex"]')?.remove();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadMetrika, { once: true });
  } else {
    loadMetrika();
  }

  window.addEventListener('analytics-consent-change', (event) => {
    if (event && event.detail && event.detail.state === 'granted') {
      loadMetrika();
    }
    if (event && event.detail && event.detail.state === 'denied') {
      disableMetrika();
    }
  });
})();
