(() => {
  const cards = Array.from(document.querySelectorAll('[data-result-card]'));
  if (cards.length === 0) return;
  const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;

  const setupCard = (card) => {
    const body = card.querySelector('.project-result-body');
    const toggle = card.querySelector('[data-result-toggle]');
    if (!body || !toggle) return;

    const updateState = () => {
      if (!isDesktop()) {
        card.classList.remove('is-short');
        card.classList.remove('is-expanded');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = 'Показать полностью';
        return;
      }
      const maxHeight = parseFloat(getComputedStyle(body).maxHeight || '0');
      if (!Number.isFinite(maxHeight) || maxHeight <= 0) return;
      if (body.scrollHeight <= maxHeight + 8) {
        card.classList.add('is-short');
      } else {
        card.classList.remove('is-short');
      }
    };

    toggle.addEventListener('click', () => {
      const expanded = card.classList.toggle('is-expanded');
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.textContent = expanded ? 'Свернуть' : 'Показать полностью';
    });

    updateState();
    window.addEventListener('resize', updateState);
  };

  cards.forEach(setupCard);
})();
