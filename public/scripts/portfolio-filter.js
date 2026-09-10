(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const isE2E = document.documentElement?.dataset?.e2e === 'true';

  const init = () => {
    document.querySelectorAll('[data-portfolio]').forEach((root) => {
      if (!(root instanceof HTMLElement)) return;
      if (root.dataset.portfolioInit === 'true') return;
      root.dataset.portfolioInit = 'true';

      const track = root.querySelector('[data-portfolio-track]');
      const cards = [...root.querySelectorAll('[data-portfolio-card]')];
      const filters = [...root.querySelectorAll('[data-portfolio-filter]')];
      const prev = root.querySelector('[data-portfolio-prev]');
      const next = root.querySelector('[data-portfolio-next]');
      const empty = root.querySelector('[data-portfolio-empty]');
      const mobile = window.matchMedia('(max-width: 960px)');

      if (
        !(track instanceof HTMLElement) ||
        !(prev instanceof HTMLButtonElement) ||
        !(next instanceof HTMLButtonElement)
      ) {
        return;
      }

      const step = () => {
        const card = cards.find((item) => !item.hidden);
        if (!card) return track.clientWidth;
        const style = window.getComputedStyle(track);
        const gap = Number.parseFloat(style.gap || style.columnGap || '16') || 16;
        return card.getBoundingClientRect().width + gap;
      };

      const syncArrows = () => {
        if (!mobile.matches) {
          prev.disabled = true;
          next.disabled = true;
          return;
        }
        const max = track.scrollWidth - track.clientWidth - 1;
        prev.disabled = track.scrollLeft <= 2;
        next.disabled = track.scrollLeft >= max;
      };

      const applyFilter = (id) => {
        let visible = 0;
        cards.forEach((card) => {
          const show = id === 'all' || card.dataset.category === id;
          card.hidden = !show;
          if (show) visible += 1;
        });
        filters.forEach((btn) => {
          const active = btn.dataset.filter === id;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        if (empty instanceof HTMLElement) empty.hidden = visible > 0;
        track.scrollTo({ left: 0, behavior: isE2E ? 'auto' : 'smooth' });
        window.setTimeout(syncArrows, 120);
      };

      prev.addEventListener('click', () => track.scrollBy({ left: -step(), behavior: isE2E ? 'auto' : 'smooth' }));
      next.addEventListener('click', () => track.scrollBy({ left: step(), behavior: isE2E ? 'auto' : 'smooth' }));
      track.addEventListener('scroll', syncArrows, { passive: true });
      window.addEventListener('resize', syncArrows);

      filters.forEach((button) => {
        button.addEventListener('click', () => {
          applyFilter(button.dataset.filter || 'all');
        });
      });

      applyFilter('all');
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
