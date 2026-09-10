(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const FOCUSABLE =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  const init = () => {
    document.querySelectorAll('[data-project-gallery]').forEach((root) => {
      if (!(root instanceof HTMLElement)) return;
      if (root.dataset.galleryLightboxInit === 'true') return;
      root.dataset.galleryLightboxInit = 'true';

      let slides = [...root.querySelectorAll('[data-gallery-slide]')];
      let thumbs = [...root.querySelectorAll('[data-gallery-thumb]')];
      const lightbox = root.querySelector('[data-gallery-lightbox]');
      const openButton = root.querySelector('[data-gallery-open]');
      const closeButtons = [
        ...root.querySelectorAll('[data-gallery-close]'),
        ...root.querySelectorAll('[data-gallery-backdrop]'),
      ];
      const lightboxImage = root.querySelector('[data-gallery-lightbox-image]');
      const lightboxCaption = root.querySelector('[data-gallery-lightbox-caption]');
      const prevButton = root.querySelector('[data-gallery-lightbox-prev]');
      const nextButton = root.querySelector('[data-gallery-lightbox-next]');

      if (!lightbox || !openButton || slides.length === 0) return;

      const clampIndex = (index) => Math.max(0, Math.min(index, slides.length - 1));

      function refresh() {
        slides = [...root.querySelectorAll('[data-gallery-slide]')];
        thumbs = [...root.querySelectorAll('[data-gallery-thumb]')];
      }

      function ensureDeferred() {
        if (root.dataset.galleryDeferredReady === 'true') {
          refresh();
          return;
        }

        const slidesTemplate = root.querySelector('[data-gallery-deferred-slides]');
        const thumbsTemplate = root.querySelector('[data-gallery-deferred-thumbs]');
        const hasSlidesTemplate = slidesTemplate instanceof HTMLTemplateElement;
        const hasThumbsTemplate = thumbsTemplate instanceof HTMLTemplateElement;
        if (!hasSlidesTemplate && !hasThumbsTemplate) {
          root.dataset.galleryDeferredReady = 'true';
          return;
        }

        if (hasSlidesTemplate) {
          const stage = root.querySelector('.project-gallery-stage');
          if (stage) {
            const fragment = slidesTemplate.content.cloneNode(true);
            const openButtonEl = stage.querySelector('[data-gallery-open]');
            if (openButtonEl) {
              stage.insertBefore(fragment, openButtonEl);
            } else {
              stage.appendChild(fragment);
            }
          }
          slidesTemplate.remove();
        }

        if (hasThumbsTemplate) {
          const thumbsWrap = root.querySelector('.project-gallery-thumbs');
          if (thumbsWrap) {
            thumbsWrap.appendChild(thumbsTemplate.content.cloneNode(true));
          }
          thumbsTemplate.remove();
        }

        root.dataset.galleryDeferredReady = 'true';
        refresh();
      }

      const getActiveIndex = () => {
        const datasetIndex = Number(root.dataset.galleryActiveIndex);
        if (Number.isFinite(datasetIndex)) return clampIndex(datasetIndex);
        const activeIndex = slides.findIndex((slide) => slide.classList.contains('is-active'));
        return clampIndex(activeIndex >= 0 ? activeIndex : 0);
      };

      const updateLightbox = (index) => {
        const slide = slides[index];
        if (!slide) return;
        const img = slide.querySelector('img');
        const src = img?.currentSrc || img?.getAttribute('src') || '';
        const caption = slide.getAttribute('data-caption') || img?.getAttribute('alt') || '';
        if (lightboxImage instanceof HTMLImageElement && src) {
          lightboxImage.src = src;
          lightboxImage.alt = caption || img?.getAttribute('alt') || '';
        }
        if (lightboxCaption instanceof HTMLElement) {
          lightboxCaption.textContent = caption;
        }
      };

      const syncGalleryIndex = (index) => {
        if (index >= slides.length) {
          ensureDeferred();
        }
        const nextIndex = clampIndex(index);
        if (thumbs[nextIndex]) {
          thumbs[nextIndex].click();
        } else {
          slides.forEach((slide, idx) => {
            slide.classList.toggle('is-active', idx === nextIndex);
            slide.setAttribute('aria-hidden', idx === nextIndex ? 'false' : 'true');
            slide.toggleAttribute('hidden', idx !== nextIndex);
          });
          root.dataset.galleryActiveIndex = String(nextIndex);
        }
        updateLightbox(nextIndex);
      };

      let lastFocused = null;
      let focusTrapHandler = null;

      const trapFocus = (event) => {
        if (!lightbox.contains(event.target)) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          closeLightbox();
          return;
        }

        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          syncGalleryIndex(getActiveIndex() - 1);
          return;
        }

        if (event.key === 'ArrowRight') {
          event.preventDefault();
          syncGalleryIndex(getActiveIndex() + 1);
          return;
        }

        if (event.key !== 'Tab') return;
        const focusables = [...lightbox.querySelectorAll(FOCUSABLE)].filter(
          (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true'
        );
        if (focusables.length === 0) {
          event.preventDefault();
          lightbox.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const isShift = event.shiftKey;
        if (isShift && document.activeElement === first) {
          event.preventDefault();
          last.focus();
          return;
        }
        if (!isShift && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };

      const openLightbox = () => {
        ensureDeferred();
        lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        updateLightbox(getActiveIndex());
        lightbox.removeAttribute('hidden');
        lightbox.setAttribute('aria-hidden', 'false');
        lightbox.classList.add('open');
        root.dataset.galleryBodyOverflow = document.body.style.overflow || '';
        document.body.style.overflow = 'hidden';
        focusTrapHandler = trapFocus;
        document.addEventListener('keydown', focusTrapHandler);
        const focusTarget =
          lightbox.querySelector('[data-gallery-close]') || lightbox.querySelector(FOCUSABLE);
        if (focusTarget instanceof HTMLElement) {
          focusTarget.focus();
        }
      };

      const closeLightbox = () => {
        lightbox.setAttribute('aria-hidden', 'true');
        lightbox.setAttribute('hidden', '');
        lightbox.classList.remove('open');
        document.body.style.overflow = root.dataset.galleryBodyOverflow || '';
        if (focusTrapHandler) {
          document.removeEventListener('keydown', focusTrapHandler);
          focusTrapHandler = null;
        }
        if (lastFocused && typeof lastFocused.focus === 'function') {
          lastFocused.focus();
        }
      };

      openButton.addEventListener('click', openLightbox);
      closeButtons.forEach((button) => button.addEventListener('click', closeLightbox));
      prevButton?.addEventListener('click', () => syncGalleryIndex(getActiveIndex() - 1));
      nextButton?.addEventListener('click', () => syncGalleryIndex(getActiveIndex() + 1));
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
