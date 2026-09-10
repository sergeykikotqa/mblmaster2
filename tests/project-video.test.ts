import { describe, expect, it } from 'vitest';

import { formatProjectVideoDate, resolveProjectVideoPlatform } from '~/lib/projects/project-video';

describe('project-video helpers', () => {
  it('detects the platform from common video URLs', () => {
    expect(resolveProjectVideoPlatform('https://youtu.be/demo')).toBe('YouTube');
    expect(resolveProjectVideoPlatform('https://vkvideo.ru/video123')).toBe('VK Видео');
    expect(resolveProjectVideoPlatform('https://rutube.ru/video/demo')).toBe('RuTube');
    expect(resolveProjectVideoPlatform('https://example.com/video')).toBe('Видеообзор');
  });

  it('formats publish dates for the project UI and ignores invalid values', () => {
    expect(formatProjectVideoDate('2026-03-20T00:00:00.000Z')).toContain('2026');
    expect(formatProjectVideoDate('')).toBe('');
    expect(formatProjectVideoDate('not-a-date')).toBe('');
  });
});
