(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const init = () => {
    document.querySelectorAll('[data-filter-root]').forEach((root) => {
      if (!(root instanceof HTMLElement)) return;
      if (root.dataset.filtersInit === 'true') return;
      root.dataset.filtersInit = 'true';

      const section = root.closest('section');
      const cards = Array.from((section || document).querySelectorAll('.project-card'));
      const resultNote = root.querySelector('[data-filter-result]');
      const toggle = root.querySelector('[data-filters-toggle]');
      const panel = root.querySelector('[data-filters-panel]');
      const backdrop = root.querySelector('[data-filters-backdrop]');
      const selected = root.querySelector('[data-filter-selected]');
      const emptyState = root.querySelector('[data-filter-empty]');
      const closeButtons = Array.from(root.querySelectorAll('[data-filters-close]'));
      const clearButtons = Array.from(root.querySelectorAll('[data-filters-clear]'));
      const desktopQuery = window.matchMedia('(min-width: 1024px)');

      if (cards.length === 0) return;

      const state = { service: '', area: '', layout: '', price: '' };

      const normalizeNumber = (value) => {
        const parsed = Number.parseFloat(value || '');
        return Number.isFinite(parsed) ? parsed : null;
      };

      const matchesArea = (areaValue, filter) => {
        if (!filter) return true;
        if (areaValue === null) return false;
        if (filter === 'lt6') return areaValue <= 6;
        if (filter === '6-8') return areaValue > 6 && areaValue <= 8;
        if (filter === 'gt8') return areaValue > 8;
        return true;
      };

      const matchesPrice = (priceValue, filter) => {
        if (!filter) return true;
        if (priceValue === null) return false;
        if (filter === 'lt200') return priceValue <= 200000;
        if (filter === '200-300') return priceValue > 200000 && priceValue <= 300000;
        if (filter === 'gt300') return priceValue > 300000;
        return true;
      };

      const hasActiveFilters = () => Object.values(state).some((value) => Boolean(value));

      const setVisibility = (el, show) => {
        if (!(el instanceof HTMLElement)) return;
        el.hidden = !show;
        el.style.display = show ? '' : 'none';
      };

      const updateResultNote = (visibleCount) => {
        if (!(resultNote instanceof HTMLElement)) return;
        if (!hasActiveFilters()) {
          setVisibility(resultNote, false);
          return;
        }
        setVisibility(resultNote, true);
        if (visibleCount === 0) {
          resultNote.textContent = 'Показано: 0 проектов';
          return;
        }
        resultNote.textContent = `Показано: ${visibleCount} проектов`;
      };

      const renderSelected = () => {
        if (!(selected instanceof HTMLElement)) return;
        selected.innerHTML = '';

        const chips = [];
        root.querySelectorAll('.filter-group').forEach((group) => {
          const active = group.querySelector('button.is-active');
          if (!(active instanceof HTMLButtonElement)) return;
          const value = active.getAttribute('data-filter-value') || '';
          if (!value) return;
          const label = active.textContent ? active.textContent.trim() : value;
          chips.push({ label, group, value });
        });

        if (chips.length === 0) {
          selected.classList.remove('is-visible');
          return;
        }

        selected.classList.add('is-visible');
        chips.forEach((chip) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'filter-tag';
          button.textContent = `${chip.label} ×`;
          button.addEventListener('click', () => {
            const buttons = Array.from(chip.group.querySelectorAll('button'));
            buttons.forEach((btn) => {
              btn.classList.toggle('is-active', btn.getAttribute('data-filter-value') === '');
            });
            const groupKey = chip.group.getAttribute('data-filter-group') || '';
            if (groupKey) state[groupKey] = '';
            applyFilters();
          });
          selected.appendChild(button);
        });
      };

      const updateEmptyState = (visibleCount) => {
        if (!(emptyState instanceof HTMLElement)) return;
        if (!hasActiveFilters()) {
          emptyState.classList.remove('is-visible');
          setVisibility(emptyState, false);
          return;
        }
        const shouldShow = visibleCount === 0;
        emptyState.classList.toggle('is-visible', shouldShow);
        setVisibility(emptyState, shouldShow);
      };

      const applyFilters = () => {
        let visibleCount = 0;
        cards.forEach((card) => {
          const areaValue = normalizeNumber(card.dataset.area);
          const priceValue = normalizeNumber(card.dataset.price);
          const layoutValue = card.dataset.layout || '';
          const serviceValue = card.dataset.service || '';

          const match =
            matchesArea(areaValue, state.area) &&
            matchesPrice(priceValue, state.price) &&
            (state.layout ? layoutValue === state.layout : true) &&
            (state.service ? serviceValue === state.service : true);

          card.closest('li')?.classList.toggle('is-hidden', !match);
          if (match) visibleCount += 1;
        });

        updateResultNote(visibleCount);
        updateEmptyState(visibleCount);
        renderSelected();
      };

      const openPanel = () => {
        if (!(panel instanceof HTMLElement)) return;
        panel.classList.add('is-open');
        panel.setAttribute('aria-hidden', 'false');
        if (backdrop instanceof HTMLElement) {
          backdrop.classList.add('is-open');
        }
        if (toggle instanceof HTMLElement) toggle.setAttribute('aria-expanded', 'true');
        if (!desktopQuery.matches) document.body.style.overflow = 'hidden';
      };

      const closePanel = () => {
        if (!(panel instanceof HTMLElement)) return;
        panel.classList.remove('is-open');
        panel.setAttribute('aria-hidden', 'true');
        if (backdrop instanceof HTMLElement) backdrop.classList.remove('is-open');
        if (toggle instanceof HTMLElement) toggle.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
      };

      if (toggle instanceof HTMLButtonElement) {
        toggle.addEventListener('click', () => {
          if (panel instanceof HTMLElement && panel.classList.contains('is-open')) {
            closePanel();
          } else {
            openPanel();
          }
        });
      }

      closeButtons.forEach((btn) => {
        if (btn instanceof HTMLElement) {
          btn.addEventListener('click', () => closePanel());
        }
      });

      if (backdrop instanceof HTMLElement) {
        backdrop.addEventListener('click', () => closePanel());
      }

      const clearFilters = () => {
        Object.keys(state).forEach((key) => {
          state[key] = '';
        });
        root.querySelectorAll('.filter-group').forEach((group) => {
          const buttons = Array.from(group.querySelectorAll('button'));
          buttons.forEach((btn) => {
            btn.classList.toggle('is-active', btn.getAttribute('data-filter-value') === '');
          });
        });
        applyFilters();
      };

      clearButtons.forEach((btn) => {
        if (btn instanceof HTMLButtonElement) {
          btn.addEventListener('click', clearFilters);
        }
      });

      root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closePanel();
      });

      root.querySelectorAll('.filter-group').forEach((group) => {
        const groupKey = group.getAttribute('data-filter-group');
        if (!groupKey) return;
        const buttons = Array.from(group.querySelectorAll('button'));
        if (buttons.length === 0) return;

        buttons.forEach((btn) => {
          btn.addEventListener('click', () => {
            const value = btn.getAttribute('data-filter-value') || '';
            const isActive = btn.classList.contains('is-active');
            const nextValue = isActive ? '' : value;

            buttons.forEach((item) => {
              item.classList.toggle('is-active', item.getAttribute('data-filter-value') === nextValue);
            });

            state[groupKey] = nextValue;
            applyFilters();
          });
        });
      });

      applyFilters();
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
