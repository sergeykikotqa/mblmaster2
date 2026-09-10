(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  function onlyDigits(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function formatRUPhone(value) {
    const digits = onlyDigits(value);
    if (!digits) return '';

    const normalized = digits.startsWith('8') ? `7${digits.slice(1)}` : digits.startsWith('7') ? digits : `7${digits}`;
    const part = normalized.slice(1, 11);
    const a = part.slice(0, 3);
    const b = part.slice(3, 6);
    const c = part.slice(6, 8);
    const d = part.slice(8, 10);

    let out = '+7';
    if (a) out += ` (${a}`;
    if (a.length === 3) out += ')';
    if (b) out += ` ${b}`;
    if (c) out += `-${c}`;
    if (d) out += `-${d}`;
    return out;
  }

  function validPhone(value) {
    const digits = onlyDigits(value);
    return digits.length === 10 || (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8')));
  }

  function createIdempotencyKey(formId) {
    const prefix = String(formId || 'contact').replace(/[^a-zA-Z0-9_-]/g, '-');
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function resolveTracking() {
    const tracking = window.leadTracking || {};
    return {
      getLeadAttribution:
        typeof tracking.getLeadAttribution === 'function'
          ? tracking.getLeadAttribution.bind(tracking)
          : function getDefaultLeadAttribution() {
              return {
                utm_source: '(direct)',
                utm_medium: '(none)',
                utm_campaign: '(none)',
                utm_term: '(none)',
                utm_content: '(none)',
                landingPath: window.location.pathname,
                currentPath: window.location.pathname + window.location.search,
                firstReferrer: document.referrer || '(direct)',
                deviceType: 'desktop',
                submittedAt: new Date().toISOString(),
              };
            },
      resolvePageType:
        typeof tracking.resolvePageType === 'function' ? tracking.resolvePageType.bind(tracking) : () => 'other',
      trackLeadStart: typeof tracking.trackLeadStart === 'function' ? tracking.trackLeadStart.bind(tracking) : () => {},
      trackLeadSuccess:
        typeof tracking.trackLeadSuccess === 'function' ? tracking.trackLeadSuccess.bind(tracking) : () => {},
      trackLeadError: typeof tracking.trackLeadError === 'function' ? tracking.trackLeadError.bind(tracking) : () => {},
      trackFormView:
        typeof tracking.trackFormView === 'function' ? tracking.trackFormView.bind(tracking) : () => {},
      trackFormFocus:
        typeof tracking.trackFormFocus === 'function' ? tracking.trackFormFocus.bind(tracking) : () => {},
      trackFormFirstInputFocus:
        typeof tracking.trackFormFirstInputFocus === 'function'
          ? tracking.trackFormFirstInputFocus.bind(tracking)
          : () => {},
      trackFormStart:
        typeof tracking.trackFormStart === 'function' ? tracking.trackFormStart.bind(tracking) : () => {},
      trackFormProgress:
        typeof tracking.trackFormProgress === 'function' ? tracking.trackFormProgress.bind(tracking) : () => {},
      trackFormPhoneValid:
        typeof tracking.trackFormPhoneValid === 'function'
          ? tracking.trackFormPhoneValid.bind(tracking)
          : () => {},
      trackFormValidationError:
        typeof tracking.trackFormValidationError === 'function'
          ? tracking.trackFormValidationError.bind(tracking)
          : () => {},
      trackFormSubmitBlocked:
        typeof tracking.trackFormSubmitBlocked === 'function'
          ? tracking.trackFormSubmitBlocked.bind(tracking)
          : () => {},
      trackFormSubmitAttempt:
        typeof tracking.trackFormSubmitAttempt === 'function'
          ? tracking.trackFormSubmitAttempt.bind(tracking)
          : () => {},
      trackFormSubmitSuccess:
        typeof tracking.trackFormSubmitSuccess === 'function'
          ? tracking.trackFormSubmitSuccess.bind(tracking)
          : () => {},
      trackFormOpened:
        typeof tracking.trackFormOpened === 'function' ? tracking.trackFormOpened.bind(tracking) : () => {},
      getFormSessionMeta:
        typeof tracking.getFormSessionMeta === 'function'
          ? tracking.getFormSessionMeta.bind(tracking)
          : function getDefaultFormSessionMeta() {
              return {};
            },
    };
  }

  function initForm(form) {
    if (!(form instanceof HTMLFormElement)) return;
    if (form.dataset.contactFormInitialized === 'true') return;
    form.dataset.contactFormInitialized = 'true';

    const tracking = resolveTracking();

    const content = form.querySelector('[data-form-content]');
    const successBox = form.querySelector('[data-success-box]');
    const phoneInput = form.querySelector('input[name="phone"]');
    const nameInput = form.querySelector('input[name="name"]');
    const messageInput = form.querySelector('textarea[name="message"]');
    const consentInput = form.querySelector('input[name="consent"]');
    const trapInput = form.querySelector('input[name="website"]');
    const cityInput = form.querySelector('input[name="city"]');
    const districtInput = form.querySelector('input[name="district"]');
    const serviceInput = form.querySelector('input[name="service"]');
    const pageTypeInput = form.querySelector('input[name="pageType"]');
    const pageSlugInput = form.querySelector('input[name="pageSlug"]');
    const errorTurnstile = form.querySelector('[data-error-turnstile]');
    const turnstileStep = form.querySelector('[data-turnstile-step]');
    const turnstileHelp = form.querySelector('[data-turnstile-help]');
    const submitFallback = form.querySelector('[data-submit-fallback]');
    const submitFallbackCopy = form.querySelector('[data-submit-fallback-copy]');

    const errorName = form.querySelector('[data-error-name]');
    const errorPhone = form.querySelector('[data-error-phone]');
    const errorMessage = form.querySelector('[data-error-message]');
    const errorConsent = form.querySelector('[data-error-consent]');
    const status = form.querySelector('[data-form-status]');
    const submitBtn = form.querySelector('[data-submit-btn]');
    const retryBtn = form.querySelector('[data-retry-btn]');
    const btnText = form.querySelector('[data-btn-text]');

    if (
      !(content instanceof HTMLElement) ||
      !(successBox instanceof HTMLElement) ||
      !(phoneInput instanceof HTMLInputElement) ||
      !(nameInput instanceof HTMLInputElement) ||
      !(consentInput instanceof HTMLInputElement) ||
      !(submitBtn instanceof HTMLButtonElement) ||
      !(status instanceof HTMLElement) ||
      !(retryBtn instanceof HTMLButtonElement) ||
      !(btnText instanceof HTMLElement)
    ) {
      return;
    }

    const pageType = tracking.resolvePageType(window.location.pathname);
    const formId = `${form.dataset.formContext || 'section'}-${pageType}`;
    const placement = form.dataset.formContext || 'section';
    const defaultBtnLabel = btnText.textContent || 'Отправить заявку';
    const turnstileSiteKey = String(form.dataset.turnstileSiteKey || '').trim();
    const firstInput =
      form.querySelector('[data-first-input]') instanceof HTMLInputElement
        ? form.querySelector('[data-first-input]')
        : phoneInput;

    let isSubmitting = false;
    let submitIdempotencyKey = '';
    let resetIdempotencyAfterSubmit = false;
    let formOpenTracked = false;
    let formViewTracked = false;
    let formFocusTracked = false;
    let firstInputFocusTracked = false;
    let formStartTracked = false;
    let formProgressTracked = false;
    let phoneValidTracked = false;
    let attentionTimeout = 0;
    const defaultBorderColor = form.style.borderColor;
    const defaultBoxShadow = form.style.boxShadow;
    const startedFields = new Set();

    const resolveLeadContext = function resolveLeadContext() {
      const city = cityInput instanceof HTMLInputElement ? cityInput.value.trim() : '';
      const district = districtInput instanceof HTMLInputElement ? districtInput.value.trim() : '';
      const service = serviceInput instanceof HTMLInputElement ? serviceInput.value.trim() : '';
      const hiddenPageType = pageTypeInput instanceof HTMLInputElement ? pageTypeInput.value.trim() : '';
      const pageSlug = pageSlugInput instanceof HTMLInputElement ? pageSlugInput.value.trim() : '';
      return {
        city,
        district,
        service,
        pageSlug,
        leadPageType: hiddenPageType || pageType,
      };
    };

    const ensureFormOpened = function ensureFormOpened(trigger) {
      if (formOpenTracked) return;
      formOpenTracked = true;
      const leadContext = resolveLeadContext();
      tracking.trackFormOpened(formId, pageType, placement, {
        trigger: trigger || 'interaction',
        city: leadContext.city,
        district: leadContext.district,
        service: leadContext.service,
        page_slug: leadContext.pageSlug,
        lead_page_type: leadContext.leadPageType,
      });
    };

    const trackFormView = function trackFormView(trigger) {
      if (formViewTracked) return;
      formViewTracked = true;
      const leadContext = resolveLeadContext();
      tracking.trackFormView(formId, pageType, placement, {
        trigger: trigger || 'viewport',
        city: leadContext.city,
        district: leadContext.district,
        service: leadContext.service,
        page_slug: leadContext.pageSlug,
        lead_page_type: leadContext.leadPageType,
      });
    };

    const trackFirstInputFocus = function trackFirstInputFocus(trigger) {
      if (firstInputFocusTracked) return;
      firstInputFocusTracked = true;
      const leadContext = resolveLeadContext();
      tracking.trackFormFirstInputFocus(formId, pageType, placement, {
        trigger: trigger || 'focus',
        city: leadContext.city,
        district: leadContext.district,
        service: leadContext.service,
        page_slug: leadContext.pageSlug,
        lead_page_type: leadContext.leadPageType,
      });
    };

    const trackFormFocus = function trackFormFocus(trigger, fieldName, inputType) {
      if (formFocusTracked) return;
      formFocusTracked = true;
      const leadContext = resolveLeadContext();
      tracking.trackFormFocus(formId, pageType, placement, {
        trigger: trigger || 'focus',
        field_name: fieldName || '',
        input_type: inputType || '',
        city: leadContext.city,
        district: leadContext.district,
        service: leadContext.service,
        page_slug: leadContext.pageSlug,
        lead_page_type: leadContext.leadPageType,
      });
    };

    const trackFormStart = function trackFormStart(fieldName, inputType) {
      if (formStartTracked) return;
      formStartTracked = true;
      const leadContext = resolveLeadContext();
      tracking.trackFormStart(formId, pageType, placement, {
        trigger: 'input',
        field_name: fieldName || '',
        input_type: inputType || '',
        city: leadContext.city,
        district: leadContext.district,
        service: leadContext.service,
        page_slug: leadContext.pageSlug,
        lead_page_type: leadContext.leadPageType,
      });
    };

    const trackFormProgress = function trackFormProgress(fieldName, inputType, progressReason) {
      if (formProgressTracked) return;
      formProgressTracked = true;
      const leadContext = resolveLeadContext();
      tracking.trackFormProgress(formId, pageType, placement, {
        trigger: 'input',
        field_name: fieldName || '',
        input_type: inputType || '',
        progress_reason: progressReason || '',
        city: leadContext.city,
        district: leadContext.district,
        service: leadContext.service,
        page_slug: leadContext.pageSlug,
        lead_page_type: leadContext.leadPageType,
      });
    };

    const trackPhoneValid = function trackPhoneValid() {
      if (phoneValidTracked) return;
      phoneValidTracked = true;
      const leadContext = resolveLeadContext();
      tracking.trackFormPhoneValid(formId, pageType, placement, {
        trigger: 'phone',
        field_name: 'phone',
        city: leadContext.city,
        district: leadContext.district,
        service: leadContext.service,
        page_slug: leadContext.pageSlug,
        lead_page_type: leadContext.leadPageType,
      });
    };

    const trackValidationError = function trackValidationError(reason, fieldName) {
      const leadContext = resolveLeadContext();
      tracking.trackFormValidationError(formId, pageType, placement, {
        reason: reason || '',
        field_name: fieldName || '',
        city: leadContext.city,
        district: leadContext.district,
        service: leadContext.service,
        page_slug: leadContext.pageSlug,
        lead_page_type: leadContext.leadPageType,
      });
    };

    const trackSubmitBlocked = function trackSubmitBlocked(reason) {
      const leadContext = resolveLeadContext();
      tracking.trackFormSubmitBlocked(formId, pageType, placement, {
        reason: reason || '',
        city: leadContext.city,
        district: leadContext.district,
        service: leadContext.service,
        page_slug: leadContext.pageSlug,
        lead_page_type: leadContext.leadPageType,
      });
    };

    const getTurnstileTestMode = function getTurnstileTestMode() {
      return String(form.dataset.turnstileTestMode || '')
        .trim()
        .toLowerCase();
    };

    const isTurnstileGateEnabled = function isTurnstileGateEnabled() {
      const testMode = getTurnstileTestMode();
      return Boolean(turnstileSiteKey) || testMode === 'required' || testMode === 'unavailable';
    };

    const isTurnstileAvailable = function isTurnstileAvailable() {
      const testMode = getTurnstileTestMode();
      if (testMode === 'unavailable') return false;
      if (testMode === 'required') return true;
      return typeof window.turnstile !== 'undefined';
    };

    const setTurnstileStepVisible = function setTurnstileStepVisible(visible) {
      if (!(turnstileStep instanceof HTMLElement)) return;
      turnstileStep.hidden = !visible;
      turnstileStep.setAttribute('aria-hidden', visible ? 'false' : 'true');
      turnstileStep.classList.toggle('hidden', !visible);
    };

    const focusTurnstileStep = function focusTurnstileStep() {
      if (!(turnstileStep instanceof HTMLElement)) return;
      turnstileStep.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };

    const setTurnstileHelpText = function setTurnstileHelpText(message) {
      if (!(turnstileHelp instanceof HTMLElement)) return;
      turnstileHelp.textContent = message;
    };

    const showSubmitFallback = function showSubmitFallback(message) {
      if (!(submitFallback instanceof HTMLElement)) return;
      if (submitFallbackCopy instanceof HTMLElement && message) {
        submitFallbackCopy.textContent = message;
      }
      submitFallback.classList.remove('hidden');
    };

    const hideSubmitFallback = function hideSubmitFallback() {
      if (!(submitFallback instanceof HTMLElement)) return;
      submitFallback.classList.add('hidden');
    };

    const revealTurnstileStep = function revealTurnstileStep(options = {}) {
      if (!isTurnstileGateEnabled()) return;
      setTurnstileStepVisible(true);
      if (errorTurnstile instanceof HTMLElement && !options.keepError) {
        errorTurnstile.classList.add('hidden');
      }
      if (!options.message) {
        setTurnstileHelpText('Показываем проверку только после телефона, чтобы не тормозить первый шаг.');
        return;
      }
      setTurnstileHelpText(options.message);
    };

    const showTurnstileBlockedState = function showTurnstileBlockedState(reason, message) {
      revealTurnstileStep({
        keepError: true,
        message:
          reason === 'turnstile_unavailable'
            ? 'Защита формы временно недоступна. Если не хочется ждать, можно сразу позвонить.'
            : 'Нужно завершить проверку, чтобы форма приняла заявку.',
      });
      if (errorTurnstile instanceof HTMLElement) {
        errorTurnstile.textContent =
          message ||
          (reason === 'turnstile_unavailable'
            ? 'Не удалось загрузить проверку. Попробуйте ещё раз или позвоните.'
            : 'Сначала завершите проверку, затем отправьте заявку.');
        errorTurnstile.classList.remove('hidden');
      }
      showSubmitFallback('Если форма сейчас не проходит, мы всё равно можем принять заявку по телефону.');
      focusTurnstileStep();
    };

    const handleTextInputTracking = function handleTextInputTracking(fieldName, rawValue, inputType) {
      const normalizedValue =
        inputType === 'phone' ? onlyDigits(rawValue) : String(rawValue || '').replace(/\s+/g, ' ').trim();
      if (!normalizedValue) return;

      startedFields.add(fieldName);
      trackFormStart(fieldName, inputType);

      if (!formProgressTracked && (normalizedValue.length >= 2 || startedFields.size >= 2)) {
        const progressReason = startedFields.size >= 2 ? 'second_field' : 'two_chars';
        trackFormProgress(fieldName, inputType, progressReason);
      }

      if (fieldName === 'phone' && validPhone(rawValue)) {
        trackPhoneValid();
        revealTurnstileStep();
      }
    };

    const setFormAttention = function setFormAttention(active) {
      form.setAttribute('data-form-attention', active ? 'true' : 'false');
      if (active) {
        form.style.borderColor = '#b78562';
        form.style.boxShadow = '0 0 0 4px rgb(234 217 204 / 85%), 0 22px 44px rgb(141 93 61 / 18%)';
        return;
      }
      form.style.borderColor = defaultBorderColor;
      form.style.boxShadow = defaultBoxShadow;
    };

    const activateFormAttention = function activateFormAttention(trigger, focusFirstField) {
      clearTimeout(attentionTimeout);
      setFormAttention(true);
      trackFormView(trigger || 'anchor');
      attentionTimeout = window.setTimeout(() => {
        setFormAttention(false);
      }, 1800);

      if (!focusFirstField) return;

      let focusAttempts = 0;
      const focusFirstInput = function focusFirstInput() {
        if (!(firstInput instanceof HTMLInputElement)) return;
        if (document.activeElement === firstInput) return;
        if (form.contains(document.activeElement) && document.activeElement !== document.body) return;

        try {
          firstInput.focus({ preventScroll: true });
        } catch {
          firstInput.focus();
        }

        focusAttempts += 1;
        if (document.activeElement === firstInput || focusAttempts >= 6) return;
        window.setTimeout(focusFirstInput, 120);
      };

      window.setTimeout(focusFirstInput, 140);
    };

    const handleHashAttention = function handleHashAttention() {
      const hash = String(window.location.hash || '')
        .replace(/^#/, '')
        .trim()
        .toLowerCase();
      const recognizedHashes = new Set(['contact', 'form', String(form.id || '').trim().toLowerCase()]);
      if (!recognizedHashes.has(hash)) return;
      activateFormAttention('anchor', true);
    };

    const handleAnchorAttention = function handleAnchorAttention(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const link = target.closest('a[href^="#"]');
      if (!(link instanceof HTMLAnchorElement)) return;

      const hash = String(link.getAttribute('href') || '')
        .replace(/^#/, '')
        .trim()
        .toLowerCase();
      const recognizedHashes = new Set(['contact', 'form', String(form.id || '').trim().toLowerCase()]);
      if (!recognizedHashes.has(hash)) return;

      activateFormAttention('anchor-click', true);
    };

    const resetSubmissionState = function resetSubmissionState() {
      submitIdempotencyKey = '';
    };

    const setStatus = function setStatus(message, mode) {
      status.textContent = message;
      status.classList.remove('hidden', 'text-green-600', 'text-red-600', 'text-amber-600');
      status.classList.add(
        mode === 'success' ? 'text-green-600' : mode === 'warning' ? 'text-amber-600' : 'text-red-600'
      );
    };

    const clearFieldInvalid = function clearFieldInvalid(input) {
      if (!(input instanceof HTMLElement)) return;
      input.removeAttribute('aria-invalid');
    };

    const clearErrors = function clearErrors() {
      if (errorName instanceof HTMLElement) errorName.classList.add('hidden');
      if (errorPhone instanceof HTMLElement) errorPhone.classList.add('hidden');
      if (errorMessage instanceof HTMLElement) errorMessage.classList.add('hidden');
      if (errorConsent instanceof HTMLElement) errorConsent.classList.add('hidden');
      if (errorTurnstile instanceof HTMLElement) errorTurnstile.classList.add('hidden');
      clearFieldInvalid(nameInput);
      clearFieldInvalid(phoneInput);
      clearFieldInvalid(messageInput);
      clearFieldInvalid(consentInput);
      status.classList.add('hidden');
      retryBtn.classList.add('hidden');
      hideSubmitFallback();
    };

    const setSubmittingState = function setSubmittingState(loading) {
      submitBtn.disabled = loading;
      btnText.textContent = loading ? 'Отправка...' : defaultBtnLabel;
    };

    const showSuccess = function showSuccess() {
      content.remove();
      status.classList.add('hidden');
      successBox.classList.remove('hidden');
    };

    const getIdempotencyKey = function getIdempotencyKey() {
      if (!submitIdempotencyKey) {
        submitIdempotencyKey = createIdempotencyKey(formId);
      }
      return submitIdempotencyKey;
    };

    const hasTurnstileWidget = function hasTurnstileWidget() {
      return isTurnstileGateEnabled() && form.querySelector('[data-turnstile-widget]') instanceof HTMLElement;
    };

    const getTurnstileToken = function getTurnstileToken() {
      const input = form.querySelector('input[name="cf-turnstile-response"]');
      return input instanceof HTMLInputElement ? input.value.trim() : '';
    };

    const collectPayload = function collectPayload() {
      const nowIso = new Date().toISOString();
      const sessionMeta = tracking.getFormSessionMeta(formId, pageType) || {};
      const leadContext = resolveLeadContext();
      const extraFields = {};
      form.querySelectorAll('[data-extra-field]').forEach((input) => {
        if (!(input instanceof HTMLInputElement)) return;
        const key = input.getAttribute('data-extra-field') || input.name;
        if (!key) return;
        extraFields[key] = input.value.trim();
      });
      return {
        name: nameInput.value.trim(),
        phone: phoneInput.value.trim(),
        message: messageInput instanceof HTMLTextAreaElement ? messageInput.value.trim() : '',
        consent: Boolean(consentInput.checked),
        website: trapInput instanceof HTMLInputElement ? trapInput.value.trim() : '',
        turnstileToken: getTurnstileToken(),
        city: leadContext.city,
        district: leadContext.district,
        service: leadContext.service,
        pageType: leadContext.leadPageType,
        pageSlug: leadContext.pageSlug,
        attribution: tracking.getLeadAttribution(),
        formContext: {
          formId,
          pageType: leadContext.leadPageType,
          placement,
          city: leadContext.city,
          district: leadContext.district,
          service: leadContext.service,
          pageSlug: leadContext.pageSlug,
          openId: sessionMeta.openId || '',
          openedAt: sessionMeta.openedAt || '',
          submittedAt: nowIso,
        },
        ...extraFields,
      };
    };

    const submitLead = async function submitLead() {
      if (isSubmitting) return;

      clearErrors();
      ensureFormOpened('submit');
      trackFormView('submit');
      tracking.trackFormSubmitAttempt(formId, pageType, placement, resolveLeadContext());

      const name = nameInput.value.trim();
      const phone = phoneInput.value.trim();
      const messageValue = messageInput instanceof HTMLTextAreaElement ? messageInput.value.trim() : '';
      const hasConsent = consentInput.checked;
      const turnstileToken = getTurnstileToken();
      const turnstileEnabled = hasTurnstileWidget();
      const hasTurnstileToken = !turnstileEnabled || Boolean(turnstileToken);
      const messageTooLong = messageValue.length > 2000;

      const invalidFields = [];
      const markInvalid = function markInvalid(input, errorEl, fallbackMessage) {
        if (errorEl instanceof HTMLElement) {
          if (fallbackMessage) errorEl.textContent = fallbackMessage;
          errorEl.classList.remove('hidden');
        }
        if (input instanceof HTMLElement) {
          input.setAttribute('aria-invalid', 'true');
          invalidFields.push(input);
        }
      };

      const focusFirstInvalid = function focusFirstInvalid() {
        const target = invalidFields.find((field) => field && typeof field.focus === 'function');
        if (target) target.focus();
      };

      let hasFieldValidationError = false;

      if (!validPhone(phone)) {
        markInvalid(phoneInput, errorPhone, 'Пожалуйста, введите корректный номер телефона.');
        trackValidationError('phone', 'phone');
        hasFieldValidationError = true;
      }
      if (!name) {
        markInvalid(nameInput, errorName, 'Пожалуйста, укажите ваше имя.');
        trackValidationError('name', 'name');
        hasFieldValidationError = true;
      }
      if (messageTooLong) {
        markInvalid(messageInput, errorMessage, 'Сообщение слишком длинное. Максимум 2000 символов.');
        hasFieldValidationError = true;
      }
      if (!hasConsent) {
        markInvalid(consentInput, errorConsent, 'Подтвердите согласие на обработку персональных данных.');
        trackValidationError('consent', 'consent');
        hasFieldValidationError = true;
      }

      if (hasFieldValidationError) {
        tracking.trackLeadError(formId, pageType, 'validation');
        setStatus('Проверьте корректность полей формы.', 'warning');
        focusFirstInvalid();
        return;
      }

      if (!hasTurnstileToken) {
        const blockedReason = isTurnstileAvailable() ? 'turnstile_required' : 'turnstile_unavailable';
        tracking.trackLeadError(formId, pageType, blockedReason);
        trackSubmitBlocked(blockedReason);
        showTurnstileBlockedState(
          blockedReason,
          blockedReason === 'turnstile_unavailable'
            ? 'Не удалось загрузить проверку. Попробуйте ещё раз или позвоните.'
            : 'Сначала завершите проверку, затем отправьте заявку.'
        );
        setStatus(
          blockedReason === 'turnstile_unavailable'
            ? 'Проверка формы временно недоступна.'
            : 'Нужно завершить проверку формы.',
          'warning'
        );
        return;
      }

      isSubmitting = true;
      setSubmittingState(true);
      retryBtn.classList.add('hidden');
      tracking.trackLeadStart(formId, pageType, {
        placement,
        trigger: 'submit',
      });

      try {
        const response = await fetch('/api/leads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': getIdempotencyKey(),
          },
          body: JSON.stringify(collectPayload()),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data || data.success !== true) {
          const reason = response.status >= 500 ? 'server' : response.status >= 400 ? 'validation' : 'unknown';
          tracking.trackLeadError(formId, pageType, reason);
          retryBtn.classList.remove('hidden');
          const code = data && data.code ? String(data.code) : '';
          const message = (data && data.message) || 'Ошибка отправки. Попробуйте снова.';
          let handled = false;
          if (code === 'INVALID_NAME') {
            markInvalid(nameInput, errorName, message);
            trackValidationError('name', 'name');
            handled = true;
          } else if (code === 'INVALID_PHONE') {
            markInvalid(phoneInput, errorPhone, message);
            trackValidationError('phone', 'phone');
            handled = true;
          } else if (code === 'INVALID_MESSAGE') {
            markInvalid(messageInput, errorMessage, message);
            handled = true;
          } else if (code === 'CONSENT_REQUIRED') {
            markInvalid(consentInput, errorConsent, message);
            trackValidationError('consent', 'consent');
            handled = true;
          } else if (
            code === 'BOT_PROTECTION_REQUIRED' ||
            code === 'BOT_PROTECTION_FAILED' ||
            code === 'BOT_PROTECTION_UNAVAILABLE'
          ) {
            const blockedReason = code === 'BOT_PROTECTION_UNAVAILABLE' ? 'turnstile_unavailable' : 'turnstile_required';
            trackSubmitBlocked(blockedReason);
            showTurnstileBlockedState(blockedReason, message);
            if (blockedReason === 'turnstile_required') {
              focusTurnstileStep();
            }
            handled = true;
          } else if (response.status >= 500) {
            trackSubmitBlocked('server_unavailable');
            showSubmitFallback('Если форма временно недоступна, можно сразу позвонить и получить расчёт.');
          }
          setStatus(message, 'error');
          if (handled) {
            focusFirstInvalid();
          }
          return;
        }

        tracking.trackLeadSuccess(formId, pageType, data.leadId);
        tracking.trackFormSubmitSuccess(formId, pageType, data.leadId);
        showSuccess();
      } catch {
        tracking.trackLeadError(formId, pageType, 'network');
        trackSubmitBlocked('network');
        retryBtn.classList.remove('hidden');
        showSubmitFallback('Если соединение нестабильно, можно сразу позвонить и оставить заявку без формы.');
        setStatus('Ошибка сети. Проверьте соединение и повторите отправку.', 'error');
      } finally {
        isSubmitting = false;
        if (resetIdempotencyAfterSubmit) {
          resetSubmissionState();
          resetIdempotencyAfterSubmit = false;
        }
        setSubmittingState(false);
      }
    };

    const onFieldChange = function onFieldChange() {
      if (isSubmitting) {
        resetIdempotencyAfterSubmit = true;
        return;
      }
      resetSubmissionState();
    };

    // Reusable contract for UI layers that enrich this form without creating a second submit flow.
    form.addEventListener('mbl:lead-context-update', (event) => {
      if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== 'object') return;

      const nextContext = event.detail;
      if (typeof nextContext.service === 'string' && serviceInput instanceof HTMLInputElement) {
        serviceInput.value = nextContext.service;
      }
      if (typeof nextContext.message === 'string' && messageInput instanceof HTMLTextAreaElement) {
        messageInput.value = nextContext.message;
      }

      onFieldChange();
    });

    nameInput.addEventListener('input', () => {
      onFieldChange();
      handleTextInputTracking('name', nameInput.value, 'text');
    });
    consentInput.addEventListener('change', onFieldChange);
    if (messageInput instanceof HTMLTextAreaElement) {
      messageInput.addEventListener('input', () => {
        onFieldChange();
        handleTextInputTracking('message', messageInput.value, 'textarea');
      });
    }

    form.addEventListener(
      'focusin',
      (event) => {
        ensureFormOpened('focus');
        trackFormView('focus');
        const target = event.target;
        const fieldName =
          target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.name : '';
        const inputType =
          target instanceof HTMLInputElement
            ? target.type || 'text'
            : target instanceof HTMLTextAreaElement
              ? 'textarea'
              : '';
        trackFormFocus('focus', fieldName, inputType);
      },
      { once: true }
    );

    firstInput.addEventListener(
      'focus',
      () => {
        trackFormView('focus');
        trackFirstInputFocus('focus');
      },
      { once: true }
    );

    form.addEventListener(
      'pointerdown',
      () => {
        ensureFormOpened('pointer');
        trackFormView('pointer');
      },
      { once: true, passive: true }
    );

    phoneInput.addEventListener('input', () => {
      const caret = phoneInput.selectionStart || phoneInput.value.length;
      phoneInput.value = formatRUPhone(phoneInput.value);
      phoneInput.setSelectionRange(caret, caret);
      onFieldChange();
      handleTextInputTracking('phone', phoneInput.value, 'phone');
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await submitLead();
    });

    retryBtn.addEventListener('click', async () => {
      await submitLead();
    });

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.35)) return;
          trackFormView('viewport');
          observer.disconnect();
        },
        { threshold: [0.35] }
      );
      observer.observe(form);
    } else {
      trackFormView('init');
    }

    window.addEventListener('hashchange', handleHashAttention);
    document.addEventListener('click', handleAnchorAttention, true);
    handleHashAttention();
  }

  function initContactForms() {
    const forms = Array.from(document.querySelectorAll('form.lead-contact-form'));
    forms.forEach((form) => initForm(form));
    window.__contactFormsInit = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initContactForms, { once: true });
  } else {
    initContactForms();
  }

  document.addEventListener('astro:after-swap', initContactForms);
})();
