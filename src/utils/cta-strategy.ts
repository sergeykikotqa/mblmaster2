import { hashString } from '~/utils/anchor-strategy';

type CtaConfig = {
  title: string;
  subtitle: string;
  actions: string[];
};

const DEFAULT_CTA: CtaConfig = {
  title: 'Получить расчет по вашему проекту',
  subtitle: 'Подскажем по материалам, срокам и бюджету и подготовим предварительную смету.',
  actions: ['Получить расчет', 'Получить смету'],
};

const SERVICE_CTA: Record<string, CtaConfig> = {
  kuhni: {
    title: 'Рассчитать кухню под вашу планировку',
    subtitle: 'Подберем материалы, сроки и бюджет под размеры вашей кухни в Иркутске, Ангарске или Шелехове.',
    actions: ['Рассчитать кухню под свои размеры', 'Получить проект кухни'],
  },
  shkafy: {
    title: 'Подобрать шкаф под размеры комнаты',
    subtitle: 'Согласуем наполнение, материалы и сроки, чтобы шкаф-купе точно встал в вашу нишу.',
    actions: ['Рассчитать шкаф под свои размеры', 'Подобрать шкаф под размеры'],
  },
  garderobnye: {
    title: 'Спланировать гардеробную под помещение',
    subtitle: 'Разложим зоны хранения и подготовим смету под ваши габариты и объем вещей.',
    actions: ['Рассчитать гардеробную под свои размеры', 'Получить план гардеробной'],
  },
};

export function getContextCta(params: { serviceId?: string | null; pageSlug: string }) {
  const { serviceId, pageSlug } = params;
  const config = (serviceId && SERVICE_CTA[serviceId]) || DEFAULT_CTA;
  const seed = hashString(`${serviceId || 'default'}:${pageSlug}`);
  const action = config.actions[seed % config.actions.length] || config.actions[0];
  return {
    title: config.title,
    subtitle: config.subtitle,
    cta: action,
  };
}
