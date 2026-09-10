import localCityBlocksRaw from '../../data/local-city-blocks.json';

import { getCities, getMoneyServices } from '~/lib/geo-data';
import type {
  LocalCase,
  LocalCityBlock,
  LocalCityBlocksByService,
  LocalCityId,
  LocalOffer,
  LocalPriceRange,
  LocalReview,
  LocalServiceBlocks,
  LocalDeliverySla,
} from '~/types/geo-seo';

const REQUIRED_BLOCK_KEYS = ['cases', 'city', 'offer', 'priceRange', 'reviews', 'sla'] as const;
const REQUIRED_CASE_KEYS = ['alt', 'city', 'image', 'location', 'photos', 'summary', 'title', 'year'] as const;
const OPTIONAL_CASE_KEYS = ['area', 'district', 'projectSlug'] as const;
const REQUIRED_REVIEW_KEYS = ['author', 'location', 'rating', 'text'] as const;
const REQUIRED_PRICE_RANGE_KEYS = ['currency', 'from', 'note', 'to'] as const;
const REQUIRED_SLA_KEYS = ['installationDays', 'measurementDays', 'note', 'productionDays'] as const;
const REQUIRED_OFFER_KEYS = ['description', 'title'] as const;
const MIN_CASES_BY_CITY: Record<LocalCityId, number> = {
  irkutsk: 2,
  angarsk: 1,
  shelekhov: 1,
};

const localCityBlocks = Object.freeze(localCityBlocksRaw as LocalCityBlocksByService);

function assertExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  label: string,
  optionalKeys: readonly string[] = []
) {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const missingRequired = requiredKeys.filter((key) => !actual.includes(key));
  const extraKeys = actual.filter((key) => !allowed.has(key));

  if (missingRequired.length > 0 || extraKeys.length > 0) {
    throw new Error(
      `[local-city-blocks] ${label} keys mismatch: missing [${missingRequired.join(', ')}], extra [${extraKeys.join(
        ', '
      )}], actual [${actual.join(', ')}]`
    );
  }
}

function assertNonEmptyString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[local-city-blocks] ${label} must be a non-empty string`);
  }
}

function assertPositiveNumber(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`[local-city-blocks] ${label} must be a positive number`);
  }
}

function validateCase(serviceId: string, cityId: string, value: LocalCase, index: number) {
  assertExactKeys(
    value as unknown as Record<string, unknown>,
    REQUIRED_CASE_KEYS,
    `${serviceId}.${cityId}.cases[${index}]`,
    OPTIONAL_CASE_KEYS
  );
  assertNonEmptyString(value.title, `${serviceId}.${cityId}.cases[${index}].title`);
  if (value.city !== cityId) {
    throw new Error(`[local-city-blocks] ${serviceId}.${cityId}.cases[${index}].city must equal "${cityId}"`);
  }
  assertNonEmptyString(value.location, `${serviceId}.${cityId}.cases[${index}].location`);
  if (typeof value.district !== 'undefined') {
    assertNonEmptyString(value.district, `${serviceId}.${cityId}.cases[${index}].district`);
  }
  const year = Number(value.year);
  if (!Number.isInteger(year) || year < 2000) {
    throw new Error(`[local-city-blocks] ${serviceId}.${cityId}.cases[${index}].year must be an integer >= 2000`);
  }
  if (typeof value.area !== 'undefined') {
    assertPositiveNumber(value.area, `${serviceId}.${cityId}.cases[${index}].area`);
  }
  assertNonEmptyString(value.summary, `${serviceId}.${cityId}.cases[${index}].summary`);
  assertNonEmptyString(value.image, `${serviceId}.${cityId}.cases[${index}].image`);
  if (!Array.isArray(value.photos) || value.photos.length < 2) {
    throw new Error(`[local-city-blocks] ${serviceId}.${cityId}.cases[${index}].photos must contain at least 2 items`);
  }
  value.photos.forEach((photo, photoIndex) =>
    assertNonEmptyString(photo, `${serviceId}.${cityId}.cases[${index}].photos[${photoIndex}]`)
  );
  assertNonEmptyString(value.alt, `${serviceId}.${cityId}.cases[${index}].alt`);
  if (typeof value.projectSlug !== 'undefined') {
    assertNonEmptyString(value.projectSlug, `${serviceId}.${cityId}.cases[${index}].projectSlug`);
  }
}

function validateReview(serviceId: string, cityId: string, value: LocalReview, index: number) {
  assertExactKeys(
    value as unknown as Record<string, unknown>,
    REQUIRED_REVIEW_KEYS,
    `${serviceId}.${cityId}.reviews[${index}]`
  );
  assertNonEmptyString(value.author, `${serviceId}.${cityId}.reviews[${index}].author`);
  assertNonEmptyString(value.location, `${serviceId}.${cityId}.reviews[${index}].location`);
  assertNonEmptyString(value.text, `${serviceId}.${cityId}.reviews[${index}].text`);
  const rating = Number(value.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new Error(`[local-city-blocks] ${serviceId}.${cityId}.reviews[${index}].rating must be between 1 and 5`);
  }
}

function validatePriceRange(serviceId: string, cityId: string, value: LocalPriceRange) {
  assertExactKeys(
    value as unknown as Record<string, unknown>,
    REQUIRED_PRICE_RANGE_KEYS,
    `${serviceId}.${cityId}.priceRange`
  );
  assertPositiveNumber(value.from, `${serviceId}.${cityId}.priceRange.from`);
  assertPositiveNumber(value.to, `${serviceId}.${cityId}.priceRange.to`);
  assertNonEmptyString(value.currency, `${serviceId}.${cityId}.priceRange.currency`);
  assertNonEmptyString(value.note, `${serviceId}.${cityId}.priceRange.note`);
}

function validateSla(serviceId: string, cityId: string, value: LocalDeliverySla) {
  assertExactKeys(value as unknown as Record<string, unknown>, REQUIRED_SLA_KEYS, `${serviceId}.${cityId}.sla`);
  assertPositiveNumber(value.measurementDays, `${serviceId}.${cityId}.sla.measurementDays`);
  assertPositiveNumber(value.productionDays, `${serviceId}.${cityId}.sla.productionDays`);
  assertPositiveNumber(value.installationDays, `${serviceId}.${cityId}.sla.installationDays`);
  assertNonEmptyString(value.note, `${serviceId}.${cityId}.sla.note`);
}

function validateOffer(serviceId: string, cityId: string, value: LocalOffer) {
  assertExactKeys(value as unknown as Record<string, unknown>, REQUIRED_OFFER_KEYS, `${serviceId}.${cityId}.offer`);
  assertNonEmptyString(value.title, `${serviceId}.${cityId}.offer.title`);
  assertNonEmptyString(value.description, `${serviceId}.${cityId}.offer.description`);
}

function validateBlock(serviceId: string, cityId: LocalCityId, value: LocalCityBlock) {
  assertExactKeys(value as unknown as Record<string, unknown>, REQUIRED_BLOCK_KEYS, `${serviceId}.${cityId}`);

  if (value.city !== cityId) {
    throw new Error(`[local-city-blocks] ${serviceId}.${cityId}.city must equal "${cityId}", got "${value.city}"`);
  }

  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error(`[local-city-blocks] ${serviceId}.${cityId}.cases must contain at least one case`);
  }
  if (value.cases.length < MIN_CASES_BY_CITY[cityId]) {
    throw new Error(
      `[local-city-blocks] ${serviceId}.${cityId}.cases must contain at least ${MIN_CASES_BY_CITY[cityId]} items`
    );
  }
  if (!Array.isArray(value.reviews) || value.reviews.length === 0) {
    throw new Error(`[local-city-blocks] ${serviceId}.${cityId}.reviews must contain at least one review`);
  }

  value.cases.forEach((item, index) => validateCase(serviceId, cityId, item, index));
  value.reviews.forEach((item, index) => validateReview(serviceId, cityId, item, index));
  validatePriceRange(serviceId, cityId, value.priceRange);
  validateSla(serviceId, cityId, value.sla);
  validateOffer(serviceId, cityId, value.offer);
}

function validateLocalCityBlocksModel() {
  const cityIds = getCities().map((city) => city.id as LocalCityId);
  const serviceIds = getMoneyServices().map((service) => service.id);

  const actualServiceIds = Object.keys(localCityBlocks).sort();
  const expectedServiceIds = [...serviceIds].sort();
  if (
    actualServiceIds.length !== expectedServiceIds.length ||
    actualServiceIds.some((key, index) => key !== expectedServiceIds[index])
  ) {
    throw new Error(
      `[local-city-blocks] service ids mismatch: expected [${expectedServiceIds.join(', ')}], got [${actualServiceIds.join(', ')}]`
    );
  }

  for (const serviceId of serviceIds) {
    const blocksByCity = localCityBlocks[serviceId];
    if (!blocksByCity || typeof blocksByCity !== 'object') {
      throw new Error(`[local-city-blocks] ${serviceId} must be an object keyed by city`);
    }

    const actualCityIds = Object.keys(blocksByCity).sort();
    const expectedCityIds = [...cityIds].sort();
    if (
      actualCityIds.length !== expectedCityIds.length ||
      actualCityIds.some((key, index) => key !== expectedCityIds[index])
    ) {
      throw new Error(
        `[local-city-blocks] ${serviceId} city ids mismatch: expected [${expectedCityIds.join(', ')}], got [${actualCityIds.join(', ')}]`
      );
    }

    for (const cityId of cityIds) {
      validateBlock(serviceId, cityId, blocksByCity[cityId]);
    }
  }
}

validateLocalCityBlocksModel();

export function getLocalServiceBlocks(serviceId: string): LocalServiceBlocks {
  const blocks = localCityBlocks[serviceId];
  if (!blocks) {
    throw new Error(`[local-city-blocks] unknown service "${serviceId}"`);
  }
  return blocks;
}

export function getLocalCityBlocksForService(serviceId: string): LocalCityBlock[] {
  const blocks = getLocalServiceBlocks(serviceId);
  return getCities().map((city) => blocks[city.id as LocalCityId]);
}

export function getLocalCityBlock(serviceId: string, cityId: LocalCityId): LocalCityBlock {
  const blocks = getLocalServiceBlocks(serviceId);
  const block = blocks[cityId];
  if (!block) {
    throw new Error(`[local-city-blocks] missing block for service "${serviceId}" and city "${cityId}"`);
  }
  return block;
}
