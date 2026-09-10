(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const media = window.matchMedia('(max-width: 900px)');
  const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  const initRoot = (root) => {
    if (!(root instanceof HTMLElement)) return;
    if (root.__gallerySliderCleanup) return;

    const scroller = root.querySelector('.project-gallery');
    const items = [...root.querySelectorAll('.project-gallery-item')];
    const controls = root.querySelector('[data-gallery-controls]');
    const dotsWrap = root.querySelector('[data-gallery-dots]');
    const prevBtn = root.querySelector('[data-gallery-prev]');
    const nextBtn = root.querySelector('[data-gallery-next]');

    if (!(scroller instanceof HTMLElement)) return;
    if (!(controls instanceof HTMLElement)) return;
    if (!(dotsWrap instanceof HTMLElement)) return;
    if (!(prevBtn instanceof HTMLButtonElement)) return;
    if (!(nextBtn instanceof HTMLButtonElement)) return;

    if (items.length < 2) return;

    root.dataset.gallerySliderInit = 'true';
    controls.classList.remove('hidden');

    let activeIndex = 0;
    const dots = items.map((_, index) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'project-gallery-dot';
      dot.setAttribute('aria-label', `Фото ${index + 1}`);
      dot.addEventListener('click', () => scrollToIndex(index));
      dotsWrap.appendChild(dot);
      return dot;
    });

    const updateActive = (index) => {
      activeIndex = Math.max(0, Math.min(index, items.length - 1));
      dots.forEach((dot, idx) => dot.classList.toggle('active', idx === activeIndex));
      prevBtn.disabled = activeIndex === 0;
      nextBtn.disabled = activeIndex === items.length - 1;
    };

    const scrollToIndex = (index) => {
      const target = items[index];
      if (!(target instanceof HTMLElement)) return;
      scroller.scrollTo({ left: target.offsetLeft, behavior: 'smooth' });
      updateActive(index);
    };

    const findClosestIndex = () => {
      let closest = 0;
      let min = Number.POSITIVE_INFINITY;
      items.forEach((item, index) => {
        if (!(item instanceof HTMLElement)) return;
        const delta = Math.abs(scroller.scrollLeft - item.offsetLeft);
        if (delta < min) {
          min = delta;
          closest = index;
        }
      });
      return closest;
    };

    let raf = 0;
    const onScroll = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => updateActive(findClosestIndex()));
    };

    const onPrev = () => scrollToIndex(activeIndex - 1);
    const onNext = () => scrollToIndex(activeIndex + 1);

    scroller.addEventListener('scroll', onScroll, { passive: true });
    prevBtn.addEventListener('click', onPrev);
    nextBtn.addEventListener('click', onNext);

    updateActive(0);

    const firstFocusable = root.querySelector(focusableSelector);
    if (firstFocusable instanceof HTMLElement) {
      firstFocusable.addEventListener('focus', () => updateActive(findClosestIndex()), { once: true });
    }

    root.__gallerySliderCleanup = () => {
      scroller.removeEventListener('scroll', onScroll);
      prevBtn.removeEventListener('click', onPrev);
      nextBtn.removeEventListener('click', onNext);
      dots.forEach((dot) => dot.remove());
      controls.classList.add('hidden');
      delete root.dataset.gallerySliderInit;
      delete root.__gallerySliderCleanup;
    };
  };

  const destroyRoot = (root) => {
    if (root && root.__gallerySliderCleanup) {
      root.__gallerySliderCleanup();
    }
  };

  const runInit = () => {
    if (!media.matches) return;
    document.querySelectorAll('[data-project-gallery]').forEach(initRoot);
  };

  const scheduleInit = () => {
    if (!media.matches) return;
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(runInit, { timeout: 1500 });
    } else {
      window.setTimeout(runInit, 0);
    }
  };

  const handleMediaChange = () => {
    if (media.matches) {
      scheduleInit();
    } else {
      document.querySelectorAll('[data-project-gallery]').forEach(destroyRoot);
    }
  };

  if (document.readyState === 'complete') {
    scheduleInit();
  } else {
    window.addEventListener('load', scheduleInit, { once: true });
  }

  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', handleMediaChange);
  }
})();
