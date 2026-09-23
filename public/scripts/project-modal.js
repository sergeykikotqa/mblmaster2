(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const init = () => {
    let modal = document.querySelector('[data-project-modal]');
    if (!(modal instanceof HTMLElement)) {
      const template = document.querySelector('[data-project-modal-template-root]');
      if (template instanceof HTMLTemplateElement) {
        const fragment = template.content.cloneNode(true);
        document.body.appendChild(fragment);
        modal = document.querySelector('[data-project-modal]');
      }
    }
    if (!(modal instanceof HTMLElement)) return;
    if (modal.dataset.modalInit === 'true') return;

    const panel = modal.querySelector('[role="dialog"]');
    const title = modal.querySelector('[data-project-modal-title]');
    const meta = modal.querySelector('[data-project-modal-meta]');
    const preview = modal.querySelector('[data-project-modal-preview]');
    const image = modal.querySelector('[data-project-modal-image]');
    const price = modal.querySelector('[data-project-modal-price]');
    const proofList = modal.querySelector('[data-project-modal-proof]');
    const closeButtons = Array.from(modal.querySelectorAll('[data-project-modal-close]'));
    const templateButton = modal.querySelector('[data-project-modal-template]');
    const form = modal.querySelector('form.lead-contact-form');
    const formTitle = form?.querySelector('h3');
    const formCtaText = form?.querySelector('[data-btn-text]');
    const messageInput = form?.querySelector('textarea[name="message"]');
    const submitButton = form?.querySelector('[data-submit-btn]');
    const formStatus = form?.querySelector('[data-form-status]');
    const submitFallback = form?.querySelector('[data-submit-fallback]');
    const submitFallbackCopy = form?.querySelector('[data-submit-fallback-copy]');
    const submitFallbackCall = form?.querySelector('[data-submit-fallback-call]');
    const requiredFieldNames = [
      'service',
      'pageSlug',
      'project_slug',
      'project_name',
      'project_area',
      'project_price',
      'project_service',
      'project_href',
    ];
    const hasRequiredFields =
      form instanceof HTMLFormElement &&
      requiredFieldNames.every((name) => form.querySelector(`input[name="${name}"]`) instanceof HTMLInputElement);
    const modalReady =
      panel instanceof HTMLElement &&
      title instanceof HTMLElement &&
      form instanceof HTMLFormElement &&
      formCtaText instanceof HTMLElement &&
      messageInput instanceof HTMLTextAreaElement &&
      submitButton instanceof HTMLButtonElement &&
      formStatus instanceof HTMLElement &&
      submitFallback instanceof HTMLElement &&
      submitFallbackCopy instanceof HTMLElement &&
      submitFallbackCall instanceof HTMLAnchorElement &&
      closeButtons.some((button) => button instanceof HTMLElement) &&
      hasRequiredFields;

    if (!modalReady) return;
    modal.dataset.modalInit = 'true';
    if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');

    const CONTACT_FORM_CLIENT_SRC = '/scripts/contact-form-client.js';
    const CONTACT_FORM_CLIENT_TIMEOUT_MS = 15_000;
    const LEAD_TRACKING_WAIT_MS = 2_000;
    const contactFormWasDisabled = submitButton instanceof HTMLButtonElement ? submitButton.disabled : false;

    const getContactFormApi = () => {
      const api = window.mblContactForms;
      return api && typeof api.init === 'function' ? api : null;
    };

    const waitForLeadTracking = () =>
      new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeoutId);
          resolve();
        };
        const timeoutId = window.setTimeout(finish, LEAD_TRACKING_WAIT_MS);
        Promise.resolve(window.__mblLeadTrackingReady).then(finish, finish);
      });

    const loadContactFormClient = () => {
      const readyApi = getContactFormApi();
      if (readyApi) return Promise.resolve(readyApi);
      if (window.__mblContactFormClientLoadPromise) return window.__mblContactFormClientLoadPromise;

      const loadPromise = waitForLeadTracking()
        .then(
          () =>
            new Promise((resolve, reject) => {
              const api = getContactFormApi();
              if (api) {
                resolve(api);
                return;
              }

              const absoluteSrc = new URL(CONTACT_FORM_CLIENT_SRC, window.location.href).href;
              let script = Array.from(document.scripts).find((candidate) => candidate.src === absoluteSrc);
              let shouldAppendScript = false;
              let pollTimer;
              let timeoutTimer;
              let settled = false;

              const cleanup = () => {
                window.clearInterval(pollTimer);
                window.clearTimeout(timeoutTimer);
                script?.removeEventListener('load', handleLoad);
                script?.removeEventListener('error', handleError);
              };
              const finish = (callback) => {
                if (settled) return;
                settled = true;
                cleanup();
                callback();
              };
              const confirmApi = () => {
                const loadedApi = getContactFormApi();
                if (loadedApi) finish(() => resolve(loadedApi));
              };
              const handleLoad = () => {
                confirmApi();
                if (!getContactFormApi()) {
                  finish(() => reject(new Error('CONTACT_FORM_API_MISSING')));
                }
              };
              const handleError = () => finish(() => reject(new Error('CONTACT_FORM_CLIENT_FAILED')));

              if (!(script instanceof HTMLScriptElement)) {
                script = document.createElement('script');
                script.src = CONTACT_FORM_CLIENT_SRC;
                script.async = true;
                script.defer = true;
                script.dataset.mblContactFormLoader = 'true';
                shouldAppendScript = true;
              }

              script.addEventListener('load', handleLoad, { once: true });
              script.addEventListener('error', handleError, { once: true });
              if (shouldAppendScript) document.head.appendChild(script);
              pollTimer = window.setInterval(confirmApi, 50);
              timeoutTimer = window.setTimeout(
                () => finish(() => reject(new Error('CONTACT_FORM_CLIENT_TIMEOUT'))),
                CONTACT_FORM_CLIENT_TIMEOUT_MS
              );
              confirmApi();
            })
        );

      window.__mblContactFormClientLoadPromise = loadPromise.catch((error) => {
        window.__mblContactFormClientLoadPromise = undefined;
        throw error;
      });
      return window.__mblContactFormClientLoadPromise;
    };

    const setFormLoadingState = () => {
      form.dataset.contactFormState = 'loading';
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = true;
        submitButton.setAttribute('aria-disabled', 'true');
      }
      if (formStatus instanceof HTMLElement) {
        formStatus.textContent = 'Подготавливаем форму…';
        formStatus.classList.remove('hidden');
      }
    };

    const showFormFallback = (message) => {
      if (submitFallbackCopy instanceof HTMLElement) submitFallbackCopy.textContent = message;
      if (submitFallback instanceof HTMLElement) {
        submitFallback.dataset.projectModalInitFallback = 'true';
        submitFallback.classList.remove('hidden');
      }
    };

    const setFormReadyState = () => {
      form.dataset.contactFormState = 'ready';
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = contactFormWasDisabled;
        submitButton.removeAttribute('aria-disabled');
      }
      if (formStatus instanceof HTMLElement) {
        formStatus.textContent = '';
        formStatus.classList.add('hidden');
      }
      if (submitFallback instanceof HTMLElement && submitFallback.dataset.projectModalInitFallback === 'true') {
        submitFallback.classList.add('hidden');
        delete submitFallback.dataset.projectModalInitFallback;
      }
    };

    const setFormUnavailableState = () => {
      form.dataset.contactFormState = 'unavailable';
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = true;
        submitButton.setAttribute('aria-disabled', 'true');
      }
      if (formStatus instanceof HTMLElement) {
        formStatus.textContent = 'Онлайн-форма временно недоступна. Позвоните нам — мы примем заявку по телефону.';
        formStatus.classList.remove('hidden');
      }
      showFormFallback('Онлайн-форма временно недоступна. Можно сразу позвонить нам.');
    };

    form.addEventListener(
      'submit',
      (event) => {
        if (form.dataset.contactFormInitialized === 'true') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        showFormFallback(
          form.dataset.contactFormState === 'unavailable'
            ? 'Онлайн-форма временно недоступна. Можно сразу позвонить нам.'
            : 'Форма ещё загружается. Можно подождать или сразу позвонить нам.'
        );
      },
      true
    );

    setFormLoadingState();
    void loadContactFormClient()
      .then((api) => {
        const initialized = api.init(form);
        if (!initialized || form.dataset.contactFormInitialized !== 'true') {
          throw new Error('CONTACT_FORM_INITIALIZATION_FAILED');
        }
        setFormReadyState();
      })
      .catch(setFormUnavailableState);

    const focusableSelector = [
      'a[href]',
      'area[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      'iframe',
      '[contenteditable]:not([contenteditable="false"])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const backgroundState = new Map();
    let backgroundObserver;
    let activeTrigger = null;
    let bodyOverflowBeforeOpen = '';
    let scrollPositionBeforeOpen = { x: 0, y: 0 };

    const isAvailableForFocus = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (!element.isConnected || element.hidden || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
      if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true' || element.tabIndex < 0) return false;
      const styles = window.getComputedStyle(element);
      return styles.display !== 'none' && styles.visibility !== 'hidden' && element.getClientRects().length > 0;
    };

    const getFocusableElements = () =>
      Array.from(modal.querySelectorAll(focusableSelector)).filter(isAvailableForFocus);

    const focusInsideModal = (preferLast = false) => {
      const focusableElements = getFocusableElements();
      const target = preferLast
        ? focusableElements[focusableElements.length - 1] || panel
        : focusableElements[0] || panel;
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    };

    const rememberAndInert = (element) => {
      if (!(element instanceof HTMLElement) || element === modal || element.contains(modal)) return;
      if (!backgroundState.has(element)) {
        backgroundState.set(element, element.hasAttribute('inert'));
      }
      element.inert = true;
    };

    const isolateBackground = () => {
      Array.from(document.body.children).forEach(rememberAndInert);
      backgroundObserver = new MutationObserver((records) => {
        records.forEach((record) => {
          record.addedNodes.forEach((node) => rememberAndInert(node));
        });
      });
      backgroundObserver.observe(document.body, { childList: true });
    };

    const restoreBackground = () => {
      if (backgroundObserver) {
        backgroundObserver.disconnect();
        backgroundObserver = undefined;
      }
      backgroundState.forEach((hadInertAttribute, element) => {
        if (!element.isConnected) return;
        if (hadInertAttribute) element.setAttribute('inert', '');
        else element.removeAttribute('inert');
      });
      backgroundState.clear();
    };

    const resolveReturnFocus = (preferred) => {
      if (isAvailableForFocus(preferred) && !modal.contains(preferred)) return preferred;
      return Array.from(document.querySelectorAll('[data-project-modal-trigger], a[href], button:not([disabled])')).find(
        (element) => !modal.contains(element) && isAvailableForFocus(element)
      );
    };

    const setFieldValue = (name, value) => {
      if (!(form instanceof HTMLFormElement)) return;
      const input = form.querySelector(`input[name="${name}"]`);
      if (input instanceof HTMLInputElement) {
        input.value = value || '';
      }
    };

    const fillExtraFields = (data) => {
      if (!(form instanceof HTMLFormElement)) return;
      form.querySelectorAll('[data-extra-field]').forEach((input) => {
        if (!(input instanceof HTMLInputElement)) return;
        const key = input.getAttribute('data-extra-field') || input.name;
        if (!key) return;
        input.value = data[key] || '';
      });
    };

    const resolveServiceLabel = (serviceId) => {
      if (serviceId === 'kuhni') return 'кухню';
      if (serviceId === 'shkafy') return 'шкаф';
      if (serviceId === 'garderobnye') return 'гардеробную';
      return 'проект';
    };

    const buildPrefillMessage = (data) => {
      const noun = resolveServiceLabel(data.project_service);
      const namePart = data.project_name ? `как в проекте «${data.project_name}»` : 'как в выбранном проекте';
      const areaPart = data.project_area ? `Площадь: ${data.project_area}.` : '';
      return `Хочу такую же ${noun}, ${namePart}. Интересует стоимость под мои размеры. ${areaPart}`.trim();
    };

    const resolveTriggerImage = (trigger) => {
      const direct = (trigger.getAttribute('data-project-image') || '').trim();
      if (direct && !direct.startsWith('data:') && !direct.startsWith('blob:')) return direct;

      const scope = trigger.closest('.project-card, .project-page, article, section, main') || document;
      const image = scope.querySelector('.project-cover img, .project-hero__media img, img');
      if (image instanceof HTMLImageElement) {
        return image.currentSrc || image.src || '';
      }

      return '';
    };

    const openModal = (data, trigger) => {
      if (title instanceof HTMLElement) title.textContent = data.project_name || 'Проект';
      if (meta instanceof HTMLElement) {
        const summary = data.project_summary || '';
        const parts = summary ? [summary, data.project_price] : [data.project_area, data.project_price];
        const text = parts.filter(Boolean).join(' • ');
        meta.textContent = text;
        meta.hidden = !text;
      }

      if (preview instanceof HTMLElement) {
        const hasImage = Boolean(data.project_image);
        preview.hidden = !hasImage;
      }
      if (image instanceof HTMLImageElement) {
        image.src = data.project_image || '';
        image.alt = data.project_name ? `Проект: ${data.project_name}` : 'Проект';
      }
      if (price instanceof HTMLElement) {
        price.textContent = data.project_price ? `Цена: ${data.project_price}` : '';
        price.hidden = !data.project_price;
      }

      if (proofList instanceof HTMLElement) {
        proofList.innerHTML = '';
        const items = [];
        if (data.project_proof) items.push(data.project_proof);
        if (data.project_area) items.push(`Площадь проекта: ${data.project_area}`);
        if (data.project_duration) items.push(`Срок реализации: ${data.project_duration}`);
        items.slice(0, 3).forEach((item) => {
          const li = document.createElement('li');
          li.textContent = item;
          proofList.appendChild(li);
        });
        proofList.hidden = items.length === 0;
      }

      const service = data.project_service || '';
      const pagePath = data.project_page || `${window.location.pathname}${window.location.search || ''}`;
      setFieldValue('service', service);
      setFieldValue('pageSlug', pagePath);
      fillExtraFields(data);

      if (formTitle instanceof HTMLElement) {
        if (service === 'kuhni') formTitle.textContent = 'Рассчитать такую же кухню';
        else if (service === 'shkafy') formTitle.textContent = 'Рассчитать такой же шкаф';
        else if (service === 'garderobnye') formTitle.textContent = 'Рассчитать такую же гардеробную';
        else formTitle.textContent = 'Рассчитать такой же проект';
      }

      if (formCtaText instanceof HTMLElement) {
        if (service === 'kuhni') formCtaText.textContent = 'Хочу такую же кухню →';
        else if (service === 'shkafy') formCtaText.textContent = 'Хочу такой же шкаф →';
        else if (service === 'garderobnye') formCtaText.textContent = 'Хочу такую же гардеробную →';
        else formCtaText.textContent = 'Хочу такой же проект →';
      }

      if (messageInput instanceof HTMLTextAreaElement) {
        if (!messageInput.dataset.listenerAttached) {
          messageInput.dataset.listenerAttached = 'true';
          messageInput.addEventListener('input', () => {
            messageInput.dataset.userEdited = 'true';
          });
        }
      }

      if (templateButton instanceof HTMLButtonElement) {
        templateButton.dataset.templateText = buildPrefillMessage(data);
      }

      activeTrigger = trigger instanceof HTMLAnchorElement ? trigger : null;
      bodyOverflowBeforeOpen = document.body.style.overflow;
      scrollPositionBeforeOpen = { x: window.scrollX, y: window.scrollY };
      modal.hidden = false;
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      isolateBackground();

      const phoneInput = form?.querySelector('input[name="phone"]');
      const closeButton = modal.querySelector('[data-project-modal-close]:not(.project-modal-backdrop)');
      const focusTarget = window.matchMedia('(max-width: 40rem)').matches ? closeButton : phoneInput;
      if (isAvailableForFocus(focusTarget)) focusTarget.focus({ preventScroll: true });
      else focusInsideModal();
    };

    const closeModal = () => {
      if (modal.hidden) return;
      const returnTarget = activeTrigger;
      activeTrigger = null;
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = bodyOverflowBeforeOpen;
      restoreBackground();
      window.scrollTo({ left: scrollPositionBeforeOpen.x, top: scrollPositionBeforeOpen.y, behavior: 'auto' });

      const focusTarget = resolveReturnFocus(returnTarget);
      if (focusTarget instanceof HTMLElement) focusTarget.focus({ preventScroll: true });
    };

    if (templateButton instanceof HTMLButtonElement) {
      if (!templateButton.dataset.listenerAttached) {
        templateButton.dataset.listenerAttached = 'true';
        templateButton.addEventListener('click', () => {
          const template = templateButton.dataset.templateText || '';
          if (!(messageInput instanceof HTMLTextAreaElement) || !template) return;
          const current = messageInput.value.trim();
          messageInput.value = current ? `${current}\n\n${template}` : template;
          messageInput.dataset.userEdited = 'true';
          messageInput.focus();
        });
      }
    }

    document.querySelectorAll('[data-project-modal-trigger]').forEach((trigger) => {
      if (!(trigger instanceof HTMLAnchorElement)) return;
      trigger.addEventListener('click', (event) => {
        const rawHref = (trigger.getAttribute('href') || '').trim();
        let targetUrl;
        try {
          targetUrl = new URL(rawHref, window.location.href);
        } catch {
          return;
        }

        const target = (trigger.getAttribute('target') || '').trim().toLowerCase();
        const isNativeAlternative =
          event.defaultPrevented ||
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey ||
          trigger.hasAttribute('download') ||
          (target && target !== '_self');
        const hasUsableHref =
          Boolean(rawHref) &&
          rawHref !== '#' &&
          !rawHref.toLowerCase().startsWith('javascript:') &&
          (targetUrl.protocol === 'http:' || targetUrl.protocol === 'https:') &&
          targetUrl.origin === window.location.origin;

        if (isNativeAlternative || !hasUsableHref) return;

        event.preventDefault();
        const data = {
          project_slug: trigger.getAttribute('data-project-slug') || '',
          project_name: trigger.getAttribute('data-project-title') || '',
          project_area: trigger.getAttribute('data-project-area') || '',
          project_price: trigger.getAttribute('data-project-price') || '',
          project_duration: trigger.getAttribute('data-project-duration') || '',
          project_proof: trigger.getAttribute('data-project-proof') || '',
          project_image: resolveTriggerImage(trigger),
          project_service: trigger.getAttribute('data-project-service') || '',
          project_href: trigger.getAttribute('data-project-href') || '',
          project_summary: trigger.getAttribute('data-project-summary') || '',
          project_page: trigger.getAttribute('data-project-page') || '',
        };
        openModal(data, trigger);
      });
    });

    closeButtons.forEach((btn) => {
      if (!(btn instanceof HTMLElement)) return;
      btn.addEventListener('click', closeModal);
    });

    document.addEventListener('keydown', (event) => {
      if (modal.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      if (!modal.contains(activeElement)) {
        event.preventDefault();
        focusInsideModal(event.shiftKey);
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    });

    document.addEventListener(
      'focusin',
      (event) => {
        if (modal.hidden || modal.contains(event.target)) return;
        focusInsideModal();
      },
      true
    );

    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal();
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
