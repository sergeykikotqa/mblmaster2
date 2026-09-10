(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const init = () => {
    const params = new URLSearchParams(window.location.search);
    const selectedTag = (params.get('tag') || '').trim().toLowerCase();
    if (!selectedTag) return;

    const cards = Array.from(document.querySelectorAll('[data-article-card]'));
    let visible = 0;
    for (const card of cards) {
      if (!(card instanceof HTMLElement)) continue;
      const tags = (card.getAttribute('data-tags') || '').split(',').filter(Boolean);
      const match = tags.includes(selectedTag);
      card.classList.toggle('hidden', !match);
      if (match) visible += 1;
    }
    const empty = document.getElementById('articles-filter-empty');
    if (empty) empty.classList.toggle('hidden', visible > 0);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
