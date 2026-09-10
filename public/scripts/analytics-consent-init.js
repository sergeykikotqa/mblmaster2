(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__analyticsConsent && typeof window.__analyticsConsent.setState === 'function') return;

  const script =
    document.currentScript ||
    document.querySelector('script[data-analytics-consent-init]');
  const cookieName = String(script?.getAttribute('data-cookie-name') || 'site_analytics_consent');
  const maxAgeDays = Number(script?.getAttribute('data-max-age-days') || 180);
  const maxAgeSec = Math.max(1, Math.floor(maxAgeDays * 24 * 60 * 60));

  function readCookieState() {
    const cookie = String(document.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`));
    if (!cookie) return 'unknown';
    const value = decodeURIComponent(cookie.slice(cookieName.length + 1))
      .trim()
      .toLowerCase();
    return value === 'granted' || value === 'denied' ? value : 'unknown';
  }

  function setCookieState(state) {
    document.cookie = `${cookieName}=${encodeURIComponent(state)}; path=/; max-age=${maxAgeSec}; SameSite=Lax`;
  }

  window.__analyticsConsent = {
    cookieName,
    maxAgeDays,
    getState: readCookieState,
    hasConsent: function hasConsent() {
      return readCookieState() === 'granted';
    },
    setState: function setState(nextState) {
      const normalized = String(nextState || '')
        .trim()
        .toLowerCase();
      if (normalized !== 'granted' && normalized !== 'denied') return;
      setCookieState(normalized);
      window.dispatchEvent(
        new CustomEvent('analytics-consent-change', {
          detail: {
            state: normalized,
            cookieName,
          },
        })
      );
    },
  };
})();
