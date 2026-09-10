(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const script =
    document.currentScript ||
    document.querySelector('script[data-apply-color-mode]');
  const defaultTheme = String(script?.getAttribute('data-default-theme') || 'system');

  function applyTheme(theme) {
    const isDark = theme === 'dark';
    document.documentElement.classList.toggle('dark', isDark);

    const syncInputs = () => {
      const matches = document.querySelectorAll('[data-aw-toggle-color-scheme] > input');
      if (!matches || matches.length === 0) return;
      matches.forEach((elem) => {
        elem.checked = !isDark;
      });
    };

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(syncInputs);
    } else {
      setTimeout(syncInputs, 0);
    }
  }

  if ((defaultTheme && defaultTheme.endsWith(':only')) || (!localStorage.theme && defaultTheme !== 'system')) {
    applyTheme(defaultTheme.replace(':only', ''));
  } else if (
    localStorage.theme === 'dark' ||
    (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)
  ) {
    applyTheme('dark');
  } else {
    applyTheme('light');
  }
})();
