import { expect, test } from 'vitest';
import { resolvePageType } from '../src/utils/lead-tracking';

test('resolvePageType maps consolidated money pages to service-money', () => {
  expect(resolvePageType('/kuhni')).toBe('service-money');
  expect(resolvePageType('/shkafy')).toBe('service-money');
  expect(resolvePageType('/garderobnye')).toBe('service-money');
});

test('resolvePageType maps city hubs to city-hub', () => {
  expect(resolvePageType('/irkutsk')).toBe('city-hub');
});

test('resolvePageType no longer treats legacy geo service paths as money pages', () => {
  expect(resolvePageType('/irkutsk/kuhni')).toBe('other');
});
