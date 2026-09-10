(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const init = (root) => {
    if (!(root instanceof HTMLElement)) return;
    if (root.dataset.videoInit === 'true') return;

    const embedUrl = root.dataset.embedUrl;
    if (!embedUrl) return;

    const trigger = root.querySelector('.project-video-play') || root;

    const loadVideo = (event) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (root.dataset.videoLoaded === 'true') return;
      const iframe = document.createElement('iframe');
      iframe.src = embedUrl;
      iframe.title = 'Видеообзор проекта';
      iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
      iframe.loading = 'lazy';
      iframe.setAttribute('allowfullscreen', '');
      root.innerHTML = '';
      root.appendChild(iframe);
      root.dataset.videoLoaded = 'true';
    };

    if (trigger instanceof HTMLElement) {
      trigger.addEventListener('click', loadVideo, { once: true });
    }
    if (root !== trigger) {
      root.addEventListener('click', loadVideo, { once: true });
    }

    root.dataset.videoInit = 'true';
  };

  const run = () => {
    document.querySelectorAll('[data-video-embed]').forEach(init);
  };

  if (document.readyState !== 'loading') {
    run();
  } else {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  }
})();
