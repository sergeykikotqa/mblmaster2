import {
  SERVICE_ANCHORS as SERVICE_ANCHORS_RAW,
  SERVICE_CONTEXT_ANCHORS as SERVICE_CONTEXT_ANCHORS_RAW,
} from './anchor-map.js';

export type AnchorType = 'exact' | 'partial' | 'natural' | 'generic';

export type AnchorTemplate = {
  text: string;
  needsCity?: boolean;
  needsCityIn?: boolean;
};

export type AnchorSet = Record<AnchorType, AnchorTemplate[]>;

type CityContext = {
  name?: string | null;
  in?: string | null;
};

const ANCHOR_TYPE_WEIGHTS: Array<{ type: AnchorType; weight: number }> = [
  { type: 'exact', weight: 2 },
  { type: 'partial', weight: 6 },
  { type: 'natural', weight: 4 },
  { type: 'generic', weight: 1 },
];

export const SERVICE_ANCHORS = SERVICE_ANCHORS_RAW as Record<string, AnchorSet>;
export const SERVICE_CONTEXT_ANCHORS = SERVICE_CONTEXT_ANCHORS_RAW as Record<string, AnchorSet>;

export const hashString = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const resolveAnchorText = (template: AnchorTemplate, city: CityContext | null) => {
  const cityName = city?.name || '';
  const cityIn = city?.in || '';
  if (template.needsCity && !cityName) return null;
  if (template.needsCityIn && !cityIn) return null;
  return template.text
    .replace('{city}', cityName)
    .replace('{cityIn}', cityIn)
    .replace(/\s+/g, ' ')
    .trim();
};

const pickWeightedType = (seed: number, allowedTypes?: AnchorType[]): AnchorType => {
  const filtered = allowedTypes?.length
    ? ANCHOR_TYPE_WEIGHTS.filter((item) => allowedTypes.includes(item.type))
    : ANCHOR_TYPE_WEIGHTS;
  const total = filtered.reduce((acc, item) => acc + item.weight, 0);
  if (!total) return 'partial';
  const slot = seed % total;
  let cursor = 0;
  for (const item of filtered) {
    cursor += item.weight;
    if (slot < cursor) return item.type;
  }
  return filtered[0]?.type || 'partial';
};

export const selectServiceAnchor = ({
  serviceKey,
  seed,
  city,
  usedAnchors,
  allowedTypes,
  disallow,
  anchorSet,
}: {
  serviceKey: string;
  seed: number;
  city: CityContext | null;
  usedAnchors?: Set<string>;
  allowedTypes?: AnchorType[];
  disallow?: (value: string) => boolean;
  anchorSet?: AnchorSet;
}): { text: string; type: AnchorType } | null => {
  const resolvedAnchorSet = anchorSet || SERVICE_ANCHORS[serviceKey];
  if (!resolvedAnchorSet) return null;
  const typeOrder: AnchorType[] = [];
  const primaryType = pickWeightedType(seed, allowedTypes);
  typeOrder.push(primaryType);
  const fallbackTypes = (allowedTypes?.length
    ? allowedTypes
    : (['exact', 'partial', 'natural', 'generic'] as AnchorType[])
  ).filter((type) => type !== primaryType);
  typeOrder.push(...fallbackTypes);

  for (const type of typeOrder) {
    const candidates = resolvedAnchorSet[type]
      .map((template) => resolveAnchorText(template, city))
      .filter((value): value is string => Boolean(value))
      .filter((value) => !usedAnchors || !usedAnchors.has(value));
    const filtered = disallow ? candidates.filter((value) => !disallow(value)) : candidates;
    const usable = filtered.length > 0 ? filtered : candidates;
    if (usable.length === 0) continue;
    const pick = usable[seed % usable.length];
    if (pick) {
      return { text: pick, type };
    }
  }

  return null;
};
