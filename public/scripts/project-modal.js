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
      closeButtons.some((button) => button instanceof HTMLElement) &&
      hasRequiredFields;

    if (!modalReady) return;
    modal.dataset.modalInit = 'true';

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

    const openModal = (data) => {
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

      modal.hidden = false;
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';

      const phoneInput = form?.querySelector('input[name="phone"]');
      const closeButton = modal.querySelector('[data-project-modal-close]:not(.project-modal-backdrop)');
      const focusTarget = window.matchMedia('(max-width: 40rem)').matches ? closeButton : phoneInput;
      if (focusTarget instanceof HTMLElement) focusTarget.focus();
    };

    const closeModal = () => {
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
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
        openModal(data);
      });
    });

    closeButtons.forEach((btn) => {
      if (!(btn instanceof HTMLElement)) return;
      btn.addEventListener('click', closeModal);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !modal.hidden) closeModal();
    });

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
