import citiesRaw from '../../data/cities.json';
import districtsRaw from '../../data/districts.json';
import generatedPagesRaw from '../../data/generated-pages.json';
import servicesRaw from '../../data/services.json';

import type { MetaDataRobots } from '~/types';
import type {
  CityModel,
  DistrictModel,
  GeneratedGeoPage,
  GeoPageType,
  IndexabilityPolicy,
  PriorityTier,
  ReleaseStage,
  ServiceModel,
} from '~/types/geo-seo';
import { normalizePath } from '~/lib/url-builder';

const cities = Object.freeze([...(citiesRaw as CityModel[])]);
const districts = Object.freeze([...(districtsRaw as DistrictModel[])]);
const services = Object.freeze([...(servicesRaw as ServiceModel[])]);

function isIndexabilityPolicy(value: string): value is IndexabilityPolicy {
  return value === 'index' || value === 'noindex_follow' || value === 'noindex_nofollow';
}

function isPriorityTier(value: string): value is PriorityTier {
  return value === 'A' || value === 'B' || value === 'C';
}

function normalizePriorityTier(value: string | undefined): PriorityTier {
  const raw = String(value || '')
    .trim()
    .toUpperCase();
  return isPriorityTier(raw) ? raw : 'C';
}

function isReleaseStage(value: string): value is ReleaseStage {
  return (
    value === 'draft' ||
    value === 'noindex_live' ||
    value === 'index_trial' ||
    value === 'index_stable' ||
    value === 'rollback_noindex'
  );
}

function normalizeReleaseStage(value: string | undefined, pageType: GeoPageType): ReleaseStage {
  const raw = String(value || '').trim();
  if (isReleaseStage(raw)) return raw;
  return pageType === 'service-money' ? 'index_stable' : 'noindex_live';
}

function normalizeIndexabilityPolicy(
  indexabilityPolicy: string | undefined,
  pageType: GeoPageType
): IndexabilityPolicy {
  const raw = String(indexabilityPolicy || '').trim();
  if (raw === 'noindex') return 'noindex_follow';
  if (isIndexabilityPolicy(raw)) return raw;
  return pageType === 'service-money' ? 'index' : 'noindex_follow';
}

function resolveIndexabilityPolicy(page: GeneratedGeoPage): IndexabilityPolicy {
  return normalizeIndexabilityPolicy(page.indexabilityPolicy, page.pageType);
}

const generatedPages = Object.freeze(
  [...(generatedPagesRaw as GeneratedGeoPage[])].map((page) => ({
    ...page,
    indexabilityPolicy: resolveIndexabilityPolicy(page),
    priorityTier: normalizePriorityTier(page.priorityTier),
    releaseStage: normalizeReleaseStage(page.releaseStage, page.pageType),
    readinessScore: Number.isFinite(Number(page.readinessScore))
      ? Math.min(100, Math.max(0, Math.round(Number(page.readinessScore))))
      : 0,
  }))
);

function validateUniqueIds(items: ReadonlyArray<{ id: string }>, label: string) {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.id || !item.id.trim()) {
      throw new Error(`[geo-data] ${label}: empty id`);
    }
    if (seen.has(item.id)) {
      throw new Error(`[geo-data] ${label}: duplicate id "${item.id}"`);
    }
    seen.add(item.id);
  }
}

function validateUniqueServicePathSegments(items: ReadonlyArray<{ id: string; pathSegment: string }>) {
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = String(item.pathSegment || '')
      .trim()
      .toLowerCase();
    if (!normalized) {
      throw new Error(`[geo-data] service "${item.id}" has empty pathSegment`);
    }
    if (seen.has(normalized)) {
      throw new Error(`[geo-data] duplicate service pathSegment "${normalized}"`);
    }
    seen.add(normalized);
  }
}

function validateServiceForms(service: ServiceModel) {
  const forms = service.forms;
  if (!forms || !forms.nominative || !forms.genitive || !forms.prepositional || !forms.accusative) {
    throw new Error(`[geo-data] service "${service.id}" must declare all grammatical forms`);
  }
}

function validateDataModel() {
  validateUniqueIds(cities, 'cities');
  validateUniqueIds(districts, 'districts');
  validateUniqueIds(services, 'services');
  validateUniqueServicePathSegments(services);

  const cityMap = new Map(cities.map((city) => [city.id, city]));
  const districtCityMap = new Map<string, string>();

  for (const city of cities) {
    if (!city.nameIn || !city.nameIn.trim()) {
      throw new Error(`[geo-data] city "${city.id}" has empty nameIn`);
    }
    if (!city.nameGenitive || !city.nameGenitive.trim()) {
      throw new Error(`[geo-data] city "${city.id}" has empty nameGenitive`);
    }
  }

  for (const district of districts) {
    if (!district.nameIn || !district.nameIn.trim()) {
      throw new Error(`[geo-data] district "${district.id}" has empty nameIn`);
    }
    const city = cityMap.get(district.cityId);
    if (!city) {
      throw new Error(`[geo-data] district "${district.id}" references unknown city "${district.cityId}"`);
    }
    if (!city.hasDistricts) {
      throw new Error(`[geo-data] city "${city.id}" hasDistricts=false but district "${district.id}" is declared`);
    }
    districtCityMap.set(district.id, district.cityId);
  }

  for (const service of services) {
    if (!service.pathSegment || !service.pathSegment.trim()) {
      throw new Error(`[geo-data] service "${service.id}" has empty pathSegment`);
    }
    validateServiceForms(service);
    if (service.moneyPage !== true && service.moneyPage !== false) {
      throw new Error(`[geo-data] service "${service.id}" has invalid moneyPage value`);
    }
    if (service.hasDistrictPages !== true && service.hasDistrictPages !== false) {
      throw new Error(`[geo-data] service "${service.id}" has invalid hasDistrictPages value`);
    }
    if (service.hasDistrictPages === true) {
      throw new Error(
        `[geo-data] district pages are disabled (District OFF), service "${service.id}" must set hasDistrictPages=false`
      );
    }
  }

  const cityIdsWithDistricts = new Set(
    districts.map((district) => district.cityId).filter((cityId) => cityMap.get(cityId)?.hasDistricts === true)
  );

  for (const city of cities) {
    if (city.hasDistricts && !cityIdsWithDistricts.has(city.id)) {
      throw new Error(`[geo-data] city "${city.id}" hasDistricts=true but no districts declared`);
    }
  }

  for (const [districtId, cityId] of districtCityMap.entries()) {
    const district = districts.find((item) => item.id === districtId);
    if (!district || district.cityId !== cityId) {
      throw new Error(`[geo-data] district "${districtId}" has inconsistent city relation`);
    }
  }
}

function buildExpectedGeneratedPages() {
  const orderedCities = [...cities].sort((a, b) => Number(a.priority) - Number(b.priority));
  const primaryCity = orderedCities[0];
  if (!primaryCity) return [];
  const moneyServices = services.filter((service) => service.moneyPage);
  const expected: Array<{
    cityId: string;
    serviceId: string;
    pageType: 'service-money';
    pageSlug: string;
  }> = [];

  for (const service of moneyServices) {
    expected.push({
      cityId: primaryCity.id,
      serviceId: service.id,
      pageType: 'service-money',
      pageSlug: normalizePath(`/${service.pathSegment || service.id}`),
    });
  }

  return expected;
}

function validateGeneratedPages() {
  const cityMap = new Map(cities.map((city) => [city.id, city]));
  const serviceMap = new Map(services.map((service) => [service.id, service]));
  const expectedPages = buildExpectedGeneratedPages();
  const expectedBySlug = new Map(expectedPages.map((page) => [normalizePath(page.pageSlug), page]));

  if (generatedPages.length !== expectedPages.length) {
    throw new Error(
      `[geo-data] generated-pages length mismatch: expected ${expectedPages.length}, got ${generatedPages.length}. Run "npm run build:data".`
    );
  }

  const seenSlugs = new Set<string>();
  for (const page of generatedPages) {
    const slug = normalizePath(page.pageSlug);
    if (seenSlugs.has(slug)) {
      throw new Error(`[geo-data] duplicate generated page slug "${slug}"`);
    }
    seenSlugs.add(slug);

    const city = cityMap.get(page.cityId);
    if (!city) throw new Error(`[geo-data] page "${slug}" references unknown city "${page.cityId}"`);

    const service = serviceMap.get(page.serviceId);
    if (!service) throw new Error(`[geo-data] page "${slug}" references unknown service "${page.serviceId}"`);

    const expected = expectedBySlug.get(slug);
    if (!expected) throw new Error(`[geo-data] page "${slug}" is not expected by data model`);
    if (expected.pageType !== page.pageType) {
      throw new Error(`[geo-data] page "${slug}" has invalid pageType "${page.pageType}"`);
    }
    if (page.pageType !== 'service-money') {
      throw new Error(`[geo-data] page "${slug}" must be service-money, got "${page.pageType}"`);
    }
    if (page.cityId !== expected.cityId) {
      throw new Error(`[geo-data] page "${slug}" has invalid cityId "${page.cityId}"`);
    }

    if (!page.cityName || !page.serviceName || !page.clusterId || !page.locationLabel || !page.primaryKeyword) {
      throw new Error(`[geo-data] page "${slug}" is missing generated metadata fields`);
    }
    if (!isIndexabilityPolicy(String(page.indexabilityPolicy || ''))) {
      throw new Error(`[geo-data] page "${slug}" has invalid indexabilityPolicy "${String(page.indexabilityPolicy)}"`);
    }
    if (!isPriorityTier(String(page.priorityTier || ''))) {
      throw new Error(`[geo-data] page "${slug}" has invalid priorityTier "${String(page.priorityTier)}"`);
    }
    if (!isReleaseStage(String(page.releaseStage || ''))) {
      throw new Error(`[geo-data] page "${slug}" has invalid releaseStage "${String(page.releaseStage)}"`);
    }
    if (
      !Number.isFinite(Number(page.readinessScore)) ||
      Number(page.readinessScore) < 0 ||
      Number(page.readinessScore) > 100
    ) {
      throw new Error(`[geo-data] page "${slug}" has invalid readinessScore "${String(page.readinessScore)}"`);
    }

    const isIndexable = normalizeIndexabilityPolicy(page.indexabilityPolicy, page.pageType) === 'index';
    if (isIndexable && page.releaseStage !== 'index_trial' && page.releaseStage !== 'index_stable') {
      throw new Error(`[geo-data] indexable page "${slug}" must be index_trial or index_stable`);
    }
    if (!isIndexable && (page.releaseStage === 'index_trial' || page.releaseStage === 'index_stable')) {
      throw new Error(`[geo-data] non-indexable page "${slug}" cannot be index_trial/index_stable`);
    }
    if (!Array.isArray(page.faq) || page.faq.length === 0) {
      throw new Error(`[geo-data] page "${slug}" has empty faq list`);
    }
    if (!Array.isArray(page.related) || page.related.length < 2) {
      throw new Error(`[geo-data] page "${slug}" must have at least 2 related links`);
    }
  }

  for (const expected of expectedPages) {
    const slug = normalizePath(expected.pageSlug);
    if (!seenSlugs.has(slug)) {
      throw new Error(`[geo-data] expected generated page "${slug}" is missing`);
    }
  }
}

validateDataModel();
validateGeneratedPages();

const sortedCities = Object.freeze([...cities].sort((a, b) => Number(a.priority) - Number(b.priority)));
const moneyServices = Object.freeze(services.filter((service) => service.moneyPage));
export function getCities(): CityModel[] {
  return [...sortedCities];
}

export function getDistricts(): DistrictModel[] {
  return [...districts];
}

export function getServices(): ServiceModel[] {
  return [...services];
}

export function getMoneyServices(): ServiceModel[] {
  return [...moneyServices];
}

export function getGeneratedPages(): GeneratedGeoPage[] {
  return [...generatedPages];
}

export function getCityById(cityId: string): CityModel | undefined {
  return sortedCities.find((city) => city.id === cityId);
}

export function getDistrictById(districtId: string): DistrictModel | undefined {
  return districts.find((district) => district.id === districtId);
}

export function getServiceById(serviceId: string): ServiceModel | undefined {
  return services.find((service) => service.id === serviceId);
}

export function getGeneratedPageBySlug(pageSlug: string): GeneratedGeoPage | undefined {
  const slug = normalizePath(pageSlug);
  return generatedPages.find((page) => normalizePath(page.pageSlug) === slug);
}

export function isGeneratedPageIndexable(page: GeneratedGeoPage): boolean {
  return normalizeIndexabilityPolicy(page.indexabilityPolicy, page.pageType) === 'index';
}

export function getGeneratedPageRobots(page: GeneratedGeoPage): MetaDataRobots {
  const policy = normalizeIndexabilityPolicy(page.indexabilityPolicy, page.pageType);
  return {
    index: policy === 'index',
    follow: policy !== 'noindex_nofollow',
  };
}

export function getCityDistricts(cityId: string): DistrictModel[] {
  return districts.filter((district) => district.cityId === cityId);
}

export function getCityHubPath(cityId: string): string {
  const normalized = String(cityId || '')
    .trim()
    .toLowerCase();
  if (!normalized) return '/';
  return normalizePath(`/${normalized}`);
}

export function getCityHubPaths(): string[] {
  return sortedCities.map((city) => getCityHubPath(city.id));
}
