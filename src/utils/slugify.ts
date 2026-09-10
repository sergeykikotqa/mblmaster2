import limax from 'limax';

type ProjectService = 'kuhni' | 'shkafy' | 'garderobnye';

const serviceSlugTokenByCode: Record<ProjectService, string> = {
  kuhni: 'kuhnya',
  shkafy: 'shkaf',
  garderobnye: 'garderobnaya',
};

const serviceNameByCode: Record<ProjectService, string> = {
  kuhni: 'кухня',
  shkafy: 'шкаф',
  garderobnye: 'гардеробная',
};

export interface ProjectSlugInput {
  title?: string;
  service: string;
  layout?: string;
  city: string;
  street?: string;
}

function slugifySegment(value: string): string {
  const normalized = limax(String(value || '').trim()).toLowerCase();
  return normalized
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeText(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function buildTitleSlugSegment(title: string, city: string): string {
  const cityStem = slugifySegment(city);
  let normalizedTitle = slugifySegment(title);

  if (!normalizedTitle) return '';

  if (cityStem) {
    normalizedTitle = normalizedTitle.replace(
      new RegExp(`-na-zakaz(?:-(?:v|vo)-${cityStem}[a-z0-9-]*)?$`, 'i'),
      ''
    );
    normalizedTitle = normalizedTitle.replace(new RegExp(`-(?:v|vo)-${cityStem}[a-z0-9-]*$`, 'i'), '');
  } else {
    normalizedTitle = normalizedTitle.replace(/-na-zakaz$/i, '');
  }

  return normalizedTitle.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function generateProjectSlug(input: ProjectSlugInput): string {
  const serviceCode = String(input.service || '')
    .trim()
    .toLowerCase() as ProjectService;
  const serviceToken = serviceSlugTokenByCode[serviceCode] || serviceCode || 'project';
  const cityToken = slugifySegment(String(input.city || ''));
  const streetToken = slugifySegment(String(input.street || ''));
  const titleToken = buildTitleSlugSegment(String(input.title || ''), String(input.city || ''));

  if (!streetToken && titleToken) {
    const titleHasServiceToken =
      titleToken === serviceToken ||
      titleToken.startsWith(`${serviceToken}-`) ||
      titleToken.endsWith(`-${serviceToken}`) ||
      titleToken.includes(`-${serviceToken}-`);

    const parts = [titleHasServiceToken ? '' : serviceToken, titleToken, cityToken].filter(Boolean);
    if (parts.length > 0) return parts.join('-');
  }

  const parts = [serviceToken, input.layout, input.city, input.street]
    .map((value) => slugifySegment(String(value || '')))
    .filter(Boolean);

  return parts.join('-');
}

export function generateAlt(
  layout: string | undefined,
  city: string,
  street: string | undefined,
  service: string
): string {
  const serviceCode = String(service || '')
    .trim()
    .toLowerCase() as ProjectService;
  const serviceName = serviceNameByCode[serviceCode] || 'проект мебели';

  const text = [
    normalizeText(layout || ''),
    `${serviceName} на заказ`,
    normalizeText(city),
    normalizeText(street || ''),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return text || `${serviceName} на заказ`;
}
