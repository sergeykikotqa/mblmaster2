import type { MetaData } from '~/types';

export type GeoPageType = 'service-money';
export type IndexabilityPolicy = 'index' | 'noindex_follow' | 'noindex_nofollow';
export type LegacyIndexabilityPolicy = 'noindex';
export type PersistedIndexabilityPolicy = IndexabilityPolicy | LegacyIndexabilityPolicy;
export type ReleaseStage = 'draft' | 'noindex_live' | 'index_trial' | 'index_stable' | 'rollback_noindex';
export type PriorityTier = 'A' | 'B' | 'C';
export type LocalCityId = 'irkutsk';

export interface CityModel {
  id: string;
  name: string;
  nameIn?: string;
  nameGenitive?: string;
  hasDistricts: boolean;
  priority: number;
}

export interface DistrictModel {
  id: string;
  name: string;
  nameIn?: string;
  cityId: string;
}

export interface ServiceModel {
  id: string;
  pathSegment: string;
  name: string;
  forms: {
    nominative: string;
    genitive: string;
    prepositional: string;
    accusative: string;
  };
  moneyPage: boolean;
  hasDistrictPages: boolean;
}

export interface GeneratedPageFaqItem {
  q: string;
  a: string;
}

export interface GeneratedPageRelatedLink {
  title: string;
  href: string;
  relation: string;
}

export interface GeneratedGeoPage {
  cityId: string;
  cityName: string;
  cityNameIn: string;
  cityNameGenitive: string;
  serviceId: string;
  serviceName: string;
  pageType: GeoPageType;
  clusterId: string;
  pageSlug: string;
  locationLabel: string;
  primaryKeyword: string;
  indexabilityPolicy?: PersistedIndexabilityPolicy;
  releaseStage?: ReleaseStage;
  readinessScore?: number;
  priorityTier?: PriorityTier;
  rolloutDecisionReason?: string;
  faq: GeneratedPageFaqItem[];
  related: GeneratedPageRelatedLink[];
}

export interface ServicePageContext {
  cityId: string;
  serviceId: string;
  pageType: GeoPageType;
  url: string;
  canonical: string;
}

export interface LeadPayloadContext {
  city: string;
  service: string;
  pageType: GeoPageType;
  pageSlug: string;
}

export interface ServiceTemplate {
  title: string;
  description: string;
  h1: string;
  heroSubtitle?: string;
}

export interface ServiceSeoResult {
  metadata: MetaData;
  h1: string;
  heroSubtitle: string;
  locationLabel: string;
  primaryKeyword: string;
}

export interface CityHubSeoResult {
  metadata: MetaData;
  h1: string;
  heroSubtitle: string;
}

export interface LocalCase {
  title: string;
  city: LocalCityId;
  location: string;
  district?: string;
  year: number;
  area?: number;
  summary: string;
  image: string;
  photos: string[];
  alt: string;
  projectSlug?: string;
}

export interface LocalReview {
  author: string;
  location: string;
  text: string;
  rating: number;
}

export interface LocalOffer {
  title: string;
  description: string;
}

export interface LocalCityBlock {
  city: LocalCityId;
  cases: LocalCase[];
  reviews: LocalReview[];
  offer: LocalOffer;
}

export type LocalServiceBlocks = Record<LocalCityId, LocalCityBlock>;
export type LocalCityBlocksByService = Record<string, LocalServiceBlocks>;
