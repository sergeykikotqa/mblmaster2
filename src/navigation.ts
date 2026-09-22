import { getPermalink } from './utils/permalinks';
import { getBusinessInfo } from './config/business-info';

const businessInfo = getBusinessInfo();

export const headerData = {
  links: [
    { text: 'Главная', href: getPermalink('/') },
    { text: 'Кухни на заказ', href: getPermalink('/kuhni') },
    { text: 'Шкафы-купе', href: getPermalink('/shkafy') },
    { text: 'Гардеробные', href: getPermalink('/garderobnye') },
    { text: 'Кейсы', href: getPermalink('/projects') },
    { text: 'Статьи', href: getPermalink('/articles') },
    { text: 'О компании', href: getPermalink('/o-kompanii') },
    { text: 'Контакты', href: getPermalink('/contacts') },
  ],
  actions: [
    { text: 'Рассчитать проект', href: getPermalink('/contacts') + '#contact' },
    { text: 'Вызвать замерщика', href: getPermalink('/contacts') + '#contacts-info' },
  ],
};

export const footerData = {
  links: [
    {
      title: 'Основные страницы',
      links: [
        { text: 'Кухни на заказ', href: getPermalink('/kuhni') },
        { text: 'Шкафы-купе', href: getPermalink('/shkafy') },
        { text: 'Гардеробные', href: getPermalink('/garderobnye') },
        { text: 'Кейсы проектов', href: getPermalink('/projects') },
      ],
    },
    {
      title: 'Города',
      links: [],
    },
    {
      title: 'Компания',
      links: [
        { text: 'О компании', href: getPermalink('/o-kompanii') },
        { text: 'Контакты', href: getPermalink('/contacts') },
        { text: 'Гайды', href: getPermalink('/guides') },
        { text: 'FAQ', href: getPermalink('/faq') },
      ],
    },
    {
      title: 'Отзывы и каталоги',
      links: [
        {
          text: 'Яндекс.Карты',
          href: businessInfo.yandexMapsUrl,
          icon: 'brand-yandex',
          iconClass: 'h-5 w-auto max-w-[96px] opacity-80 grayscale transition group-hover:opacity-100 group-hover:grayscale-0',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        {
          text: 'Google Maps',
          href: businessInfo.googleMapsUrl,
          icon: 'tabler:brand-google-maps',
          iconClass: 'h-5 w-auto max-w-[96px] opacity-80 grayscale transition group-hover:opacity-100 group-hover:grayscale-0',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        {
          text: 'Zoon',
          href: 'https://zoon.ru/irkutsk/shops/ofis_mbl_master/#form',
          icon: 'brand-zoon',
          iconClass: 'h-5 w-auto max-w-[96px] opacity-80 grayscale transition group-hover:opacity-100 group-hover:grayscale-0',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        {
          text: 'ВКонтакте',
          href: 'https://vk.com/mebelirkutskmbl#form',
          icon: 'brand-vk',
          iconClass: 'h-5 w-auto max-w-[96px] opacity-80 grayscale transition group-hover:opacity-100 group-hover:grayscale-0',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
      ],
    },
  ],
  secondaryLinks: [
    { text: 'Политика конфиденциальности', href: getPermalink('/privacy') },
    { text: 'Условия использования', href: getPermalink('/terms') },
  ],
  socialLinks: [],
};
