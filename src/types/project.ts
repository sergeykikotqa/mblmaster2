export type ProjectCardData = {
  slug: string;
  href: string;
  title: string;
  description: string;
  cityLabel: string;
  serviceLabel: string;
  coverImage: string;
  calloutText?: string;
  contextLabel?: string;
  locationLabel?: string;
  audienceLabel?: string;
  priceLabel?: string;
  priceNote?: string;
  priceIsEstimated?: boolean;
  durationLabel?: string;
  areaLabel?: string;
  ctaLabel?: string;
  secondaryCtaLabel?: string;
  secondaryCtaHref?: string;
  proofHighlight?: { label: string; value: string };
  areaValue?: number;
  priceValue?: number;
  layoutToken?: string;
  serviceId?: string;
};

export type ProjectVideoCard = {
  title: string;
  href: string;
  image: string;
  meta: string;
  description?: string;
  locationLabel?: string;
  platformLabel?: string;
  publishedLabel?: string;
  serviceLabel?: string;
};

export type ProjectBreadcrumbItem = {
  label: string;
  href?: string;
};

export type ProjectQuickSpec = { label: string; value: string };
export type ProjectHeroTag = { text: string; tone?: 'accent' | 'neutral' | 'success' };
export type ProjectHeroStat = { label: string; value: string };

export type ProjectSummaryFact = {
  key: string;
  label: string;
  value: string;
  icon: string;
  tone?: 'accent' | 'neutral' | 'success';
};

export type ProjectRailBenefit = { icon: string; text: string };

export type ProjectTocItem = { id: string; label: string };

export type ProjectCostBreakdownItem = { label: string; value: string; note: string };
