(() => {
  const toc = document.querySelector('[data-project-toc]');
  if (!toc) return;
  const links = Array.from(toc.querySelectorAll('[data-toc-link]'));
  if (links.length === 0) return;
  const sections = links
    .map((link) => {
      const href = link.getAttribute('href');
      if (!href || !href.startsWith('#')) return null;
      return document.getElementById(href.slice(1));
    })
    .filter((section) => section);

  const setActive = (id) => {
    links.forEach((link) => {
      const isActive = link.getAttribute('href') === '#' + id;
      if (isActive) {
        link.setAttribute('aria-current', 'true');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  };

  links.forEach((link) => {
    link.addEventListener('click', () => {
      const href = link.getAttribute('href');
      if (href && href.startsWith('#')) {
        setActive(href.slice(1));
      }
    });
  });

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting);
      if (visible.length === 0) return;
      visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      const id = visible[0]?.target?.getAttribute('id');
      if (id) setActive(id);
    },
    { rootMargin: '-20% 0px -70% 0px', threshold: [0, 0.2, 0.6, 1] }
  );

  sections.forEach((section) => observer.observe(section));

  const hashId = window.location.hash?.slice(1);
  if (hashId) {
    setActive(hashId);
  } else if (sections[0]) {
    const firstId = sections[0].getAttribute('id');
    if (firstId) setActive(firstId);
  }
})();
