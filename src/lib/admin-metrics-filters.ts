import { getServices } from '~/lib/geo-data';

export type MetricsServiceFilterOption = {
  value: string;
  label: string;
};

export function getMetricsServiceFilterOptions(): MetricsServiceFilterOption[] {
  return getServices().map((service) => ({
    value: service.id,
    label: service.name,
  }));
}
