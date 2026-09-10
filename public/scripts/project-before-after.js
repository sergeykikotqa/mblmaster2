(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const initItem = (item) => {
    if (!(item instanceof HTMLElement)) return;
    if (item.dataset.compareInit === 'true') return;

    const range = item.querySelector('input[type="range"]');
    if (!(range instanceof HTMLInputElement)) return;

    const update = () => {
      const value = Math.min(100, Math.max(0, Number(range.value) || 50));
      item.style.setProperty('--compare', `${value}%`);
    };

    range.addEventListener('input', update, { passive: true });
    range.addEventListener('change', update, { passive: true });

    update();
    item.dataset.compareInit = 'true';
  };

  const run = () => {
    document.querySelectorAll('[data-compare]').forEach(initItem);
  };

  const schedule = () => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(run, { timeout: 1500 });
    } else {
      window.setTimeout(run, 0);
    }
  };

  if (document.readyState === 'complete') {
    schedule();
  } else {
    window.addEventListener('load', schedule, { once: true });
  }
})();
