(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (document.documentElement?.dataset?.e2e === 'true') return;

  const initHeroSlider = () => {
    document.querySelectorAll('[data-hm-slider-root]').forEach((root) => {
      const slides = [...root.querySelectorAll('[data-hm-slide]')];
      const dots = [...root.querySelectorAll('[data-hm-dot]')];
      const prev = root.querySelector('[data-hm-prev]');
      const next = root.querySelector('[data-hm-next]');

      if (!(prev instanceof HTMLButtonElement) || !(next instanceof HTMLButtonElement) || slides.length < 2) {
        return;
      }

      let active = 0;
      let timer = null;
      let hasInteracted = false;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      const ensureSlideMedia = (slide) => {
        if (!(slide instanceof HTMLElement)) return;
        const slot = slide.querySelector('[data-hm-media-slot]');
        if (!(slot instanceof HTMLElement)) return;
        if (slot.querySelector('img, picture')) return;
        const template = slide.querySelector('template[data-hm-template]');
        if (!(template instanceof HTMLTemplateElement)) return;
        slot.appendChild(template.content.cloneNode(true));
      };

      const hydrateNeighbors = (index) => {
        const total = slides.length;
        if (!total) return;
        const current = (index + total) % total;
        const prevIndex = (current - 1 + total) % total;
        const nextIndex = (current + 1) % total;
        ensureSlideMedia(slides[current]);
        ensureSlideMedia(slides[prevIndex]);
        ensureSlideMedia(slides[nextIndex]);
      };

      const paint = (index, options = {}) => {
        active = (index + slides.length) % slides.length;
        slides.forEach((slide, idx) => {
          const isActive = idx === active;
          slide.dataset.active = isActive ? 'true' : 'false';
          slide.setAttribute('aria-hidden', isActive ? 'false' : 'true');
        });
        dots.forEach((dot, idx) => {
          const isActive = idx === active;
          dot.classList.toggle('active', isActive);
          dot.setAttribute('aria-current', isActive ? 'true' : 'false');
        });
        ensureSlideMedia(slides[active]);
        if (options.hydrateNeighbors) hydrateNeighbors(active);
      };

      const stop = () => {
        if (timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
      };

      const start = () => {
        if (reducedMotion || !hasInteracted) return;
        stop();
        timer = window.setInterval(() => paint(active + 1), 7000);
      };

      const interact = (nextIndex) => {
        hasInteracted = true;
        paint(nextIndex, { hydrateNeighbors: true });
        start();
      };

      prev.addEventListener('click', () => {
        interact(active - 1);
      });
      next.addEventListener('click', () => {
        interact(active + 1);
      });
      dots.forEach((dot, idx) => {
        dot.addEventListener('click', () => {
          interact(idx);
        });
      });

      root.addEventListener('mouseenter', stop);
      root.addEventListener('mouseleave', start);
      root.addEventListener('focusin', stop);
      root.addEventListener('focusout', (event) => {
        const nextFocus = event.relatedTarget;
        if (!(nextFocus instanceof Node) || !root.contains(nextFocus)) start();
      });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          stop();
        } else {
          start();
        }
      });

      paint(0);
      start();
    });
  };

  const scheduleInit = () => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(initHeroSlider, { timeout: 1500 });
    } else {
      window.setTimeout(initHeroSlider, 0);
    }
  };

  if (document.readyState === 'complete') {
    scheduleInit();
  } else {
    window.addEventListener('load', scheduleInit, { once: true });
  }
})();
