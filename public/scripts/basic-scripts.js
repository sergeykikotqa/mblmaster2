(() => {
  if (window.basic_script) {
    return;
  }

  window.basic_script = true;

  const scriptEl = document.querySelector('script[data-basic-scripts]');
  const isE2E = document.documentElement?.dataset?.e2e === 'true';
  const defaultTheme = (scriptEl?.getAttribute('data-default-theme') || 'system').toString();

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }

  const initTheme = function () {
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
  };

  initTheme();

  function attachEvent(selector, event, fn) {
    const matches = typeof selector === 'string' ? document.querySelectorAll(selector) : selector;
    if (matches && matches.length) {
      matches.forEach((elem) => {
        elem.addEventListener(event, (e) => fn(e, elem), false);
      });
    }
  }

  const Observer = {
    observer: null,
    delayBetweenAnimations: 100,
    animationCounter: 0,
    elements: null,

    start() {
      const selectors = [
        '[class*=" intersect:"]',
        '[class*=":intersect:"]',
        '[class^="intersect:"]',
        '[class="intersect"]',
        '[class*=" intersect "]',
        '[class^="intersect "]',
        '[class$=" intersect"]',
      ];

      this.elements = Array.from(document.querySelectorAll(selectors.join(',')));

      const getThreshold = (element) => {
        if (element.classList.contains('intersect-full')) return 0.99;
        if (element.classList.contains('intersect-half')) return 0.5;
        if (element.classList.contains('intersect-quarter')) return 0.25;
        return 0;
      };

      this.elements.forEach((el) => {
        el.setAttribute('no-intersect', '');
        el._intersectionThreshold = getThreshold(el);
      });

      const callback = (entries) => {
        entries.forEach((entry) => {
          requestAnimationFrame(() => {
            const target = entry.target;
            const intersectionRatio = entry.intersectionRatio;
            const threshold = target._intersectionThreshold;

            if (target.classList.contains('intersect-no-queue')) {
              if (entry.isIntersecting) {
                target.removeAttribute('no-intersect');
                if (target.classList.contains('intersect-once')) {
                  this.observer.unobserve(target);
                }
              } else {
                target.setAttribute('no-intersect', '');
              }
              return;
            }

            if (intersectionRatio >= threshold) {
              if (!target.hasAttribute('data-animated')) {
                target.removeAttribute('no-intersect');
                target.setAttribute('data-animated', 'true');

                const delay = this.animationCounter * this.delayBetweenAnimations;
                this.animationCounter++;

                target.style.transitionDelay = `${delay}ms`;
                target.style.animationDelay = `${delay}ms`;

                if (target.classList.contains('intersect-once')) {
                  this.observer.unobserve(target);
                }
              }
            } else {
              target.setAttribute('no-intersect', '');
              target.removeAttribute('data-animated');
              target.style.transitionDelay = '';
              target.style.animationDelay = '';

              this.animationCounter = 0;
            }
          });
        });
      };

      this.observer = new IntersectionObserver(callback.bind(this), { threshold: [0, 0.25, 0.5, 0.99] });

      this.elements.forEach((el) => {
        this.observer.observe(el);
      });
    },

    removeAnimationDelay() {
      this.elements?.forEach((el) => {
        if (el.getAttribute('data-animated') === 'true') {
          el.style.transitionDelay = '';
          el.style.animationDelay = '';
        }
      });
    },
  };

  const scheduleObserverStart = () => {
    if (isE2E) return;
    const run = () => Observer.start();
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(run, { timeout: 1500 });
    } else {
      window.setTimeout(run, 0);
    }
  };

  if (!isE2E) {
    if (document.readyState === 'complete') {
      scheduleObserverStart();
    } else {
      window.addEventListener('load', scheduleObserverStart, { once: true });
    }

    document.addEventListener('astro:after-swap', () => {
      scheduleObserverStart();
    });
  }

  let headerHeightObserver;
  let menuKeydownHandler;
  let anchorClickHandler;

  function setHeaderHeightVar() {
    const header = document.querySelector('#header');
    const headerHeight = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
    const normalizedHeight = Math.max(headerHeight, 1);
    document.documentElement.style.setProperty('--header-height', `${normalizedHeight}px`);
  }

  function syncHeaderHeight() {
    window.requestAnimationFrame(setHeaderHeightVar);
  }

  function getHeaderOffset() {
    const header = document.querySelector('[data-header]') || document.getElementById('header');
    const height = header ? header.getBoundingClientRect().height : 0;
    return Math.max(0, Math.ceil(height));
  }

  function scrollToHashWithOffset(targetId) {
    const target = document.getElementById(targetId);
    if (!target) return;

    const offset = getHeaderOffset();
    const rect = target.getBoundingClientRect();
    const y = rect.top + window.scrollY - offset - 8;
    const prefersReduced =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    window.scrollTo({
      top: Math.max(0, y),
      behavior: prefersReduced ? 'auto' : 'smooth',
    });
  }

  function syncHashTargetPosition() {
    if (!window.location.hash || window.location.hash.length < 2) return;
    const targetId = decodeURIComponent(window.location.hash.slice(1));
    window.requestAnimationFrame(() => scrollToHashWithOffset(targetId));
  }

  function observeHeaderHeight() {
    headerHeightObserver?.disconnect?.();
    const header = document.querySelector('#header');
    if (typeof ResizeObserver === 'function' && header) {
      headerHeightObserver = new ResizeObserver(syncHeaderHeight);
      headerHeightObserver.observe(header);
    }
    syncHeaderHeight();
  }

  const onLoad = function () {
    let lastKnownScrollPosition = window.scrollY;
    let ticking = true;

    observeHeaderHeight();
    window.removeEventListener('resize', syncHeaderHeight);
    window.removeEventListener('orientationchange', syncHeaderHeight);
    window.removeEventListener('hashchange', syncHashTargetPosition);
    window.addEventListener('resize', syncHeaderHeight);
    window.addEventListener('orientationchange', syncHeaderHeight);
    window.addEventListener('hashchange', syncHashTargetPosition);

    const header = document.getElementById('header');
    const mobilePanel = document.querySelector('#header [data-aw-mobile-panel]');
    const mobileNav = document.querySelector('#header [data-aw-mobile-nav]');
    const mobileActions = document.querySelector('#header [data-aw-mobile-actions]');
    const menuToggle = document.querySelector('[data-aw-toggle-menu]');

    const isMenuOpen = () => (mobilePanel instanceof HTMLElement ? !mobilePanel.classList.contains('hidden') : false);

    const getFocusableInMenu = () => {
      if (!(mobilePanel instanceof HTMLElement)) return [];
      const selector =
        'a[href], button:not([disabled]), summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      return Array.from(mobilePanel.querySelectorAll(selector)).filter(
        (node) => node instanceof HTMLElement && node.offsetParent !== null
      );
    };

    const setMenuState = (open, restoreFocus = true) => {
      if (
        !(header instanceof HTMLElement) ||
        !(mobilePanel instanceof HTMLElement) ||
        !(mobileNav instanceof HTMLElement) ||
        !(mobileActions instanceof HTMLElement)
      ) {
        return;
      }

      if (menuToggle instanceof HTMLElement) {
        menuToggle.classList.toggle('expanded', open);
        menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      }

      document.body.classList.toggle('overflow-hidden', open);
      header.classList.toggle('menu-open', open);
      header.classList.toggle('bg-page', open);
      mobilePanel.classList.toggle('hidden', !open);
      mobilePanel.setAttribute('aria-hidden', open ? 'false' : 'true');
      mobileNav.classList.toggle('hidden', !open);
      mobileActions.classList.toggle('hidden', !open);

      if (open) {
        const firstTarget = mobilePanel.querySelector('a[href], summary, button:not([disabled])');
        if (firstTarget instanceof HTMLElement) {
          firstTarget.focus();
        } else {
          const [fallback] = getFocusableInMenu();
          fallback?.focus();
        }
      } else if (restoreFocus && menuToggle instanceof HTMLElement) {
        menuToggle.focus();
      }

      syncHeaderHeight();
    };

    if (menuToggle instanceof HTMLElement) {
      menuToggle.setAttribute('aria-expanded', isMenuOpen() ? 'true' : 'false');
    }

    attachEvent('#header [data-aw-mobile-panel] a[href]', 'click', function () {
      if (isMenuOpen()) {
        setMenuState(false, false);
      }
    });

    attachEvent('[data-aw-toggle-menu]', 'click', function (event) {
      event.preventDefault();
      setMenuState(!isMenuOpen(), false);
    });

    if (menuKeydownHandler) {
      document.removeEventListener('keydown', menuKeydownHandler);
    }
    menuKeydownHandler = function (event) {
      if (!isMenuOpen()) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuState(false);
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = getFocusableInMenu();
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', menuKeydownHandler);

    if (anchorClickHandler) {
      document.removeEventListener('click', anchorClickHandler, true);
    }
    anchorClickHandler = function (event) {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest('a[href^="#"]');
      if (!(link instanceof HTMLAnchorElement)) return;
      const href = link.getAttribute('href') || '';
      if (!href || href === '#') return;
      const targetId = decodeURIComponent(href.slice(1));
      if (!targetId) return;
      if (!document.getElementById(targetId)) return;

      event.preventDefault();

      const nextHash = `#${encodeURIComponent(targetId)}`;
      if (window.location.hash !== nextHash) {
        history.pushState(null, '', nextHash);
      }
      scrollToHashWithOffset(targetId);
    };
    document.addEventListener('click', anchorClickHandler, true);

    attachEvent('[data-aw-toggle-color-scheme]', 'click', function () {
      if (defaultTheme.endsWith(':only')) {
        return;
      }

      Observer.removeAnimationDelay();

      document.documentElement.classList.toggle('dark');
      localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    });

    attachEvent('[data-aw-social-share]', 'click', function (_, elem) {
      const network = elem.getAttribute('data-aw-social-share');
      const url = encodeURIComponent(elem.getAttribute('data-aw-url'));
      const text = encodeURIComponent(elem.getAttribute('data-aw-text'));

      let href;
      switch (network) {
        case 'facebook':
          href = `https://www.facebook.com/sharer.php?u=${url}`;
          break;
        case 'twitter':
          href = `https://twitter.com/intent/tweet?url=${url}&text=${text}`;
          break;
        case 'linkedin':
          href = `https://www.linkedin.com/shareArticle?mini=true&url=${url}&title=${text}`;
          break;
        case 'whatsapp':
          href = `https://wa.me/?text=${text}%20${url}`;
          break;
        case 'mail':
          href = `mailto:?subject=%22${text}%22&body=${text}%20${url}`;
          break;

        default:
          return;
      }

      const newlink = document.createElement('a');
      newlink.target = '_blank';
      newlink.href = href;
      newlink.click();
    });

    const screenSize = window.matchMedia('(max-width: 1023px)');
    screenSize.addEventListener('change', function () {
      setMenuState(false, false);
    });

    function applyHeaderStylesOnScroll() {
      const header = document.querySelector('#header[data-aw-sticky-header]');
      if (!header) return;
      if (lastKnownScrollPosition > 60 && !header.classList.contains('scroll')) {
        header.classList.add('scroll');
      } else if (lastKnownScrollPosition <= 60 && header.classList.contains('scroll')) {
        header.classList.remove('scroll');
      }
      ticking = false;
    }
    applyHeaderStylesOnScroll();
    syncHeaderHeight();
    syncHashTargetPosition();

    attachEvent([document], 'scroll', function () {
      lastKnownScrollPosition = window.scrollY;

      if (!ticking) {
        window.requestAnimationFrame(() => {
          applyHeaderStylesOnScroll();
        });
        ticking = true;
      }
    });
  };

  const onPageShow = function () {
    document.documentElement.classList.add('motion-safe:scroll-smooth');
    const elem = document.querySelector('[data-aw-toggle-menu]');
    if (elem instanceof HTMLElement) {
      elem.classList.remove('expanded');
      elem.setAttribute('aria-expanded', 'false');
    }
    document.body.classList.remove('overflow-hidden');
    document.getElementById('header')?.classList.remove('menu-open');
    document.querySelector('#header [data-aw-mobile-panel]')?.classList.add('hidden');
    document.querySelector('#header [data-aw-mobile-panel]')?.setAttribute('aria-hidden', 'true');
    document.querySelector('#header [data-aw-mobile-nav]')?.classList.add('hidden');
    document.querySelector('#header [data-aw-mobile-actions]')?.classList.add('hidden');
    syncHeaderHeight();
  };

  window.onload = onLoad;
  window.onpageshow = onPageShow;

  document.addEventListener('astro:after-swap', () => {
    initTheme();
    onLoad();
    onPageShow();
  });
})();
