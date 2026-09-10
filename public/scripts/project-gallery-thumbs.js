(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const init = () => {
    document.querySelectorAll('[data-project-gallery]').forEach((root) => {
      if (!(root instanceof HTMLElement)) return;
      if (root.dataset.galleryThumbsInit === 'true') return;
      root.dataset.galleryThumbsInit = 'true';

      let slides = [...root.querySelectorAll('[data-gallery-slide]')];
      let thumbs = [...root.querySelectorAll('[data-gallery-thumb]')];
      const counter = root.querySelector('[data-gallery-counter]');
      const prevBtn = root.querySelector('[data-gallery-prev]');
      const nextBtn = root.querySelector('[data-gallery-next]');
      if (slides.length === 0) return;

      let activeIndex = 0;
      const clampIndex = (index) => Math.max(0, Math.min(index, slides.length - 1));

      function refresh() {
        slides = [...root.querySelectorAll('[data-gallery-slide]')];
        thumbs = [...root.querySelectorAll('[data-gallery-thumb]')];
      }

      function bindThumb(thumb) {
        if (!(thumb instanceof HTMLElement)) return;
        if (thumb.dataset.galleryThumbBound === 'true') return;
        thumb.dataset.galleryThumbBound = 'true';
        thumb.addEventListener('click', onThumbClick);
        thumb.addEventListener('keydown', onThumbKeydown);
      }

      function bindThumbs() {
        thumbs.forEach((thumb) => bindThumb(thumb));
      }

      function ensureDeferred() {
        if (root.dataset.galleryDeferredReady === 'true') {
          refresh();
          bindThumbs();
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
            const openButton = stage.querySelector('[data-gallery-open]');
            if (openButton) {
              stage.insertBefore(fragment, openButton);
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
        bindThumbs();
      }

      function setActive(index) {
        if (index >= slides.length) {
          ensureDeferred();
        }
        activeIndex = clampIndex(index);
        slides.forEach((slide, idx) => {
          slide.classList.toggle('is-active', idx === activeIndex);
          slide.setAttribute('aria-hidden', idx === activeIndex ? 'false' : 'true');
          slide.toggleAttribute('hidden', idx !== activeIndex);
        });
        thumbs.forEach((thumb, idx) => {
          thumb.classList.toggle('is-active', idx === activeIndex);
          thumb.setAttribute('aria-selected', idx === activeIndex ? 'true' : 'false');
          thumb.setAttribute('tabindex', idx === activeIndex ? '0' : '-1');
        });
        if (counter) {
          counter.textContent = `${activeIndex + 1} / ${slides.length}`;
        }
        if (prevBtn) prevBtn.disabled = activeIndex === 0;
        if (nextBtn) nextBtn.disabled = activeIndex === slides.length - 1;
        root.dataset.galleryActiveIndex = String(activeIndex);
      }

      function onThumbClick(event) {
        const target = event.currentTarget;
        if (!(target instanceof HTMLElement)) return;
        const index = Number(target.dataset.index || '0');
        setActive(index);
      }

      function onThumbKeydown(event) {
        if (!(event.currentTarget instanceof HTMLElement)) return;
        const key = event.key;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
        event.preventDefault();
        const index = Number(event.currentTarget.dataset.index || '0');
        let nextIndex = index;
        if (key === 'ArrowLeft') nextIndex = index - 1;
        if (key === 'ArrowRight') nextIndex = index + 1;
        if (key === 'Home') nextIndex = 0;
        if (key === 'End') {
          ensureDeferred();
          nextIndex = slides.length - 1;
        }
        nextIndex = clampIndex(nextIndex);
        setActive(nextIndex);
        thumbs[nextIndex]?.focus();
      }

      bindThumbs();
      prevBtn?.addEventListener('click', () => setActive(activeIndex - 1));
      nextBtn?.addEventListener('click', () => setActive(activeIndex + 1));

      setActive(0);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
