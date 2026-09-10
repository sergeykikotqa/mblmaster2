(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const init = () => {
    const maps = Array.from(document.querySelectorAll('[data-yandex-map]'));
    if (maps.length === 0) return;

    for (const map of maps) {
      if (!(map instanceof HTMLElement)) continue;
      if (map.dataset.mapInit === 'true') continue;
      map.dataset.mapInit = 'true';

      const src = map.getAttribute('data-map-src') || '';
      const frame = map.querySelector('[data-map-frame]');
      const placeholder = map.querySelector('[data-map-placeholder]');
      const loadBtn = map.querySelector('[data-map-load-btn]');
      if (!src || !(frame instanceof HTMLIFrameElement)) continue;

      const loadMap = () => {
        if (!frame.src) frame.src = src;
        frame.classList.remove('hidden');
        placeholder?.classList.add('hidden');
      };

      loadBtn?.addEventListener('click', loadMap, { once: true });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
