export const formatProjectVideoDate = (value?: string): string => {
  const timestamp = Number(new Date(value || ''));
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(timestamp));
};

export const resolveProjectVideoPlatform = (...urls: Array<string | undefined>): string => {
  const source = urls
    .map((value) =>
      String(value || '')
        .trim()
        .toLowerCase()
    )
    .find(Boolean);

  if (!source) return 'Видеообзор';
  if (source.includes('vkvideo.ru') || source.includes('vk.com/video')) return 'VK Видео';
  if (source.includes('youtube.com') || source.includes('youtu.be')) return 'YouTube';
  if (source.includes('rutube.ru')) return 'RuTube';
  return 'Видеообзор';
};
