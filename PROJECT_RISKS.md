# 3 самые большие дыры (на 2026-03-15)

1. Статьи сейчас не индексируются.
- Доказательство: `data/article-seo-state.json` пустой (`readyArticlePaths: []`), а `src/config/indexability-policy.ts` помечает `/articles` и `/articles/*` как `temp-noindex`.
- Риск: инфоконтент не попадает в индекс/карту сайта, теряем поисковый трафик со статей.
- Что делать: заполнить `readyArticlePaths` (или включить `hasReadyArticles: true`) после контент‑QA и прогнать `npm run check:article-seo-rollout`.

2. Вебмастер/локальный schema‑сигнал для Яндекса не подтвержден и ограничен одним адресом.
- Доказательство: `src/components/common/SiteVerification.astro` ждёт `PUBLIC_YANDEX_VERIFICATION`, но в репозитории значения нет. `src/layouts/Layout.astro` генерирует `KitchenCabinetStore` с одним `PostalAddress` и лишь `areaServed` по Иркутску/Ангарску/Шелехову.
- Риск: в Яндекс.Вебмастере может не подтвердиться сайт; локальные сигналы по трём городам слабее (нет отдельных адресов/узлов LocalBusiness).
- Что делать: зафиксировать `PUBLIC_YANDEX_VERIFICATION` в окружении продакшена и, если есть реальные адреса, расширить schema отдельными `LocalBusiness`/`PostalAddress` по каждому городу.

3. Лиды критично завязаны на Turnstile и Netlify Functions.
- Доказательство: `src/pages/api/leads.ts` требует Turnstile в production; `Layout.astro` передаёт ключи через env; адаптер Netlify активен в prod (`astro.config.ts`).
- Риск: при отсутствии `TURNSTILE_SECRET_KEY`/`PUBLIC_TURNSTILE_SITE_KEY` или недоступности функций заявки будут падать (500/403), форма фактически «молчит».
- Что делать: обязательно настроить ключи Turnstile и проверить `/api/leads` на проде; при необходимости временно выбрать режим fail‑open и зафиксировать это в релиз‑чеклисте.
