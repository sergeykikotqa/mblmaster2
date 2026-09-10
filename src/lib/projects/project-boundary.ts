import type { CollectionEntry } from 'astro:content';
import type { ServiceLabels } from '~/utils/seo';

export type RawProject = unknown;

type RawRecord = Record<string, unknown>;

const toRecord = (value: RawProject): RawRecord =>
  typeof value === 'object' && value !== null ? (value as RawRecord) : {};

const readString = (source: RawRecord, key: string): string => {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
};

const readNumber = (source: RawRecord, key: string): number | null => {
  const value = source[key];
  const numeric = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
};

const readServiceLabelOverride = (source: RawRecord, key: string): ServiceLabels | undefined => {
  const value = source[key];
  if (typeof value !== 'object' || value === null) return undefined;

  const record = toRecord(value);
  const noun = readString(record, 'noun');
  const plural = readString(record, 'plural');
  const genitive = readString(record, 'genitive');
  const accusative = readString(record, 'accusative');

  if (!noun || !plural || !genitive || !accusative) return undefined;

  return {
    noun,
    plural,
    genitive,
    accusative,
  };
};

export type ProjectBoundarySnapshot = {
  body: string;
  imageBaseDir: string;
  estimatedPrice: number | null;
  estimatedPriceNote: string;
  serviceLabelOverride: ServiceLabels | undefined;
};

export const readProjectBoundary = (entry: CollectionEntry<'projects'>): ProjectBoundarySnapshot => {
  const entryRecord = toRecord(entry as RawProject);
  const dataRecord = toRecord(entryRecord.data);

  return {
    body: readString(entryRecord, 'body'),
    imageBaseDir: readString(dataRecord, 'imageBaseDir'),
    estimatedPrice: readNumber(dataRecord, 'estimatedPrice'),
    estimatedPriceNote: readString(dataRecord, 'estimatedPriceNote'),
    serviceLabelOverride: readServiceLabelOverride(dataRecord, 'serviceLabelOverride'),
  };
};
