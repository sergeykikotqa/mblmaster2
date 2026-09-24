(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const cfg = window.__LEAD_TRACKING_CONFIG || {};
  const enabled = String(cfg.enabled ?? 'true') !== 'false';
  const yandexId = Number(cfg.yandexMetrikaId || 0);
  const formAbandonMs = Number.isFinite(Number(cfg.formAbandonMs)) ? Math.max(1000, Number(cfg.formAbandonMs)) : 60000;
  const consentRequired = String(cfg.analyticsConsentRequired ?? 'false') === 'true';
  const analyticsConsentCookieName = String(cfg.analyticsConsentCookieName || 'site_analytics_consent');
  const scrollDepthSteps = [25, 50, 75, 100];
  const formSessions = new Map();
  let pageViewSent = false;

  const storageKeys = {
    source: 'lead_utm_source',
    medium: 'lead_utm_medium',
    campaign: 'lead_utm_campaign',
    term: 'lead_utm_term',
    content: 'lead_utm_content',
    landingPath: 'lead_landing_path',
    firstReferrer: 'lead_first_referrer',
  };

  function readCookieValue(cookieName) {
    const cookie = String(document.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`));
    return cookie ? decodeURIComponent(cookie.slice(cookieName.length + 1)) : '';
  }

  function resolveConsentState() {
    const consent = window.__analyticsConsent;
    if (consent && typeof consent.getState === 'function') {
      return String(consent.getState() || '')
        .trim()
        .toLowerCase();
    }
    return String(readCookieValue(analyticsConsentCookieName) || '')
      .trim()
      .toLowerCase();
  }

  function hasAnalyticsConsent() {
    if (!consentRequired) return true;
    return resolveConsentState() === 'granted';
  }

  function canTrack() {
    return enabled && hasAnalyticsConsent();
  }

  function canTrackOps() {
    return canTrack();
  }

  function getSafeLeadAttribution() {
    return {
      utm_source: '(direct)',
      utm_medium: '(none)',
      utm_campaign: '(none)',
      utm_term: '(none)',
      utm_content: '(none)',
      landingPath: window.location.pathname + window.location.search || '/',
      currentPath: window.location.pathname + window.location.search,
      firstReferrer: document.referrer && document.referrer.trim() ? document.referrer : '(direct)',
      deviceType: getDeviceType(),
      submittedAt: new Date().toISOString(),
    };
  }

  function compactPayload(payload) {
    const clean = {};
    if (!payload || typeof payload !== 'object') return clean;

    Object.entries(payload).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (typeof value === 'string' && !value.trim()) return;
      clean[key] = value;
    });

    return clean;
  }

  function readStorage(key, fallback) {
    try {
      return window.localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // noop
    }
  }

  function ensureFirstTouch() {
    if (!canTrack()) return;
    const params = new URLSearchParams(window.location.search);
    if (!readStorage(storageKeys.landingPath, '')) {
      writeStorage(storageKeys.landingPath, window.location.pathname + window.location.search || '/');
    }
    if (!readStorage(storageKeys.firstReferrer, '')) {
      const ref = document.referrer && document.referrer.trim() ? document.referrer : '(direct)';
      writeStorage(storageKeys.firstReferrer, ref);
    }

    const mappings = [
      ['source', 'utm_source', '(direct)'],
      ['medium', 'utm_medium', '(none)'],
      ['campaign', 'utm_campaign', '(none)'],
      ['term', 'utm_term', '(none)'],
      ['content', 'utm_content', '(none)'],
    ];
    mappings.forEach(([storageKey, queryKey, fallback]) => {
      const storageToken = storageKeys[storageKey];
      if (!readStorage(storageToken, '')) {
        writeStorage(storageToken, params.get(queryKey) || fallback);
      }
    });
  }

  function resolvePageType(pathname) {
    const path =
      String(pathname || window.location.pathname || '/')
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

  function getDeviceType() {
    const width = Math.min(window.innerWidth || 1280, (window.screen && window.screen.width) || 1280);
    if (width < 768) return 'mobile';
    if (width < 1024) return 'tablet';
    return 'desktop';
  }

  function getLeadAttribution() {
    if (!canTrack()) {
      return getSafeLeadAttribution();
    }
    ensureFirstTouch();
    return {
      utm_source: readStorage(storageKeys.source, '(direct)'),
      utm_medium: readStorage(storageKeys.medium, '(none)'),
      utm_campaign: readStorage(storageKeys.campaign, '(none)'),
      utm_term: readStorage(storageKeys.term, '(none)'),
      utm_content: readStorage(storageKeys.content, '(none)'),
      landingPath: readStorage(storageKeys.landingPath, '/'),
      currentPath: window.location.pathname + window.location.search,
      firstReferrer: readStorage(storageKeys.firstReferrer, '(direct)'),
      deviceType: getDeviceType(),
      submittedAt: new Date().toISOString(),
    };
  }

  function pushDataLayer(eventName, payload) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(Object.assign({ event: eventName }, payload || {}));
  }

  function sendOptionalTrack(eventName, payload, options) {
    const forceOps = Boolean(options && options.forceOps);
    if (forceOps ? !canTrackOps() : !canTrack()) return;
    if (!cfg.trackEndpoint) return;

    const body = JSON.stringify({
      event: eventName,
      payload: compactPayload(payload),
      page: window.location.pathname + window.location.search,
      sentAt: new Date().toISOString(),
      channel: forceOps ? 'ops' : 'marketing',
    });

    let sentViaBeacon = false;

    if (typeof navigator.sendBeacon === 'function') {
      try {
        const data =
          typeof Blob === 'function'
            ? new Blob([body], {
                type: 'application/json',
              })
            : body;
        sentViaBeacon = navigator.sendBeacon(cfg.trackEndpoint, data);
      } catch {
        sentViaBeacon = false;
      }
    }

    if (!sentViaBeacon && typeof fetch === 'function') {
      void fetch(cfg.trackEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {
        // noop
      });
    }
  }

  function trackYandexGoal(goal, params) {
    if (!canTrack()) return;
    if (!yandexId || typeof window.ym !== 'function') return;
    window.ym(yandexId, 'reachGoal', goal, params || {});
  }

  function trackGAEvent(name, params) {
    if (!canTrack()) return;
    if (typeof window.gtag !== 'function') return;
    window.gtag('event', name, params || {});
  }

  function emit(eventName, params) {
    if (!canTrack()) return;
    const payload = compactPayload(params);
    pushDataLayer(eventName, payload);
    sendOptionalTrack(eventName, payload);
  }

  function emitOps(eventName, params) {
    if (!canTrackOps()) return;
    const payload = compactPayload(params);
    if (canTrack()) {
      pushDataLayer(eventName, payload);
    }
    sendOptionalTrack(eventName, payload, { forceOps: true });
  }

  function toIso(timestampMs) {
    return timestampMs ? new Date(timestampMs).toISOString() : '';
  }

  function createSessionId(prefix) {
    const safePrefix = String(prefix || 'session').replace(/[^a-zA-Z0-9_-]/g, '-');
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return `${safePrefix}-${window.crypto.randomUUID()}`;
    }
    return `${safePrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function formSessionKey(formId, pageType) {
    return `${String(formId || 'section')}::${String(pageType || 'other')}`;
  }

  function readFormHiddenValue(form, fieldName) {
    if (!(form instanceof HTMLFormElement)) return '';
    const input = form.querySelector(`input[name="${fieldName}"]`);
    if (!(input instanceof HTMLInputElement)) return '';
    return String(input.value || '').trim();
  }

  function getOrCreateFormSession(formId, pageType, placement) {
    const key = formSessionKey(formId, pageType);
    if (!formSessions.has(key)) {
      formSessions.set(key, {
        key,
        formId,
        pageType,
        placement: placement || 'section',
        viewed: false,
        focused: false,
        firstInputFocused: false,
        opened: false,
        started: false,
        progressed: false,
        phoneValid: false,
        submitted: false,
        abandoned: false,
        openedAtMs: 0,
        openId: '',
        abandonTimer: 0,
      });
    }
    return formSessions.get(key);
  }

  function ensureOpenId(session) {
    if (!session.openId) {
      session.openId = createSessionId(`${session.formId}-open`);
    }
    return session.openId;
  }

  function clearAbandonTimer(session) {
    if (session.abandonTimer) {
      clearTimeout(session.abandonTimer);
      session.abandonTimer = 0;
    }
  }

  function emitFormAbandoned(session, reason) {
    if (!session || session.abandoned || session.submitted || !session.opened) return;
    session.abandoned = true;
    clearAbandonTimer(session);
    emitOps('form_abandoned', {
      form_id: session.formId,
      page_type: session.pageType,
      placement: session.placement,
      open_id: ensureOpenId(session),
      opened_at: toIso(session.openedAtMs),
      elapsed_ms: Math.max(0, Date.now() - session.openedAtMs),
      reason: reason || 'timeout',
    });
  }

  function scheduleFormAbandon(session) {
    clearAbandonTimer(session);
    session.abandonTimer = window.setTimeout(() => {
      emitFormAbandoned(session, 'timeout');
    }, formAbandonMs);
  }

  function markFormSubmitted(formId, pageType) {
    const session = formSessions.get(formSessionKey(formId, pageType));
    if (!session) return;
    session.submitted = true;
    session.abandoned = false;
    clearAbandonTimer(session);
  }

  function trackFormOpened(formId, pageType, placement, meta) {
    if (!canTrackOps()) return null;
    const session = getOrCreateFormSession(formId, pageType, placement);
    session.placement = placement || session.placement || 'section';

    if (session.opened) return session;

    session.opened = true;
    session.openedAtMs = Date.now();
    session.submitted = false;
    session.abandoned = false;

    emitOps('form_opened', {
      form_id: session.formId,
      page_type: session.pageType,
      placement: session.placement,
      open_id: ensureOpenId(session),
      opened_at: toIso(session.openedAtMs),
      trigger: (meta && meta.trigger) || 'interaction',
      city: (meta && meta.city) || '',
      district: (meta && meta.district) || '',
      service: (meta && meta.service) || '',
      page_slug: (meta && meta.page_slug) || '',
      lead_page_type: (meta && meta.lead_page_type) || '',
    });

    scheduleFormAbandon(session);
    return session;
  }

  function trackFormView(formId, pageType, placement, meta) {
    if (!canTrackOps()) return null;
    const session = getOrCreateFormSession(formId, pageType, placement);
    session.placement = placement || session.placement || 'section';
    if (session.viewed) return session;
    session.viewed = true;
    emitOps('form_view', {
      form_id: session.formId,
      page_type: session.pageType,
      placement: session.placement,
      trigger: (meta && meta.trigger) || 'viewport',
      city: (meta && meta.city) || '',
      district: (meta && meta.district) || '',
      service: (meta && meta.service) || '',
      page_slug: (meta && meta.page_slug) || '',
      lead_page_type: (meta && meta.lead_page_type) || '',
    });
    return session;
  }

  function trackFormFocus(formId, pageType, placement, meta) {
    if (!canTrackOps()) return null;
    const session = trackFormOpened(formId, pageType, placement, { trigger: 'focus' });
    if (!session || session.focused) return session;
    session.focused = true;
    emitOps('form_focus', {
      form_id: session.formId,
      page_type: session.pageType,
      placement: session.placement,
      open_id: ensureOpenId(session),
      opened_at: toIso(session.openedAtMs),
      trigger: (meta && meta.trigger) || 'focus',
      field_name: (meta && meta.field_name) || '',
      input_type: (meta && meta.input_type) || '',
      city: (meta && meta.city) || '',
      district: (meta && meta.district) || '',
      service: (meta && meta.service) || '',
      page_slug: (meta && meta.page_slug) || '',
      lead_page_type: (meta && meta.lead_page_type) || '',
    });
    return session;
  }

  function trackFormFirstInputFocus(formId, pageType, placement, meta) {
    if (!canTrackOps()) return null;
    const session = trackFormOpened(formId, pageType, placement, { trigger: 'first_input_focus' });
    if (!session || session.firstInputFocused) return session;
    session.firstInputFocused = true;
    emitOps('form_first_input_focus', {
      form_id: session.formId,
      page_type: session.pageType,
      placement: session.placement,
      open_id: ensureOpenId(session),
      opened_at: toIso(session.openedAtMs),
      trigger: (meta && meta.trigger) || 'focus',
      city: (meta && meta.city) || '',
      district: (meta && meta.district) || '',
      service: (meta && meta.service) || '',
      page_slug: (meta && meta.page_slug) || '',
      lead_page_type: (meta && meta.lead_page_type) || '',
    });
    return session;
  }

  function trackFormStart(formId, pageType, placement, meta) {
    if (!canTrackOps()) return null;
    const session = trackFormOpened(formId, pageType, placement, { trigger: 'start' });
    if (!session || session.started) return session;
    session.started = true;
    emitOps('form_start', {
      form_id: session.formId,
      page_type: session.pageType,
      placement: session.placement,
      open_id: ensureOpenId(session),
      opened_at: toIso(session.openedAtMs),
      trigger: (meta && meta.trigger) || 'input',
      field_name: (meta && meta.field_name) || '',
      input_type: (meta && meta.input_type) || '',
      city: (meta && meta.city) || '',
      district: (meta && meta.district) || '',
      service: (meta && meta.service) || '',
      page_slug: (meta && meta.page_slug) || '',
      lead_page_type: (meta && meta.lead_page_type) || '',
    });
    return session;
  }

  function trackFormProgress(formId, pageType, placement, meta) {
    if (!canTrackOps()) return null;
    const session = trackFormOpened(formId, pageType, placement, { trigger: 'progress' });
    if (!session || session.progressed) return session;
    session.progressed = true;
    emitOps('form_progress', {
      form_id: session.formId,
      page_type: session.pageType,
      placement: session.placement,
      open_id: ensureOpenId(session),
      opened_at: toIso(session.openedAtMs),
      trigger: (meta && meta.trigger) || 'input',
      field_name: (meta && meta.field_name) || '',
      input_type: (meta && meta.input_type) || '',
      progress_reason: (meta && meta.progress_reason) || '',
      city: (meta && meta.city) || '',
      district: (meta && meta.district) || '',
      service: (meta && meta.service) || '',
      page_slug: (meta && meta.page_slug) || '',
      lead_page_type: (meta && meta.lead_page_type) || '',
    });
    return session;
  }

  function trackFormPhoneValid(formId, pageType, placement, meta) {
    if (!canTrackOps()) return null;
    const session = trackFormOpened(formId, pageType, placement, { trigger: 'phone_valid' });
    if (!session || session.phoneValid) return session;
    session.phoneValid = true;
    emitOps('form_phone_valid', {
      form_id: session.formId,
      page_type: session.pageType,
      placement: session.placement,
      open_id: ensureOpenId(session),
      opened_at: toIso(session.openedAtMs),
      trigger: (meta && meta.trigger) || 'phone',
      field_name: (meta && meta.field_name) || 'phone',
      city: (meta && meta.city) || '',
      district: (meta && meta.district) || '',
      service: (meta && meta.service) || '',
      page_slug: (meta && meta.page_slug) || '',
      lead_page_type: (meta && meta.lead_page_type) || '',
    });
    return session;
  }

  function trackFormSubmitAttempt(formId, pageType, placement, meta) {
    if (!canTrackOps()) return null;
    const session = trackFormOpened(formId, pageType, placement, { trigger: 'submit_attempt' });
    if (!session) return null;
    emitOps('form_submit_attempt', {
      form_id: session.formId,
      page_type: session.pageType,
      placement: session.placement,
      open_id: ensureOpenId(session),
      opened_at: toIso(session.openedAtMs),
      reason: (meta && meta.reason) || '',
      city: (meta && meta.city) || '',
      district: (meta && meta.district) || '',
      service: (meta && meta.service) || '',
      page_slug: (meta && meta.page_slug) || '',
      lead_page_type: (meta && meta.lead_page_type) || '',
    });
    return session;
  }

  function trackFormValidationError(formId, pageType, placement, meta) {
    if (!canTrackOps()) return null;
    const session = trackFormOpened(formId, pageType, placement, { trigger: 'validation_error' });
    if (!session) return null;
    emitOps('form_validation_error', {
      form_id: session.formId,
      page_type: session.pageType,
      placement: session.placement,
      open_id: ensureOpenId(session),
      opened_at: toIso(session.openedAtMs),
      reason: (meta && meta.reason) || '',
      field_name: (meta && meta.field_name) || '',
      city: (meta && meta.city) || '',
      district: (meta && meta.district) || '',
      service: (meta && meta.service) || '',
      page_slug: (meta && meta.page_slug) || '',
      lead_page_type: (meta && meta.lead_page_type) || '',
    });
    return session;
  }

  function trackFormSubmitBlocked(formId, pageType, placement, meta) {
    if (!canTrackOps()) return null;
    const session = trackFormOpened(formId, pageType, placement, { trigger: 'submit_blocked' });
    if (!session) return null;
    emitOps('form_submit_blocked', {
      form_id: session.formId,
      page_type: session.pageType,
      placement: session.placement,
      open_id: ensureOpenId(session),
      opened_at: toIso(session.openedAtMs),
      reason: (meta && meta.reason) || '',
      city: (meta && meta.city) || '',
      district: (meta && meta.district) || '',
      service: (meta && meta.service) || '',
      page_slug: (meta && meta.page_slug) || '',
      lead_page_type: (meta && meta.lead_page_type) || '',
    });
    return session;
  }

  function trackFormAbandoned(formId, pageType, placement, reason) {
    if (!canTrackOps()) return;
    const session = getOrCreateFormSession(formId, pageType, placement);
    emitFormAbandoned(session, reason || 'manual');
  }

  function getFormSessionMeta(formId, pageType) {
    if (!canTrackOps()) return {};
    const session = formSessions.get(formSessionKey(formId, pageType));
    if (!session || !session.openedAtMs) return {};
    return {
      openId: ensureOpenId(session),
      openedAt: toIso(session.openedAtMs),
      placement: session.placement || 'section',
    };
  }

  function trackLeadStart(formId, pageType, meta) {
    if (!canTrack()) return;
    const placement = (meta && meta.placement) || 'section';
    const session = trackFormOpened(formId, pageType, placement, { trigger: (meta && meta.trigger) || 'submit' });
    if (!session) return;
    markFormSubmitted(formId, pageType);
    const params = {
      form_id: formId,
      page_type: pageType,
      placement,
      open_id: ensureOpenId(session),
      opened_at: toIso(session.openedAtMs),
    };
    trackGAEvent('contact', params);
    emit('lead_submit_start', params);
  }

  function trackLeadSuccess(formId, pageType, leadId) {
    if (!canTrack()) return;
    markFormSubmitted(formId, pageType);
    const sessionMeta = getFormSessionMeta(formId, pageType);
    const params = {
      form_id: formId,
      page_type: pageType,
      lead_id: leadId || '',
      open_id: sessionMeta.openId || '',
      opened_at: sessionMeta.openedAt || '',
    };
    trackYandexGoal('form_submit', params);
    trackGAEvent('generate_lead', params);
    trackGAEvent('lead_submit_success', params);
    emit('lead_submit_success', params);
  }

  function trackFormSubmitSuccess(formId, pageType, leadId) {
    if (!canTrackOps()) return;
    markFormSubmitted(formId, pageType);
    const sessionMeta = getFormSessionMeta(formId, pageType);
    emitOps('form_submit_success', {
      form_id: formId,
      page_type: pageType,
      lead_id: leadId || '',
      open_id: sessionMeta.openId || '',
      opened_at: sessionMeta.openedAt || '',
    });
  }

  function trackLeadError(formId, pageType, reason) {
    if (!canTrack()) return;
    const sessionMeta = getFormSessionMeta(formId, pageType);
    const params = {
      form_id: formId,
      page_type: pageType,
      reason: reason || 'unknown',
      open_id: sessionMeta.openId || '',
      opened_at: sessionMeta.openedAt || '',
    };
    trackYandexGoal('form_error', params);
    trackGAEvent('lead_submit_error', params);
    emit('lead_submit_error', params);
  }

  function trackCallClick(phone, placement) {
    if (!canTrack()) return;
    const params = { phone: phone || '', placement: placement || 'section' };
    trackYandexGoal('call_click', params);
    trackGAEvent('click_call', params);
    emit('call_click', params);
  }

  function normalizeCtaText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
  }

  function slugify(value) {
    const normalized = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return normalized || '';
  }

  function inferCtaType(element, href) {
    if (!(element instanceof Element)) return 'secondary';
    const explicit = element.getAttribute('data-cta-type');
    if (explicit) return explicit;
    const cls = element.className || '';
    if (cls.includes('btn-primary') || cls.includes('primary')) return 'primary';
    if (href.startsWith('tel:')) return 'phone';
    if (href.includes('#contact') || href.includes('/contacts')) return 'primary';
    return 'secondary';
  }

  function resolveCtaPlacement(element) {
    if (!(element instanceof Element)) return 'section';
    return (
      element.getAttribute('data-cta-placement') ||
      element.closest('[data-cta-placement]')?.getAttribute('data-cta-placement') ||
      'section'
    );
  }

  function resolveCtaPayload(element) {
    if (!(element instanceof Element)) return null;

    const href = element.getAttribute('href') || '';
    const hasMarker =
      element.hasAttribute('data-cta') ||
      element.hasAttribute('data-cta-placement') ||
      element.hasAttribute('data-open-form');
    const contactHref = href.includes('#contact') || /\/contacts(?:#contact)?$/i.test(href);
    const telHref = href.startsWith('tel:');

    if (!hasMarker && !contactHref && !telHref) return null;

    const ctaText = normalizeCtaText(element.getAttribute('data-cta-label') || element.textContent || '');
    const explicitName = element.getAttribute('data-cta');
    const fallbackName = slugify(ctaText || href || '');

    return compactPayload({
      cta: explicitName || fallbackName || 'cta_click',
      cta_type: inferCtaType(element, href),
      placement: resolveCtaPlacement(element),
      href: href ? href.slice(0, 220) : '',
      text: ctaText,
    });
  }

  function initTTFITracking() {
    let fired = false;
    const interactionEvents = ['pointerdown', 'keydown', 'touchstart'];

    const onInteraction = (event) => {
      if (fired) return;
      fired = true;
      emit('ttfi', {
        elapsed_ms: Math.round(window.performance?.now?.() || 0),
        interaction_type: event.type,
      });
      interactionEvents.forEach((name) => window.removeEventListener(name, onInteraction, true));
    };

    interactionEvents.forEach((name) => window.addEventListener(name, onInteraction, { capture: true, passive: true }));
  }

  function initScrollDepthTracking() {
    const reached = new Set();

    const emitDepth = () => {
      const doc = document.documentElement;
      if (!doc) return;

      const maxScroll = Math.max(1, doc.scrollHeight - window.innerHeight);
      const progress = Math.min(1, Math.max(0, window.scrollY / maxScroll));
      const viewportProgress = Math.round(progress * 100);

      scrollDepthSteps.forEach((depth) => {
        if (viewportProgress >= depth && !reached.has(depth)) {
          reached.add(depth);
          emit('scroll_depth', { depth_pct: depth });
        }
      });
    };

    window.addEventListener('scroll', emitDepth, { passive: true });
    window.addEventListener('resize', emitDepth, { passive: true });
    emitDepth();
  }

  function resolveFormFromEventTarget(target) {
    if (!(target instanceof Element)) return null;
    const form = target.closest('form.lead-contact-form');
    if (!(form instanceof HTMLFormElement)) return null;
    const pageType = resolvePageType(window.location.pathname);
    const placement = (form.dataset.formContext || 'section').trim() || 'section';
    const hiddenPageType = readFormHiddenValue(form, 'pageType');
    return {
      formId: `${placement}-${pageType}`,
      pageType,
      placement,
      city: readFormHiddenValue(form, 'city'),
      district: readFormHiddenValue(form, 'district'),
      service: readFormHiddenValue(form, 'service'),
      pageSlug: readFormHiddenValue(form, 'pageSlug') || window.location.pathname,
      leadPageType: hiddenPageType || pageType,
    };
  }

  function emitPageView() {
    if (pageViewSent || !canTrack()) return;
    pageViewSent = true;
    emit('page_view', {
      page_type: resolvePageType(window.location.pathname),
      path: window.location.pathname + window.location.search,
      device_type: getDeviceType(),
    });
  }

  function initLeadTracking() {
    if (window.__leadTrackingInit) return;
    if (!enabled) return;
    window.__leadTrackingInit = true;

    ensureFirstTouch();

    emitPageView();

    initTTFITracking();
    initScrollDepthTracking();

    document.addEventListener(
      'click',
      function (event) {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const clickable = target.closest('a,button,[role="button"]');
        if (!clickable) return;

        const ctaPayload = resolveCtaPayload(clickable);
        if (ctaPayload) {
          emit('cta_click', ctaPayload);
        }

        const href = clickable.getAttribute('href') || '';
        if (href.startsWith('tel:')) {
          const rawPhone = String(href).replace(/^tel:/, '');
          trackCallClick(rawPhone, (ctaPayload && ctaPayload.placement) || resolveCtaPlacement(clickable));
        }

        const openFormId = clickable.getAttribute('data-open-form');
        if (openFormId) {
          const pageType = resolvePageType(window.location.pathname);
          trackFormOpened(`${openFormId}-${pageType}`, pageType, resolveCtaPlacement(clickable), {
            trigger: 'cta',
          });
        }
      },
      { capture: true }
    );

    document.addEventListener(
      'focusin',
      function (event) {
        const formTarget = resolveFormFromEventTarget(event.target);
        if (!formTarget) return;
        trackFormOpened(formTarget.formId, formTarget.pageType, formTarget.placement, {
          trigger: 'focus',
          city: formTarget.city,
          district: formTarget.district,
          service: formTarget.service,
          page_slug: formTarget.pageSlug,
          lead_page_type: formTarget.leadPageType,
        });
      },
      { capture: true }
    );

    window.addEventListener('pagehide', () => {
      formSessions.forEach((session) => {
        emitFormAbandoned(session, 'pagehide');
      });
    });
  }

  window.leadTracking = {
    resolvePageType,
    getLeadAttribution,
    trackLeadStart,
    trackLeadSuccess,
    trackLeadError,
    trackFormView,
    trackFormFocus,
    trackFormFirstInputFocus,
    trackFormStart,
    trackFormProgress,
    trackFormPhoneValid,
    trackFormValidationError,
    trackFormSubmitBlocked,
    trackFormSubmitAttempt,
    trackFormSubmitSuccess,
    trackCallClick,
    trackFormOpened,
    trackFormAbandoned,
    getFormSessionMeta,
    sendEvent: emit,
    initLeadTracking,
  };

  function maybeInitLeadTracking() {
    if (enabled) {
      initLeadTracking();
    }
  }

  maybeInitLeadTracking();
  window.addEventListener('analytics-consent-change', function (event) {
    if (event && event.detail && event.detail.state === 'granted') {
      ensureFirstTouch();
      emitPageView();
      maybeInitLeadTracking();
    }
  });
})();
