(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.__mblMotionInit) return;
  window.__mblMotionInit = true;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let observer;

  const revealImmediately = (elements) => {
    elements.forEach((element) => element.classList.add('is-visible'));
  };

  const init = () => {
    const elements = Array.from(document.querySelectorAll('[data-mbl-reveal]:not([data-mbl-reveal-ready])'));
    if (!elements.length) return;

    elements.forEach((element) => element.setAttribute('data-mbl-reveal-ready', 'true'));

    if (
      reducedMotion.matches ||
      document.documentElement.dataset.e2e === 'true' ||
      typeof IntersectionObserver !== 'function'
    ) {
      revealImmediately(elements);
      return;
    }

    document.documentElement.classList.add('mbl-motion-ready');
    observer ||= new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.18 }
    );

    elements.forEach((element) => observer.observe(element));
  };

  const handleReducedMotion = () => {
    if (!reducedMotion.matches) return;
    document.documentElement.classList.remove('mbl-motion-ready');
    revealImmediately(Array.from(document.querySelectorAll('[data-mbl-reveal]')));
    observer?.disconnect();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  reducedMotion.addEventListener?.('change', handleReducedMotion);
  document.addEventListener('astro:after-swap', init);
})();
