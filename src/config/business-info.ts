import { resolveBusinessInfo, type BusinessInfo } from '~/lib/business-info';

export type { BusinessInfo };

export const getBusinessInfo = (siteUrl?: string): BusinessInfo => {
  return resolveBusinessInfo(import.meta.env, siteUrl ? { siteUrl } : {});
};
