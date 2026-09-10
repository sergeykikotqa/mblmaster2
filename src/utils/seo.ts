type ProjectCity = 'irkutsk' | 'angarsk' | 'shelekhov';
type ProjectService = 'kuhni' | 'shkafy' | 'garderobnye';

export interface ServiceLabels {
  noun: string;
  plural: string;
  genitive: string;
  accusative: string;
}

const cityNames: Record<ProjectCity, { base: string; inCase: string }> = {
  irkutsk: { base: 'Иркутск', inCase: 'Иркутске' },
  angarsk: { base: 'Ангарск', inCase: 'Ангарске' },
  shelekhov: { base: 'Шелехов', inCase: 'Шелехове' },
};

const serviceLabels: Record<ProjectService, ServiceLabels> = {
  kuhni: { noun: 'кухня', plural: 'кухни', genitive: 'кухни', accusative: 'кухню' },
  shkafy: { noun: 'шкаф', plural: 'шкафы', genitive: 'шкафа', accusative: 'шкаф' },
  garderobnye: { noun: 'гардеробная', plural: 'гардеробные', genitive: 'гардеробной', accusative: 'гардеробную' },
};

export interface ProjectSeoInput {
  city: string;
  service: string;
  serviceLabelOverride?: ServiceLabels;
  layout?: string;
  street?: string;
  complex?: string;
  area?: number;
  duration?: number;
  district?: string;
}

function normalizeCityCode(city: string): ProjectCity {
  return String(city || '')
    .trim()
    .toLowerCase() as ProjectCity;
}

function normalizeServiceCode(service: string): ProjectService {
  return String(service || '')
    .trim()
    .toLowerCase() as ProjectService;
}

function capitalize(value: string): string {
  const source = String(value || '').trim();
  return source ? `${source.slice(0, 1).toUpperCase()}${source.slice(1)}` : '';
}

function formatDays(days?: number): string {
  if (!Number.isFinite(days)) return '';
  const value = Number(days);
  if (value % 10 === 1 && value % 100 !== 11) return `${value} день`;
  if (value % 10 >= 2 && value % 10 <= 4 && (value % 100 < 10 || value % 100 >= 20)) return `${value} дня`;
  return `${value} дней`;
}

export function getCityLabels(city: string): { base: string; inCase: string } {
  const cityCode = normalizeCityCode(city);
  return cityNames[cityCode] || { base: city, inCase: city };
}

export function getServiceLabels(service: string, override?: ServiceLabels | null): ServiceLabels {
  if (override) {
    return {
      noun: String(override.noun || '').trim() || String(service || '').trim(),
      plural: String(override.plural || '').trim() || String(service || '').trim(),
      genitive: String(override.genitive || '').trim() || String(service || '').trim(),
      accusative: String(override.accusative || '').trim() || String(service || '').trim(),
    };
  }
  const serviceCode = normalizeServiceCode(service);
  return serviceLabels[serviceCode] || { noun: service, plural: service, genitive: service, accusative: service };
}

function toAccusativeLayout(layout: string, service: ProjectService): string {
  const normalized = String(layout || '')
    .trim()
    .toLowerCase();
  if (!normalized) return '';
  if (service === 'kuhni' || service === 'garderobnye') {
    if (normalized.endsWith('ая')) return `${normalized.slice(0, -2)}ую`;
    if (normalized.endsWith('яя')) return `${normalized.slice(0, -2)}юю`;
  }
  return normalized;
}

export function generateProjectHeading(input: ProjectSeoInput): string {
  const city = getCityLabels(input.city);
  const service = getServiceLabels(input.service, input.serviceLabelOverride);
  const layout = String(input.layout || '')
    .trim()
    .toLowerCase();
  const street = String(input.street || '').trim();
  const prefix = layout ? `${capitalize(layout)} ${service.noun}` : capitalize(service.noun);
  const streetPart = street ? ` — проект на улице ${street}` : '';
  return `${prefix} на заказ в ${city.inCase}${streetPart}`;
}

export function generateProjectDescription(input: ProjectSeoInput): string {
  const city = getCityLabels(input.city);
  const serviceCode = normalizeServiceCode(input.service);
  const service = getServiceLabels(input.service, input.serviceLabelOverride);
  const layout = toAccusativeLayout(input.layout || '', serviceCode);
  const street = String(input.street || '').trim();
  const complex = String(input.complex || '').trim();

  const subject = layout ? `${layout} ${service.accusative}` : service.accusative;
  const location =
    complex && street
      ? `для квартиры в ${complex} на улице ${street}`
      : street
        ? `для квартиры на улице ${street}`
        : 'для квартиры';
  const areaSentence = Number.isFinite(input.area)
    ? `Площадь ${service.genitive} составила ${Number(input.area)} м².`
    : '';
  const durationSentence = Number.isFinite(input.duration)
    ? `Производство и установка заняли ${formatDays(Number(input.duration))}.`
    : '';

  return [`Мы изготовили ${subject} на заказ в ${city.inCase} ${location}.`, areaSentence, durationSentence]
    .filter(Boolean)
    .join('\n\n');
}

export function generateMicroGeoText(input: ProjectSeoInput): string {
  const city = getCityLabels(input.city);
  const district = String(input.district || '').trim();
  const complex = String(input.complex || '').trim();

  if (district && complex) {
    return `Проект выполнен в ${district} районе ${city.inCase} в жилом комплексе ${complex}.`;
  }
  if (district) {
    return `Проект выполнен в ${district} районе ${city.inCase}.`;
  }
  if (complex) {
    return `Проект выполнен в жилом комплексе ${complex} в ${city.inCase}.`;
  }
  return `Проект выполнен в ${city.inCase}.`;
}

export function generateProjectAlt(
  layout: string | undefined,
  city: string,
  street: string | undefined,
  service: string,
  serviceLabelOverride?: ServiceLabels
): string {
  const labels = getServiceLabels(service, serviceLabelOverride);
  const text = [String(layout || '').trim(), `${labels.noun} на заказ`, String(city || '').trim(), String(street || '').trim()]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return text || `${labels.noun} на заказ`;
}
