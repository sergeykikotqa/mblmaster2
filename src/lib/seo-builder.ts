import templatesRaw from '../../data/page-metadata/service-templates.json';

import type {
  CityHubSeoResult,
  CityModel,
  DistrictModel,
  ServiceModel,
  ServiceSeoResult,
  ServiceTemplate,
} from '~/types/geo-seo';
import { toCanonical } from '~/lib/url-builder';

type TemplateMap = Record<string, ServiceTemplate>;

const templates = templatesRaw as TemplateMap;
const fallbackTemplate: ServiceTemplate = templates.default || {
  title: '{service} в {location}',
  description: '{service} в {location}.',
  h1: '{service} в {location}',
  heroSubtitle: '',
};

function toServiceLower(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) return normalized;
  return `${normalized[0]?.toLowerCase() || ''}${normalized.slice(1)}`;
}

function interpolate(template: string, params: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(params)) {
    output = output.replaceAll(`{${key}}`, value);
  }
  return output.replace(/\s+/g, ' ').trim();
}

function resolveServiceTemplate(serviceId: string): ServiceTemplate {
  return templates[serviceId] || fallbackTemplate;
}

function resolveLocation(city: CityModel, district?: DistrictModel): string {
  const cityIn = city.nameIn || city.name;
  if (!district) return cityIn;

  const districtIn = district.nameIn || district.name;
  return `${districtIn} ${city.nameGenitive || city.name}`;
}

function buildPrimaryKeyword(service: ServiceModel, city: CityModel, district?: DistrictModel): string {
  const location = district ? `${district.name} ${city.name}` : city.name;
  return `${toServiceLower(service.name)} ${location}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function buildServiceSeo(params: {
  city: CityModel;
  service: ServiceModel;
  pathname: string;
  site: URL | string | undefined;
  district?: DistrictModel;
}): ServiceSeoResult {
  const { city, district, service, pathname, site } = params;
  const template = resolveServiceTemplate(service.id);
  const location = resolveLocation(city, district);
  const companyName = process.env.SITE_NAME || 'мбл мастер';
  const vars = {
    service: service.name,
    serviceLower: toServiceLower(service.name),
    city: city.name,
    district: district?.name || '',
    location,
    brand: companyName,
  };

  const title = interpolate(template.title, vars);
  const description = interpolate(template.description, vars);
  const h1 = interpolate(template.h1, vars);
  const heroSubtitle = interpolate(template.heroSubtitle || fallbackTemplate.heroSubtitle || '', vars);
  const canonical = toCanonical(pathname, site);

  return {
    metadata: {
      title,
      description,
      canonical,
    },
    h1,
    heroSubtitle,
    locationLabel: location,
    primaryKeyword: buildPrimaryKeyword(service, city, district),
  };
}

export function buildCityHubSeo(params: {
  city: CityModel;
  pathname: string;
  site: URL | string | undefined;
}): CityHubSeoResult {
  const { city, pathname, site } = params;
  const cityNameIn = city.nameIn || city.name;
  const title = `Мебель на заказ в ${cityNameIn} - кухни, шкафы-купе и гардеробные`;
  const description = `Изготавливаем мебель на заказ в ${cityNameIn}: кухни, шкафы-купе и гардеробные. Бесплатный замер, точный расчет, договор и монтаж под ключ.`;
  const canonical = toCanonical(pathname, site);

  return {
    metadata: {
      title,
      description,
      canonical,
    },
    h1: `Мебель на заказ в ${cityNameIn}`,
    heroSubtitle: `Собираем проекты под размеры помещения: от кухонь до систем хранения. Выезд на замер и расчет стоимости до запуска производства.`,
  };
}

export function buildServiceSchema(params: {
  city: CityModel;
  service: ServiceModel;
  canonical: string;
  district?: DistrictModel;
}) {
  const { city, district, service, canonical } = params;

  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    serviceType: service.name,
    name: district
      ? `${service.name} в ${district.nameIn || district.name}`
      : `${service.name} в ${city.nameIn || city.name}`,
    areaServed: district ? [district.name, city.name] : city.name,
    provider: {
      '@type': 'LocalBusiness',
      name: 'мбл мастер',
      areaServed: city.name,
    },
    url: canonical,
  };
}
