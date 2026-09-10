(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const script =
    document.currentScript ||
    document.querySelector('script[data-lead-tracking-init]');
  const rawConfig = script?.getAttribute('data-lead-tracking-config') || '';
  const turnstileSiteKey = String(script?.getAttribute('data-turnstile-site-key') || '').trim();

  let leadTrackingConfig = {};
  if (rawConfig) {
    try {
      leadTrackingConfig = JSON.parse(rawConfig);
    } catch {
      leadTrackingConfig = {};
    }
  }

  window.__LEAD_TRACKING_CONFIG = leadTrackingConfig;

  const hasContactForm = Boolean(document.querySelector('form.lead-contact-form'));
  const hasLeadSignals =
    hasContactForm || Boolean(document.querySelector('[data-cta], [data-open-form], a[href^="tel:"]'));

  const loadScript = (src, attrs) =>
    new Promise((resolve) => {
      const scriptEl = document.createElement('script');
      scriptEl.src = src;
      if (attrs && typeof attrs === 'object') {
        Object.entries(attrs).forEach(([key, value]) => {
          if (value === true) {
            scriptEl.setAttribute(key, '');
          } else if (value) {
            scriptEl.setAttribute(key, String(value));
          }
        });
      }
      scriptEl.onload = resolve;
      scriptEl.onerror = resolve;
      document.head.appendChild(scriptEl);
    });

  let leadPromise = Promise.resolve();
  if (hasLeadSignals) {
    leadPromise = loadScript('/scripts/lead-tracking-client.js', { defer: true });
  }

  if (hasContactForm) {
    if (turnstileSiteKey) {
      loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js', { async: true, defer: true });
    }
    leadPromise.then(() => loadScript('/scripts/contact-form-client.js', { defer: true }));
  }
})();
