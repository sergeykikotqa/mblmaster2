(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (document.documentElement?.dataset?.e2e === 'true') return;

  const init = () => {
    const banner = document.getElementById('analytics-consent-banner');
    if (!(banner instanceof HTMLElement)) return;

    const consent = window.__analyticsConsent;
    if (!consent || typeof consent.getState !== 'function' || typeof consent.setState !== 'function') return;

    const acceptButton = banner.querySelector('[data-analytics-consent="accept"]');
    const declineButton = banner.querySelector('[data-analytics-consent="decline"]');

    let revealTimer = null;

    function revealBanner() {
      revealTimer = null;
      banner.classList.remove('hidden');
    }

    function scheduleReveal() {
      if (revealTimer) return;
      if (typeof window.requestIdleCallback === 'function') {
        revealTimer = window.requestIdleCallback(revealBanner, { timeout: 2000 });
      } else {
        revealTimer = window.setTimeout(revealBanner, 1800);
      }
    }

    function syncVisibility() {
      const state = consent.getState();
      if (state === 'granted' || state === 'denied') {
        banner.classList.add('hidden');
        if (revealTimer && typeof window.cancelIdleCallback === 'function') {
          window.cancelIdleCallback(revealTimer);
        } else if (revealTimer) {
          clearTimeout(revealTimer);
        }
        revealTimer = null;
        return;
      }
      scheduleReveal();
    }

    acceptButton?.addEventListener('click', () => {
      consent.setState('granted');
      syncVisibility();
    });

    declineButton?.addEventListener('click', () => {
      consent.setState('denied');
      syncVisibility();
    });

    window.addEventListener('analytics-consent-change', syncVisibility);
    syncVisibility();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
