type EnvLike = Record<string, string | undefined>;

type ResolveBusinessInfoOptions = {
  siteUrl?: string;
};

export type BusinessInfo = {
  phone: string;
  email: string;
  addressLocality: string;
  addressDistrict: string;
  streetAddress: string;
  addressRegion: string;
  postalCode: string;
  fullAddress: string;
  openingHours: string[];
  openingHoursText: string;
  openingHoursTextLines: string[];
  phoneHref: string;
  priceRange: string;
  latitude: number;
  longitude: number;
  sameAs: string[];
  telegramUrl: string;
  yandexMapsUrl: string;
  googleMapsUrl: string;
  imageUrl: string;
  legal: {
    businessName: string;
    taxId: string;
    registrationId: string;
    checkingAccount: string;
    bic: string;
    bankName: string;
    registeredAddress: string;
  };
};

const DEFAULTS = {
  phone: '+7 (964) 107-26-13',
  email: 'MBLmaster38@yandex.ru',
  addressLocality: 'Иркутск',
  addressDistrict: 'Куйбышевский район',
  streetAddress: 'м-н Зелёный, 34/2, цокольный этаж',
  addressRegion: 'Иркутская область',
  postalCode: '664078',
  openingHours: 'Mo-Su 10:00-19:00',
  openingHoursText: 'Ежедневно: 10:00-19:00',
  priceRange: '₽₽',
  latitude: 52.326639,
  longitude: 104.363083,
  telegramUrl: '',
  yandexMapsUrl:
    'https://yandex.ru/maps/?ll=104.363083%2C52.326639&mode=search&pt=104.363083,52.326639,pm2rdm&text=%D0%9C%D0%B1%D0%BB%20%D0%BC%D0%B0%D1%81%D1%82%D0%B5%D1%80&z=17',
  googleMapsUrl:
    'https://www.google.com/maps/place/%D0%9C%D0%B1%D0%BB+%D0%BC%D0%B0%D1%81%D1%82%D0%B5%D1%80/@52.3261538,104.3633029,1644m/data=!3m1!1e3!4m6!3m5!1s0x5da83ac4baa18885:0x3989ac90b4910feb!8m2!3d52.3274351!4d104.3666687!16s%2Fg%2F11d_z46y98?authuser=0&entry=ttu&g_ep=EgoyMDI2MDMxNy4wIKXMDSoASAFQAw%3D%3D',
  legalBusinessName: 'ИП Макшанов Павел Григорьевич',
  legalTaxId: '381111834274',
  legalRegistrationId: '324385000056315',
  legalCheckingAccount: '40802810923580007209',
  legalBic: '045004774',
  legalBankName: 'ФИЛИАЛ "НОВОСИБИРСКИЙ" АО "АЛЬФА-БАНК"',
  legalRegisteredAddress: 'Иркутская обл. г. Иркутск, Юбилейный, д. 34, кв. 2',
} as const;

function readEnv(env: EnvLike, key: string, fallback: string): string {
  return String(env[key] || fallback).trim();
}

function parseFiniteNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitList(value: string, separator: string): string[] {
  return String(value)
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePhoneHref(value: string): string {
  return String(value)
    .replace(/[^\d+]/g, '')
    .replace(/^8(?=\d{10}$)/, '+7');
}

export function resolveBusinessInfo(
  env: EnvLike = process.env,
  options: ResolveBusinessInfoOptions = {}
): BusinessInfo {
  const phone = readEnv(env, 'PUBLIC_BUSINESS_PHONE', DEFAULTS.phone);
  const email = readEnv(env, 'PUBLIC_BUSINESS_EMAIL', DEFAULTS.email);
  const addressLocality = readEnv(env, 'PUBLIC_BUSINESS_ADDRESS_LOCALITY', DEFAULTS.addressLocality);
  const addressDistrict = readEnv(env, 'PUBLIC_BUSINESS_ADDRESS_DISTRICT', DEFAULTS.addressDistrict);
  const streetAddress = readEnv(env, 'PUBLIC_BUSINESS_STREET_ADDRESS', DEFAULTS.streetAddress);
  const addressRegion = readEnv(env, 'PUBLIC_BUSINESS_REGION', DEFAULTS.addressRegion);
  const postalCode = readEnv(env, 'PUBLIC_BUSINESS_POSTAL_CODE', DEFAULTS.postalCode);
  const openingHours = splitList(readEnv(env, 'PUBLIC_BUSINESS_OPENING_HOURS', DEFAULTS.openingHours), ';');
  const openingHoursTextLines = splitList(
    readEnv(env, 'PUBLIC_BUSINESS_OPENING_HOURS_TEXT', DEFAULTS.openingHoursText),
    ';'
  );
  const fullAddress = [addressLocality, addressDistrict, streetAddress].filter(Boolean).join(', ');
  const siteUrl = String(options.siteUrl || '')
    .trim()
    .replace(/\/$/, '');
  const fallbackImagePath = '/images/projects/kuhnya-baykalskaya/01.jpg';
  const fallbackImage = siteUrl ? new URL(fallbackImagePath, siteUrl).toString() : fallbackImagePath;
  const imagePath = readEnv(env, 'PUBLIC_BUSINESS_IMAGE', fallbackImage);
  const sameAsRaw = splitList(readEnv(env, 'PUBLIC_BUSINESS_SAME_AS', ''), ',');
  const telegramEnv = readEnv(env, 'PUBLIC_TELEGRAM_URL', DEFAULTS.telegramUrl);
  const telegramFromSameAs = sameAsRaw.find((value) => /t\.me|telegram\.me/i.test(value)) || DEFAULTS.telegramUrl;
  const telegramUrl = (telegramEnv || telegramFromSameAs || '').trim();
  const yandexMapsUrl = readEnv(env, 'PUBLIC_BUSINESS_YANDEX_MAPS_URL', DEFAULTS.yandexMapsUrl);
  const googleMapsUrl = readEnv(env, 'PUBLIC_BUSINESS_GOOGLE_MAPS_URL', DEFAULTS.googleMapsUrl);
  const sameAsBase = sameAsRaw.length > 0 ? sameAsRaw : [yandexMapsUrl, googleMapsUrl, 'https://vk.com/mebelirkutskmbl'];
  const sameAsWithTelegram =
    telegramUrl && !sameAsBase.includes(telegramUrl) ? [...sameAsBase, telegramUrl] : sameAsBase;
  const sameAs = Array.from(new Set(sameAsWithTelegram.filter(Boolean)));
  const legal = {
    businessName: readEnv(env, 'PUBLIC_BUSINESS_LEGAL_NAME', DEFAULTS.legalBusinessName),
    taxId: readEnv(env, 'PUBLIC_BUSINESS_TAX_ID', DEFAULTS.legalTaxId),
    registrationId: readEnv(env, 'PUBLIC_BUSINESS_REGISTRATION_ID', DEFAULTS.legalRegistrationId),
    checkingAccount: readEnv(env, 'PUBLIC_BUSINESS_CHECKING_ACCOUNT', DEFAULTS.legalCheckingAccount),
    bic: readEnv(env, 'PUBLIC_BUSINESS_BIC', DEFAULTS.legalBic),
    bankName: readEnv(env, 'PUBLIC_BUSINESS_BANK_NAME', DEFAULTS.legalBankName),
    registeredAddress: readEnv(env, 'PUBLIC_BUSINESS_REGISTERED_ADDRESS', DEFAULTS.legalRegisteredAddress),
  };

  return {
    phone,
    email,
    addressLocality,
    addressDistrict,
    streetAddress,
    addressRegion,
    postalCode,
    fullAddress,
    openingHours,
    openingHoursText: openingHoursTextLines.join(', '),
    openingHoursTextLines,
    phoneHref: normalizePhoneHref(phone),
    priceRange: readEnv(env, 'PUBLIC_BUSINESS_PRICE_RANGE', DEFAULTS.priceRange),
    latitude: parseFiniteNumber(env.PUBLIC_BUSINESS_LAT, DEFAULTS.latitude),
    longitude: parseFiniteNumber(env.PUBLIC_BUSINESS_LON, DEFAULTS.longitude),
    sameAs,
    telegramUrl,
    yandexMapsUrl,
    googleMapsUrl,
    imageUrl: imagePath,
    legal,
  };
}
