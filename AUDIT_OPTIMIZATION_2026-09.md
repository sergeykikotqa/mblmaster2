# PERFORMANCE / TECHNICAL OPTIMIZATION AUDIT — MBL

Дата: 2026-09-12  
Репозиторий: `mblmaster2`  
Ветка: `main`  
Baseline HEAD: `48f1868b88d21cfeb97f134a4db37541130f6848`  
Production build URL: `PUBLIC_SITE_URL=https://mebel-irkutsk.ru`

## Область и правила аудита

Аудит выполнен в read-only режиме. Код, CSS, изображения, зависимости, build config, SEO, тесты и budgets не оптимизировались. Автоматически изменённый во время Lighthouse smoke файл `artifacts/smoke-manifest.json` возвращён к содержимому baseline. По завершении единственным отличием рабочего дерева должен быть этот новый отчёт.

Использованные измерения:

- production build Astro и inventory `dist`;
- существующие quality/security/SEO gates;
- Lighthouse 12.6.1, mobile simulation 412×823, CPU ×4, RTT 150 ms;
- controlled first-visit/returning-visit runs с очисткой cache/storage и явным consent cookie;
- Chromium/Playwright runtime и Axe на 1440 и 390;
- `npm audit --omit=dev` без `fix`/`update`;
- статический анализ HTML, CSS, JS, изображений, content collections, admin/CMS и lead pipeline.

Ограничение Lighthouse: штатный `check:lighthouse:smoke` не завершился из-за Windows `EPERM` при очистке временного каталога Chrome. Representative Lighthouse запущен обходным способом на production `dist` через локальный Python static server с `NETLIFY_IMAGE_CDN=false`. Такой сервер не воспроизводит Netlify compression, immutable cache и Image CDN, поэтому абсолютные transferred bytes и рекомендации `Enable text compression`/`Use efficient cache lifetimes` не являются production-диагнозом. A/B runs сопоставимы между собой. Desktop Lighthouse не получен; desktop runtime проверен через Chromium на 1440.

---

## A. Executive summary

Production build собирается, 75 HTML-маршрутов генерируются, SEO/schema/canonical gates зелёные, CLS на representative Lighthouse routes близок к нулю, а общий публичный JS/CSS проходит существующие budgets. Статьи и guides уже дают хорошие mobile lab scores 91–94 и не требуют агрессивной оптимизации.

При этом аудит нашёл три release-level класса проблем:

1. `/projects` после прокрутки запрашивает пять несуществующих cover URL и получает 404. Это пользовательская регрессия, скрытая lazy loading и не пойманная текущими тестами.
2. Project detail имеет воспроизводимый serious `color-contrast` defect: 27 элементов на 1440 и 26 на 390. Существующий a11y smoke отключает правило `color-contrast`, поэтому gate ложно зелёный.
3. Production dependency graph имеет прямой critical security drift: Astro 5.18.1 попадает под critical AVIF/RCE advisory и несколько high SSRF/XSS advisories; Sharp 0.34.3 имеет high libvips/libheif advisories. Transitive `tar` добавляет critical build/deploy supply-chain риск.

Главный устойчивый performance-кандидат — `/projects`: LCP 3.69–4.08 s в основных mobile runs, LCP-элементом всегда является картинка первой карточки с `loading="lazy"` и `fetchpriority="auto"`. Cookie-banner не влияет на этот маршрут. TBT 506 ms оказался не постоянной величиной: clean A/B дал 0/0 ms, дополнительная стресс-тройка на загруженном Windows host — 535/0/280 ms. Реальный повторяемый сигнал — 67–72% main-thread work в Style & Layout, forced reflow 36–41 ms из `basic-scripts.js` и большой DOM; конкретно `project-modal.js` причиной пока не доказан.

Cookie-banner — не корневая причина общего LCP. На главной returning visit улучшил LCP только на 120 ms, на `/articles` — на 284 ms, на `/projects` — ухудшил на 5 ms в пределах шума. Баннер преимущественно меняет выбранный Lighthouse LCP element.

`dist` содержит 25.06 MiB изображений, но это весь deploy artifact, а не payload одной страницы. Неиспользуемые donor/Figma assets занимают около 5.82 MiB build artifact и не участвуют в network requests публичных страниц. Их cleanup полезен для build/deploy/maintenance, но не является Core Web Vitals optimization.

## B. Baseline metrics

### B1. Environment и build

| Показатель | Значение |
| --- | --- |
| Git branch | `main` |
| HEAD | `48f1868b88d21cfeb97f134a4db37541130f6848` |
| Baseline working tree | clean |
| Node | `v24.19.0` |
| npm | `11.17.0` |
| OS | Windows 11 Pro x64, NT `10.0.26200`, build `26200` |
| `PUBLIC_SITE_URL` | `https://mebel-irkutsk.ru` |
| HTML routes | 75 |
| Build | PASS |

### B2. Default production `dist`

Это сумма всех файлов всего сайта, не page transfer.

| Тип | Файлов | Raw bytes | Raw size | Sum of per-file gzip |
| --- | ---: | ---: | ---: | ---: |
| Всего | 410 | 33,059,669 | 31.53 MiB | 26.19 MiB |
| HTML | 75 | 6,346,454 | 6.05 MiB | 1,520,247 B |
| CSS | 6 | 230,378 | 224.98 KiB | 40,104 B |
| JS | 26 | 97,262 | 94.98 KiB | 35,776 B |
| Images | 290 | 26,276,256 | 25.06 MiB | 25,795,351 B |
| Fonts | 2 | 59,948 | 58.54 KiB | 59,986 B |
| Other | 11 | 49,371 | 48.21 KiB | 9,237 B |

### B3. Performance budgets

`npm run check:performance-budgets`: PASS.

| Budget | Текущее | Лимит | Запас |
| --- | ---: | ---: | ---: |
| Total public JS gzip | 28.4 KiB | 30.0 KiB | 1.6 KiB |
| Total CSS gzip | 39.5 KiB | 120.0 KiB | 80.5 KiB |
| Per-page JS gzip, только статические `<script src>` | PASS | 15.0 KiB | см. замечание ниже |

Gate анализирует только `<script src>` в собранном HTML. Он не учитывает динамически добавляемые `lead-tracking-client.js` и `contact-form-client.js`. Реальный runtime JS representative routes:

| Route | JS requests | Raw JS | Gzip estimate | Относительно 15 KiB |
| --- | ---: | ---: | ---: | --- |
| `/` | 10 | 50,981 B | 17,400 B | выше |
| `/kuhni` | 9 | 47,066 B | 15,615 B | немного выше |
| `/projects` | 10 | 40,190 B | 13,705 B | ниже |
| project detail | 14 | 61,301 B | 20,881 B | выше |
| `/articles` | 9 | 30,739 B | 10,702 B | ниже |
| article detail | 9 | 47,066 B | 15,615 B | немного выше |
| guide detail | 9 | 47,066 B | 15,615 B | немного выше |
| `/contacts` | 11 | 49,823 B | 16,876 B | выше |

Следствие: общий budget действительно зелёный, но per-page gate недосчитывает runtime-loaded JS и нуждается в будущем уточнении без ослабления лимита.

### B4. Representative HTML/CSS inventory

CSS указан по уникальным внешним файлам; inline styles находятся внутри HTML.

| Route | HTML raw/gzip | DOM nodes | Inline CSS | External CSS raw/gzip |
| --- | ---: | ---: | ---: | ---: |
| `/` | 98,216 / 23,104 B | 876 | 7,881 B | 170,269 / 28,203 B |
| `/kuhni` | 166,562 / 32,933 B | 1,095 | 29,367 B | 144,631 / 23,793 B |
| `/projects` | 169,916 / 24,090 B | 1,236 | 8,034 B | 151,874 / 25,663 B |
| project detail | 111,239 / 26,364 B | ~1,064 | 8,193 B | 193,358 / 32,574 B |
| `/articles` | 49,788 / 13,555 B | 376 | 8,034 B | 140,492 / 22,543 B |
| article detail | 66,775 / 17,999 B | 563 | 9,537 B | 144,631 / 23,793 B |
| guide detail | 55,966 / 16,221 B | 486 | 8,653 B | 140,492 / 22,543 B |
| `/contacts` | 70,222 / 18,925 B | 490 | 21,418 B | 140,492 / 22,543 B |

### B5. Все built CSS assets

| Asset | Raw | Gzip |
| --- | ---: | ---: |
| `_astro/tailwind.laFsLWiQ.css` | 97,586 B | 15,337 B |
| `_astro/_slug_.OQVvQxBx.css` | 48,727 B | 8,781 B |
| `_astro/_slug_.Cd0e2kW4.css` | 42,906 B | 7,206 B |
| `_astro/index.ydsWjYfI.css` | 29,777 B | 5,660 B |
| `_astro/index.GH5BUztS.css` | 7,243 B | 1,870 B |
| `_astro/_slug_.CyqMZORn.css` | 4,139 B | 1,250 B |

### B6. Top-20 built JS assets

| Asset | Raw | Gzip |
| --- | ---: | ---: |
| `contact-form-client.js` | 16,966 B | 5,308 B |
| `lead-tracking-client.js` | 15,134 B | 4,301 B |
| `admin-health.js` | 11,369 B | 4,183 B |
| `basic-scripts.js` | 8,573 B | 2,716 B |
| `admin-metrics.js` | 5,884 B | 2,547 B |
| `project-modal.js` | 5,825 B | 1,952 B |
| `projects-filters.js` | 4,265 B | 1,445 B |
| `project-gallery-lightbox.js` | 3,952 B | 1,328 B |
| `home-quiz.js` | 3,915 B | 1,784 B |
| `project-gallery-thumbs.js` | 2,663 B | 991 B |
| `project-gallery-slider.js` | 2,545 B | 1,031 B |
| `hero-modern-slider.js` | 2,023 B | 860 B |
| `portfolio-filter.js` | 1,850 B | 777 B |
| `web-vitals.js` | 1,335 B | 670 B |
| `analytics-consent-banner.js` | 1,136 B | 506 B |
| `mbl-motion.js` | 1,127 B | 538 B |
| `metrika.js` | 1,070 B | 565 B |
| `analytics-consent-init.js` | 1,066 B | 568 B |
| `lead-tracking-init.js` | 986 B | 555 B |
| `project-toc.js` | 933 B | 492 B |

Оставшиеся шесть built scripts вместе малы: `project-video-embed.js`, `project-result-toggle.js`, `project-before-after.js`, `apply-color-mode.js`, `yandex-map.js`, `articles-filter.js`.

### B7. Top-20 built images

`Direct HTML/CSS refs = 0` означает, что именно исходный emitted asset не запрашивается. Для project sources это не доказывает dead code: активные страницы могут использовать responsive/format derivatives. Figma assets доказанно не используются.

| Built asset | Bytes | Dimensions | Source/classification |
| --- | ---: | ---: | --- |
| `_astro/03.DGYGDQHA.jpg` | 1,767,882 | 2560×1920 | project source, derivatives active; original ref 0 |
| `_astro/02.lJ6LPhSg.jpg` | 1,459,751 | 1920×2560 | project source, derivatives active; original ref 0 |
| `_astro/01.gju3sE0u.jpg` | 1,389,593 | 1920×2560 | project source, derivatives active; original ref 0 |
| `_astro/02.nd3noxaw.jpg` | 516,389 | 960×1280 | project source, original ref 0 |
| `_astro/01.UwWiozAT.jpg` | 471,069 | 960×1280 | project source, original ref 0 |
| `_astro/03.BvKRoFVj.jpg` | 470,930 | 1200×1600 | project source, original ref 0 |
| `_astro/02.CrnCt2qk.jpg` | 455,892 | 1280×960 | project source, original ref 0 |
| `_astro/02.XUNa4Yer.jpg` | 441,603 | 1280×960 | project source, original ref 0 |
| `_astro/01.ctLkHhBN.jpg` | 417,981 | 1200×1600 | project source, original ref 0 |
| `_astro/02.BklSc4AY.jpg` | 393,139 | 1200×1600 | project source, original ref 0 |
| `_astro/01.C9t58NPO.jpg` | 388,824 | 1280×960 | project source, original ref 0 |
| `_astro/portfolio-classic-cream.RjwbSjqB.png` | 351,421 | 1200×795 | Figma donor, dead in production references |
| `_astro/portfolio-classic-white.DSmGTAss.png` | 340,594 | 1200×800 | Figma donor, dead in production references |
| `_astro/portfolio-dark-modern.X7-D34-4.png` | 324,184 | 1200×801 | Figma donor, dead in production references |
| `_astro/portfolio-detail-wood.VMMnp_pf.png` | 321,399 | 1200×800 | Figma donor, dead in production references |
| `_astro/portfolio-modern-wide.M5Yx9QDv.png` | 318,089 | 1200×800 | Figma donor, dead in production references |
| `_astro/02.BgGpnpbb.jpg` | 294,981 | 720×1280 | project source, original ref 0 |
| `_astro/02.EfCdy9s1.jpg` | 273,009 | 1600×1200 | project source, original ref 0 |
| `_astro/01.CcxXGlou.jpg` | 255,317 | 1600×1200 | project source, original ref 0 |
| `_astro/portfolio-detail-drawer.D5YcdpKP.png` | 245,449 | 1200×800 | Figma donor, dead in production references |

## C. P0 — критические проблемы

### P0.1. Пять broken cover images на `/projects`

- Evidence: full-scroll Chromium на 1440 и 390 получил 404 для пяти lazy cover URL. На desktop запрошены все пять; на mobile в пределах smoke успели загрузиться три.
- Missing paths:
  - `/images/projects/garderobnaya-p-obraznaya-shelekhov-5-i-mikroraion/01.jpg`;
  - `/images/projects/shkaf-vstroennyi-angarsk-84-i-kvartal/01.jpg`;
  - `/images/projects/garderobnaya-sovetskaya/01.jpg`;
  - `/images/projects/kuhnya-uglovaya-irkutsk-lermontova/01.jpg`;
  - `/images/projects/garderobnaya-angarsk-29-mikrorayon/01.jpg`.
- Root cause: frontmatter содержит реальные alias-пути, например `uglovaya-garderobnaya-kupe-irkutsk`, `shkaf-kupe-na-vsyu-stenu-irkutsk`, `kuhnya-trilissera`. `normalizeProjectContent()` сначала фиксирует `imageBaseDir` равным slug, после чего `resolveProjectImagePath()` предпочитает этот explicit base и переписывает существующий alias (`src/lib/projects/normalized-project-content.ts:95-123,178-186`).
- Affected routes: `/projects`; возможно modal preview и другие consumers нормализованного cover URL.
- Current metric: 5 broken image requests/карточек после прокрутки.
- Proposed change: отдельным hotfix сохранить explicit directory из `/images/projects/<alias>/...` либо добавить корректный `imageBaseDir` contract; добавить build/runtime gate, проверяющий существование каждого resolved project image.
- Expected benefit: убрать видимые сломанные карточки и 404; восстановить доверие к каталогу.
- Regression risk: medium/high, потому что resolver обслуживает все project pages.
- Validation: unit matrix для alias/legacy/slug paths; production build; проверка каждого resolved URL; full-scroll `/projects` на 1440/390; project detail/gallery/modal smoke; image policy.

### P0.2. Serious contrast regression на project detail

- Evidence: full Axe WCAG A/AA/2.1AA — 27 failing nodes на 1440 и 26 на 390.
- Типовые ratios: `#7f5438` на `#080a0d` = 3.04:1; `#5f5a56` на `#080a0d` = 2.91:1; rail `#5e534c` на `#080a0d` = 2.65:1; mobile material value до 1.2:1.
- Root cause: dark bridge в `src/assets/styles/secondary-pages.css:514+` не полностью перекрывает explicit legacy colors из `src/styles/pages/project-page.css`, в частности области около строк 1346, 2241, 2437, 2443, 2653.
- Affected routes: проверенный project detail и потенциально все 31 project details, использующие общий template.
- Current metric: serious Axe violation; Lighthouse accessibility 96 на проверенном detail.
- Proposed change: токенизировать/переопределить legacy foreground colors в project primitives, затем включить `color-contrast` в обязательный gate.
- Expected benefit: читаемый контент и реальный WCAG AA baseline.
- Regression risk: medium — визуальная палитра dark sections может измениться.
- Validation: Axe без disabled rules, screenshots 1440/390, manual focus/hover/disabled states, contrast sampling всех project sections.

### P0.3. Direct production security drift

- `astro@5.18.1`: direct dependency, critical `GHSA-26w7-cxv4-gfx2` (AVIF image optimization RCE, fixed only outside текущего range), high `GHSA-2pvr-wf23-7pc7` (SSRF) и `GHSA-8hv8-536x-4wqp` (XSS), плюс moderate/low advisories.
- `sharp@0.34.3`: direct dependency/runtime image pipeline; high `GHSA-f88m-g3jw-g9cj` и `GHSA-rgj7-g3m4-5g8c`, исправление в 0.35.4.
- Runtime relevance: Netlify adapter создаёт server output и 14 `prerender=false` API routes; image pipeline активен. Конкретная exploitability каждого пути требует отдельного threat-model test, но direct critical advisory нельзя оставлять как maintenance P2.
- Proposed change: отдельная integration branch с совместимым обновлением Astro + `@astrojs/netlify` + Sharp; никаких `npm audit fix --force`.
- Expected benefit: закрытие direct critical/high advisories.
- Regression risk: high — major framework/adapter changes могут затронуть routing, SSR APIs, image URLs, headers и lead pipeline.
- Validation: полный build/test/SEO/E2E/runtime/security matrix, image snapshots, Netlify preview deploy, API/Turnstile/idempotency/tracking checks.

### P0.4. Critical transitive `tar` в build/deploy цепочке

- `tar` 7.5.9/7.5.11 попадает под critical `GHSA-23hp-3jrh-7fpw` и дополнительные path traversal/DoS advisories.
- Это прежде всего build/deploy supply-chain риск, не browser runtime payload.
- Текущий override `tar: 7.5.11` уже устарел и сам уязвим; четыре старых allowlist entries истекли 2026-04-26.
- Proposed change: после framework/adapter compatibility work обновить/удалить override так, чтобы все nested copies оказались в fixed range; затем обновить security baseline осознанно.
- Validation: `npm ls tar`, read-only audit, clean install, build and deploy from a clean runner.

## D. P1 — высокий эффект

### P1.1. `/projects` LCP image загружается как lazy

- Evidence: во всех корректных runs LCP = первая project-card image. Markup: `loading="lazy"`, `fetchpriority="auto"`; Lighthouse `lcp-lazy-loaded` failed. Load Delay занимал 62–76% LCP.
- Affected route: `/projects` mobile, вероятно первый viewport на narrow screens.
- Current metric: clean A/B LCP 3.686/3.692 s; исходный run 4.079 s; score 66–84.
- Proposed change: только для реально above-the-fold первой карточки использовать eager/high и корректный responsive `sizes/srcset`; остальные оставить lazy.
- Expected benefit: Lighthouse estimate около 550–600 ms LCP; без увеличения загрузки всего grid.
- Regression risk: medium — порядок/filtering и desktop/mobile fold могут отличаться.
- Validation: минимум 5 clean mobile runs median/p75; desktop; request priority waterfall; no extra below-fold eager requests; visual/full-scroll regression.

### P1.2. `/projects` layout-heavy и имеет нестабильный TBT

- Evidence: clean first/returning A/B дал TBT 0/0 ms. Дополнительная сопоставимая тройка дала 535/0/280 ms, median 280 ms, range 0–535 ms, но каждый run содержал Lighthouse warning о более медленном, чем ожидалось, test CPU. Исходные 506 ms имели то же предупреждение.
- Main-thread work: 2.63–3.64 s в стресс-тройке, 67–70% Style & Layout; Script Evaluation только 135–162 ms; bootup 52–67 ms.
- Повторяемый forced reflow: 36–41 ms в `basic-scripts.js`, где `header.getBoundingClientRect().height` сочетается с записью CSS variable и `ResizeObserver` (`public/scripts/basic-scripts.js:166-223`).
- `projects-filters.js` при старте проходит 31 карточку и переключает классы; `project-modal.js` клонирует template и ставит listeners на 31 trigger. Это кандидаты, но не доказанные root causes.
- Lighthouse attribution `project-modal.js = 706 ms` и `apply-color-mode.js = 659–892 ms` целиком классифицирована как `other`, не script evaluation, и не должна трактоваться как стоимость этих маленьких файлов.
- Affected route: `/projects`; основной риск — low-end devices и contention.
- Proposed change: сначала Chrome Performance trace на свободном/стабильном host и production preview; затем отдельно проверять header measurement, initial filter mutation, modal cloning/listeners и DOM/CSS containment.
- Expected benefit: более стабильный p75 TBT/INP proxy, а не только лучший одиночный score.
- Regression risk: high для filters/modal/header behavior.
- Validation: before/after trace, 5–10 runs median/p75, keyboard/modal/filter E2E, 1440/390.

### P1.3. Homepage LCP остаётся медленным без banner

- Evidence: returning homepage LCP 3.459 s; first visit 3.579 s. Без banner LCP переключается на hero CTA text, а не становится быстрым.
- Affected route: `/`.
- Current metric: controlled score 86–87, LCP 3.46–3.58 s; исходный noisy run 76/3.94 s.
- Proposed change: production-like trace render path, font/CSS timing, hero reveal and critical style; не уменьшать banner как surrogate optimization.
- Expected benefit: устранение истинного render delay.
- Regression risk: medium/high для visual/motion language.
- Validation: first/returning A/B после каждого шага, reduced-motion, 390/1440 screenshots, no CLS.

### P1.4. Public JPEG hero bypasses responsive image pipeline

- Evidence: `/kuhni` и `/contacts` LCP image `/images/projects/kuhnya-baykalskaya/01.jpg`, 900×800 и ~53.9 KB transfer, отображается около 378 px wide. Lighthouse оценил 34.5–39.6 KB waste и примерно 150–160 ms.
- Affected routes: `/kuhni`, `/contacts`, а также `/angarsk`, `/irkutsk`, `/kuhni-3-metra`, `/shelekhov`, использующие этот URL.
- Current metric: `/kuhni` LCP 3.782 s; `/contacts` 3.330 s.
- Proposed change: сохранить реальное MBL-изображение, но провести его через responsive AVIF/WebP picture contract с корректными width/height/sizes.
- Expected benefit: ~35–40 KB на mobile и меньший image decode/download delay.
- Regression risk: low/medium — crop/aspect ratio/quality.
- Validation: pixel/crop review 390/1440, LCP waterfall, image policy, no duplicate request.

### P1.5. `secondary-pages.css` стал maintainability debt и глобальным payload

- Evidence: 25,989 B raw / 4,470 B gzip; 130 selectors; 23 `!important`; max complexity heuristic 38; 195 color/background/border declarations. Глобальный import находится в `src/layouts/Layout.astro:7`; shared chunk загружается и на homepage, где scoped selectors не применяются.
- Affected routes: все 71 public routes получают shared CSS; функционально bridge влияет secondary pages.
- Current metric: Lighthouse сообщает ~107–119 KB unused CSS на многих mobile pages для совокупного CSS; bridge — только часть этой величины, не вся причина.
- Proposed change: постепенно переносить области в shared design-system primitives, затем route-scope остаток; не удалять файл целиком.
- Expected benefit: меньше cascade risk, regressions и часть CSS parse/download.
- Regression risk: high из-за широких legacy overrides.
- Validation: rule-by-rule removal, visual matrix всех page families, Axe contrast, modal/form states, CSS coverage.

### P1.6. Runtime Web Vitals фактически не стартует

- Evidence: `public/scripts/web-vitals.js:6` выполняет bare `import('web-vitals')`. Файл лежит в `public`, обходит Vite bundling/import map, а failure полностью проглатывается `catch`; LCP/CLS/INP RUM не отправляются.
- Дополнительный privacy risk: если импорт просто починить, текущий `sendEvent()` пишет в `/api/track` без проверки analytics consent. `Analytics.astro` также может вставить GA сразу при заданном ID, тогда как Yandex Metrika корректно ждёт consent. В текущем build GA/Yandex IDs пусты, поэтому third-party analytics не грузились.
- Affected routes: все 71 public routes; observability, а не прямой render blocker.
- Proposed change: bundled RUM module + единый consent-aware controller; GA и RUM должны следовать тому же state contract, что Metrika.
- Expected benefit: реальные field CWV/INP данные и корректная privacy semantics.
- Regression risk: high для consent/tracking metrics.
- Validation: denied/granted tests, no `/api/track` before consent, one event after consent, beacon/fetch fallback, no duplicate listeners, privacy disclosure.

### P1.7. Per-page JS budget не видит dynamic scripts

- Evidence: budget PASS, но runtime inventory показывает 15.6–20.9 KB gzip на шести representative routes при лимите 15 KB. Gate использует regex только для HTML `<script src>`.
- Proposed change: расширить manifest/gate декларативным списком dynamic loaders либо browser-based route inventory; лимит не повышать.
- Expected benefit: budget снова отражает реальную страницу.
- Regression risk: low для runtime, medium для CI stability.
- Validation: сверка budget output с Playwright network list на fixed representative routes.

### P1.8. Donor/Figma cleanup — artifact/maintenance, не CWV

- Evidence: `src/assets/images/figma` 110 файлов / 4,559,225 B; `public/images/figma` 101 / 1,987,965 B; build-relevant subset около 6,099,553 B (5.82 MiB). В active `src/data` refs = 0; production HTML/CSS/JS/JSON/XML refs и filename-stem matches = 0. Упоминания находятся только в `content/migrations`.
- Причина попадания: широкий `import.meta.glob('~/assets/images/**/*...')` в `src/utils/images.ts:8` плюс wholesale copy из `public`.
- Proposed change: отдельный staged exclusion/removal только после final reference manifest.
- Expected benefit: меньше build/deploy artifact и cache/upload time; ожидаемый page CWV benefit = 0.
- Regression risk: low при доказанном zero-reference, но не zero.
- Validation: clean build, full route crawl, HTML/CSS/JS reference scan, visual/SEO gates.

## E. P2 — полезные оптимизации

1. Route-scope `mbl-motion.js`: 1,127 B raw / ~541 B gzip загружается на 71 route, но reveal DOM найден только на homepage (47 элементов). Сохранять reduced-motion behavior.
2. Убрать повторяющийся inline CSS после стабилизации дизайна: Header 6,479 B × 71, theme vars 793 B × 71, menu toggle 609 B × 71; базово 7,881 B/page, около 559,551 B повторения в artifact. HeroModern 8,310 B × 9 и Contact 3,826 B × 9 — следующие кандидаты.
3. `project-gallery-slider.js` — 2,545 B raw / 1,031 B gzip, zero production refs; кандидат на удаление после proof gate. `project-before-after.js` условный future-content script и пока не доказанно dead.
4. Среди показанных inventory 40 exact-duplicate groups: 38 — реальные лишние физические копии, theoretical artifact overhead 1,937,453 B; 0 — responsive/format variants; 2 — intentional active aliases (`kuhnya-baykalskaya/{01,02}.jpg` и `kuhnya-bogdana/{01,02}.jpg`) и должны сохраняться либо мигрироваться атомарно.
5. 12 public `hero-{district,kitchen,wardrobe}-{480,768,960,1200}.webp`, 648,462 B, имеют zero refs. Их source PNGs частично активны в article/guide, поэтому удалять только доказанно неиспользуемые derivatives.
6. Проверить latent legacy blog/demo: `src/data/post` содержит 7 Unsplash/demo references, но blog отключён и активных imports не найдено. Это не текущий network traffic.
7. Decap CMS — вероятно устаревший optional editor; отдельный audit ниже. Удаление не улучшит public CWV.
8. Global headers hardening: CSP есть, но глобальные HSTS, `X-Content-Type-Options` и `Permissions-Policy` не заданы. Проверить фактические Netlify headers до рекомендации изменения.
9. Удалять unused dependencies (`@astrojs/rss`, `astro-embed` и legacy blog chain) только после import/runtime graph и одновременно с security upgrade, не отдельным blind cleanup.

## F. Не оптимизировать

- Не трактовать 25.06 MiB images в `dist` как вес открытия страницы: это весь многостраничный artifact.
- Не уменьшать cookie-banner только ради Lighthouse. Он почти не меняет requests/bytes и преимущественно меняет LCP element.
- Не удалять project source originals только потому, что hashed original имеет zero direct refs: активные страницы используют generated derivatives.
- Не удалять две intentional duplicate aliases без атомарной миграции URL/content.
- Не менять Golos Text: две self-hosted variable WOFF2 дают весь диапазон 400–900 при суммарных 59,948 B; `font-display: swap`, Cyrillic preload и unicode ranges уже настроены.
- Не убирать synchronous `apply-color-mode.js` (743 B raw / 434 B gzip) без эквивалентной защиты от theme flash. Lighthouse URL attribution не доказывает, что его код выполнялся 659–892 ms.
- Не ломать quiz/form lead contract: consent, Turnstile, idempotency, tracking, error handling и один submit/API flow остаются preserve list.
- Не eager-load весь project grid; только доказанный above-fold LCP image.
- Не отключать analytics. Сначала исправить consent-aware loading и field telemetry.
- Не оптимизировать article/guide routes агрессивно: mobile scores 91–94, TBT 0, CLS ≈0.
- Не удалять `/api/track`, `src/server/metrics`, metrics calls из `/api/leads`, workers или alerts под видом CMS cleanup.
- Не запускать `npm audit fix --force`, bulk major updates или ослабление budgets.

## G. CSS debt

### G1. Ответ по `secondary-pages.css`

A. Как временный bridge файл оправдан: он позволил унифицировать secondary pages без одномоментной переписи templates.  
B. Сам по себе это не P0 performance problem: 4.47 KB gzip невелики. Но глобальная загрузка на homepage и участие в shared cascade не бесплатны.  
C. Это уже явная maintainability problem: 130 broad selectors, 23 `!important`, complex `:is(...)`, смешение page families и токенов с legacy literals.  
D. Удалять стоит постепенно, только после переноса каждой области в primitives и visual/a11y regression.  
E. Максимальный эффект дадут следующие области:

1. project detail cards/rail/process/result/cost sections;
2. project legacy text colors в dark sections;
3. service money-page price/city/review blocks;
4. contacts cards/map/meta;
5. article/guide prose headings and muted text;
6. project-card meta/summary/proof;
7. buttons/forms/modal surfaces;
8. generic Tailwind color utility overrides;
9. common section/kicker/copy typography;
10. route scoping самого bridge после удаления cross-family rules.

### G2. Другой CSS debt

- `src/styles/pages/project-page.css`: 56,514 B raw / 8,638 B gzip, 429 selectors, max complexity 47. Это крупнейший source stylesheet и главный visual regression risk.
- `src/assets/styles/pages/home.css`: 37,915 B raw / 6,052 B gzip, 297 selectors; не является проблемой только по размеру, но требует coverage-based work.
- `/projects` загружает 151,874 B raw CSS, project detail 193,358 B, homepage 170,269 B.
- Lighthouse unused CSS estimate 107–119 KB на representative mobile pages относится к совокупному Tailwind/shared/route CSS. Нельзя приписывать всю величину `secondary-pages.css`.
- Potential dead selectors должны подтверждаться route coverage, dynamic states и content variants. Статический zero-match недостаточен для modal/filter/focus/reduced-motion rules.

## H. JS/runtime

### H1. Public JS inventory и назначение

| Script | Built raw/gzip | Routes/init | Audit classification |
| --- | ---: | --- | --- |
| `apply-color-mode.js` | 743/434 B | 71, sync head | preserve: theme flash prevention |
| `analytics-consent-init.js` | 1,066/568 B | 71, defer | preserve consent controller |
| `analytics-consent-banner.js` | 1,136/506 B | 71, defer | UX/a11y P1/P2, не LCP root cause |
| `lead-tracking-init.js` | 986/555 B | 71, defer | DOM-gated dynamic loader |
| `web-vitals.js` | 1,335/670 B | 71, module | broken bare import; P1 observability/privacy |
| `basic-scripts.js` | 8,573/2,716 B | 71, module | header/menu/share/legacy IO; forced reflow candidate |
| `mbl-motion.js` | 1,127/538 B | 71, module | DOM no-op вне homepage; route-split P2 |
| `lead-tracking-client.js` | 15,134/4,301 B | dynamic, lead signals | needed; large unused percentage on quiet pages |
| `contact-form-client.js` | 16,966/5,308 B | dynamic, forms | preserve submit/controller semantics |
| `home-quiz.js` | 3,915/1,784 B | `/` | presentation/state layer over existing form |
| `projects-filters.js` | 4,265/1,445 B | `/projects` | initial 31-card mutation; profile before change |
| `project-modal.js` | 5,825/1,952 B | project list/details | template/listeners; not proven TBT root |
| `project-gallery-lightbox.js` | 3,952/1,328 B | 31 details | preserve focus trap/return |
| `project-gallery-thumbs.js` | 2,663/991 B | 31 details | route-specific |
| `project-toc.js` | 933/492 B | 31 details | route-specific |
| `project-result-toggle.js` | 862/~491 B | 31 details | conditional content behavior |
| `project-video-embed.js` | 928/~518 B | 2 details | click/interaction-gated VK embed |
| `project-before-after.js` | 739/~409 B | conditional future content | not proven dead |
| `project-gallery-slider.js` | 2,545/1,031 B | zero refs | dead candidate |
| `hero-modern-slider.js` | 2,023/860 B | contacts/company | route-specific |
| `yandex-map.js` | 734/~401 B | contacts | click-to-load iframe, preserve |
| `articles-filter.js` | 639/~406 B | articles | small, route-specific |
| `portfolio-filter.js` | 1,850/777 B | company | route-specific |
| `metrika.js` | 1,070/565 B | env-driven | waits for consent, not dead |
| `admin-health.js` | 11,369/4,183 B | `/admin` only | not public payload |
| `admin-metrics.js` | 5,884/2,547 B | `/admin/metrics` only | not public payload |

### H2. `/projects` loaded scripts

Все network scripts были first-party; third-party requests не было.

| Script | Gzip |
| --- | ---: |
| `apply-color-mode.js` | 434 B |
| `analytics-consent-init.js` | 568 B |
| `analytics-consent-banner.js` | 506 B |
| `lead-tracking-init.js` | 555 B |
| `web-vitals.js` | 670 B |
| `basic-scripts.js` | 2,717 B |
| `mbl-motion.js` | 541 B |
| `projects-filters.js` | 1,451 B |
| `project-modal.js` | 1,958 B |
| `lead-tracking-client.js` | 4,305 B |
| Total | 13,705 B |

Runtime smoke:

- `/`, `/articles`, `/kuhni`, project detail и `/contacts`: no uncaught `pageerror`/request failure в representative runs;
- `/projects`: пять image 404 после прокрутки, описаны в P0.1;
- horizontal overflow: 0 на всех шести routes при 1440 и 390;
- с `prefers-reduced-motion: reduce`: 0 running animations в steady state;
- local static server не исполняет Astro API, поэтому lead/API semantics этим runtime smoke не покрыты.

## I. Images/fonts

### I1. LCP/image matrix

| Route | LCP candidate | Loading contract | Finding |
| --- | --- | --- | --- |
| `/` first | cookie text | DOM text | banner выбирается LCP, но не root cause |
| `/` returning | hero CTA text | DOM text | render/CSS/font path требует trace |
| `/kuhni` | HeroModern JPG | eager, high | discoverable, но oversized/no AVIF-WebP response |
| `/projects` | first card AVIF | lazy, auto | неправильный priority для above-fold LCP |
| project detail | hero WebP | eager, high | discovery корректен; ~10 KB mobile waste estimate |
| `/articles` first | cookie text | DOM text | returning LCP = header text |
| article detail | intro paragraph | DOM text | image не LCP |
| guide detail | intro paragraph | DOM text | image не LCP |
| `/contacts` | HeroModern JPG | eager, high | тот же oversized public JPEG |

Astro/Netlify image pipeline генерирует AVIF/WebP/responsive variants для многих project images. Lighthouse fallback build создал 2,358 variants; это не размер default deploy и не должно смешиваться с B2. Public absolute JPG в HeroModern pipeline обходит.

### I2. Duplicates

Inventory script выводил только `.slice(0,40)`, поэтому «40 групп» — cap, а не доказанное общее количество. Среди показанных групп:

- 38 — настоящие избыточные physical copies;
- 0 — exact responsive/format build variants;
- 2 — intentional active aliases под разными URL;
- theoretical overhead показанных групп — 1.85 MiB artifact, не page transfer.

### I3. Fonts

- `golos-text-cyrillic-wght-normal.woff2`: 22,032 B;
- `golos-text-latin-wght-normal.woff2`: 37,916 B;
- оба self-hosted, variable range 400–900, `font-display: swap`, unicode-range разделён;
- Cyrillic preloaded в `Layout.astro`; оба реально запрашиваются из-за смешанного Cyrillic/Latin/digits content;
- суммарно около 60 KB; отдельных неиспользуемых weight files нет;
- CLS в Lighthouse ≈0, поэтому шрифт не является текущим P0/P1.

## J. Lighthouse / Core Web Vitals

### J1. Representative mobile baseline

Одиночные runs полезны для finding discovery, но не являются устойчивым median. Scores и timing ниже получены на local uncompressed static server.

| Route | Perf | FCP | LCP | TBT | Speed Index | CLS | Requests | Bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | 76 | 2.729 s | 3.936 s | 235 ms | 4.887 s | 0 | 23 | 543,114 |
| `/kuhni` | 81 | 2.882 s | 3.782 s | 0 | 4.849 s | 0 | 18 | 476,297 |
| `/projects` | 66 | 2.885 s | 4.079 s | 506 ms | 4.639 s | 0 | 25 | 716,009 |
| project detail | 79 | 2.876 s | 3.952 s | 0 | 5.424 s | 0 | 25 | 498,973 |
| `/articles` | 92 | 2.273 s | 2.865 s | 0 | 2.809 s | 0 | 16 | 299,864 |
| article detail | 91 | 2.411 s | 3.011 s | 0 | 2.737 s | 0.00005 | 17 | 339,334 |
| guide detail | 92 | 2.265 s | 2.865 s | 0 | 2.712 s | 0.00004 | 16 | 322,352 |
| `/contacts` | 87 | 2.280 s | 3.330 s | 32 ms | 4.552 s | 0 | 19 | 393,848 |

Top actionable diagnostics:

- `/projects`: lazy LCP image; image delivery estimate ~221 KB across sampled cards; DOM ~1,203; intermittent layout-heavy main thread.
- `/kuhni`, `/contacts`: public JPG responsive/format waste ~35–40 KB.
- project detail: CSS/DOM largest among details; hero priority correct; secondary image + hero estimate ~40 KB waste.
- homepage: LCP remains hero text/CTA without banner; CSS/render path, not a single image.
- all routes: Lighthouse local server reports text compression/cache opportunities — ignore until Netlify preview verification.
- unused CSS estimate is high across page families, but must be decomposed by coverage before deletion.

### J2. Consent A/B

Перед каждым run очищались cache/storage/cookies. First visit оставлял consent unknown; returning устанавливал `site_analytics_consent=denied`. Requests/bytes остались одинаковыми на каждой паре.

| Route/state | Perf | FCP | LCP | TBT | SI | Requests | Bytes | LCP element |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `/` first | 86 | 2.754 s | 3.579 s | 0 | 2.754 s | 20 | 465,174 | cookie text |
| `/` returning | 87 | 2.709 s | 3.459 s | 0 | 2.709 s | 20 | 465,174 | hero CTA text |
| `/projects` first | 84 | 2.867 s | 3.686 s | 0 | 2.867 s | 22 | 624,401 | first card image |
| `/projects` returning | 84 | 2.875 s | 3.692 s | 0 | 2.875 s | 22 | 624,401 | first card image |
| `/articles` first | 93 | 2.266 s | 2.860 s | 0 | 2.266 s | 16 | 299,864 | cookie text |
| `/articles` returning | 94 | 2.276 s | 2.576 s | 0 | 2.276 s | 16 | 299,864 | article header text |

Вывод: banner добавляет умеренный render/LCP effect на home/articles, но главным образом меняет LCP element. На `/projects` его эффект отсутствует.

### J3. Дополнительная `/projects` stress-тройка

| Run | Perf | FCP | LCP | TBT | SI | Requests | Bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 69 | 2.909 s | 3.959 s | 535 ms | 2.909 s | 24 | 697,407 |
| 2 | 84 | 2.904 s | 3.729 s | 0 | 2.904 s | 22 | 624,401 |
| 3 | 78 | 2.909 s | 3.734 s | 280 ms | 2.909 s | 22 | 624,401 |

Все три получили slow test CPU warning; TBT median 280 ms, range 0–535 ms. Это подтверждает риск вариативности, но не даёт права назначить конкретный JS root cause без стабильного production-like trace.

## K. SEO/a11y constraints

### K1. SEO/HTML

PASS:

- production build: 75 HTML routes;
- canonical absolute: 75/75;
- canonical in sitemap: 75/75 applicable validation;
- sitemap coverage: expected 64, actual 64; admin/API/non-indexable исключены;
- schema coverage: 75 routes;
- semantic money-page checks;
- generated pages sync;
- anchor targets;
- geo signals;
- SEO quality gates;
- no legacy project fields.

Critical content, headings, canonical, schema, breadcrumbs и internal links находятся в server-rendered HTML, а не зависят от client rendering. Это preserve constraint для любых CSS/JS optimizations.

Largest HTML/DOM routes: `/projects` 169,916 B raw/~1,203 runtime nodes; `/kuhni` 166,562 B/~1,063 runtime nodes; project detail ~1,064 nodes. Большие inline CSS blocks, а не JSON-LD, дают основную повторяемую HTML overhead.

### K2. Accessibility/UX

- Existing `check:accessibility` текущего audit run: FAIL/NOT COMPLETED из-за Playwright webServer timeout 120 s, не из-за assertion.
- На том же SHA до аудита стандартный smoke проходил 6/6, включая gallery focus trap/return, но `a11y-smoke.spec.ts` явно отключает `color-contrast`.
- Direct Axe 1440/390: project detail serious contrast failure; остальные пять representative routes без serious/critical в этом run.
- Lighthouse дополнительно выявляет `label-content-name-mismatch` в header/footer CTA на большинстве публичных routes и в gallery opener; это менее тяжёлый, но реальный accessible-name debt.
- Homepage и article detail также получили Lighthouse contrast findings в его emulation; перепроверить после project-level token fix.
- Cookie banner: `role="dialog"`, accessible label, две явные кнопки, isolated Axe serious/critical = 0 на 1440/390.
- Reduced motion: media query активируется, running animations = 0 в steady state на representative routes.
- Horizontal overflow: 0 на 1440/390.
- Turnstile fallback, consent, modal focus trap/return и form errors должны оставаться regression gates.

## L. Dependency/security findings

### L1. Read-only npm audit

`npm audit --omit=dev --json`: exit 1 из-за findings.

| Severity | Count |
| --- | ---: |
| Critical | 2 |
| High | 34 |
| Moderate | 13 |
| Low | 11 |
| Total | 60 |
| Production dependency graph | 944 packages |

Классификация:

- Direct/runtime or production pipeline: Astro 5.18.1, `@astrojs/netlify` 6.6.4, Sharp 0.34.3 — P0 integration upgrade.
- Build/deploy transitive: `tar`, `vite`, `postcss`, `svgo`, `extract-zip`, `toml`, parts of Netlify tooling — high priority, но не browser JS.
- Runtime transitive, reachability to verify: `devalue`, `undici`, Netlify/Otel packages.
- Build/content tooling: `js-yaml` 4.1.1, RSS/embed/icon tooling. Untrusted input exposure ниже, но advisories не игнорировать.
- Generic transitive packages (`brace-expansion`, `picomatch`, `nanoid`, `lodash`, etc.) должны обновляться через owning dependency, не вручную без graph.

### L2. Overrides

Текущие overrides `h3`, `fast-xml-parser`, `rollup`, `minimatch` применены. Следующие overrides уже сами ниже fixed ranges или требуют ревизии:

- `undici: 7.24.4`, требуется минимум 7.29.0 для полного текущего advisory set;
- `tar: 7.5.11`, уязвим;
- `svgo: 4.0.1` и nested 3.3.3, fixed ranges ≥4.1.0 и ≥3.3.5;
- `axios` override следует проверять вместе с `@iconify/tools` owner.

`check:audit` намеренно NOT RUN: script переписывает tracked `artifacts/security-audit-baseline.json`, а задача запрещает такие изменения. Direct read-only npm audit выполнен. Существующий baseline устарел и содержит четыре expired tar allowlist entries.

### L3. Security/privacy gates

| Gate | Status |
| --- | --- |
| Secrets scope | PASS |
| Image policy | PASS |
| Admin token storage | PASS, 2 admin source files + manual public script scan |
| Admin token leak | NOT RUN: отсутствует требуемый `METRICS_ADMIN_TOKEN` sentinel |
| Privacy disclosure | PASS |
| Contact hidden fields/context | PASS |
| Decap CMS noindex header | PASS |
| Runtime config with real secrets | NOT RUN |
| Deployed production smoke | NOT RUN |

Global CSP присутствует. Global HSTS, `X-Content-Type-Options` и `Permissions-Policy` в repository headers не найдены; сначала проверить hosting-layer defaults.

## M. Dead assets/code candidates

### M1. Доказанные/сильные кандидаты

- Figma/donor images: около 5.82 MiB build artifact, zero active production refs. Cleanup only after staged proof.
- `project-gallery-slider.js`: zero HTML/runtime references, 2,545 B raw.
- 12 unused public hero responsive derivatives: 648,462 B.
- 38 physical duplicate groups среди первых 40 inventory groups; удаление по manifest, не по имени.
- `scripts/optimize-figma-placeholders.mjs`: package/pipeline caller не найден.
- Repeated inline style blocks: extraction candidate, не dead behavior.

### M2. Не считать доказанно dead

- `project-before-after.js`: conditional content path для будущих/вариантных projects.
- Metrika loader: env-driven, current ID empty.
- Project source originals: generated responsive derivatives могут быть active.
- `_archive` content: имя каталога не означает draft; найден published `draft: false` content.
- metrics/admin backend: напрямую связан с lead pipeline.

### M3. Admin/CMS necessity audit

Decap CMS и `/admin` — независимые системы.

Decap CMS:

- только `public/decapcms/index.html` и `config.yml`, внешние Netlify Identity/Decap scripts загружаются лишь на `/decapcms/`;
- package dependency отсутствует, public pages/nav/sitemap не зависят;
- config drift: collection `post` пишет в несуществующий `src/content/post`, тогда как legacy posts читаются из `src/data/post`; project schema не содержит современных полей; `public_folder: /_astro` не соответствует hashed image pipeline;
- CSP repository не разрешает `identity.netlify.com`/`unpkg.com`; deployed CMS может уже не работать;
- удаление даст security/maintenance simplification, но 0 public CWV benefit;
- до удаления проверить внешние Netlify Identity/Git Gateway users, drafts и CMS-created branches.

`/admin`:

- это operational health/funnel dashboard, не content CMS;
- UI использует protected GET APIs и не хранит token в local/session storage;
- admin JS загружается только на `/admin` и `/admin/metrics`;
- UI можно оценивать отдельно, но metrics APIs/storage/workers/alerts сохранять.

Metrics backend preserve evidence: `/api/leads` и `/api/track` записывают funnel metrics; workers строят snapshots/health; alerts и scheduled workflows зависят от этой системы. Массовое удаление изменит tracking и lead delivery semantics.

## N. Proposed optimization stages

Каждая стадия должна быть отдельным небольшим PR/commit set с собственным rollback.

### Stage O0 — release blockers: media paths

- исправить только resolver/imageBaseDir contract для пяти broken covers;
- добавить existence gate для всех resolved project images;
- validate full catalog, details, gallery, modal, 1440/390.

### Stage O1 — accessibility release blocker

- исправить project dark-section contrast через tokens/primitives;
- включить contrast в обязательный Axe gate;
- отдельно закрыть accessible-name mismatch;
- visual + keyboard + reduced-motion regression.

### Stage O2 — framework/security integration

- совместимое обновление Astro, Netlify adapter, Sharp;
- затем transitive tar/undici/svgo/js-yaml chain и overrides;
- clean install/build/SSR/API/Image CDN/Netlify preview validation;
- без `audit fix --force`.

### Stage O3 — trustworthy measurements and RUM

- починить официальный Lighthouse temp cleanup на Windows/CI;
- запускать mobile+desktop на production-like compressed server/preview;
- расширить per-page budget dynamic scripts;
- bundled consent-aware Web Vitals; GA follows consent;
- собрать field LCP/CLS/INP до дальнейшего тюнинга.

### Stage O4 — `/projects` LCP

- eager/high только для первой реально видимой карточки;
- правильный mobile `sizes/srcset` и compression;
- минимум 5 clean runs median/p75, waterfall and no eager grid regression.

### Stage O5 — hero image delivery

- перевести активный MBL public JPEG hero в responsive AVIF/WebP contract;
- не заменять donor/stock imagery;
- проверить crop, quality, LCP и duplicate requests.

### Stage O6 — `/projects` runtime/layout

- stable Chrome trace на свободном host;
- по одному эксперименту: header measurement, initial filters, modal template/listeners, DOM/CSS containment;
- сохранять filters, modal, focus, forms и tracking semantics.

### Stage O7 — CSS bridge reduction

- coverage map по page families;
- перенос project/colors → service blocks → contacts → prose → cards/forms;
- после каждой области удалять только доказанно заменённые bridge rules;
- route-scope остаток `secondary-pages.css`.

### Stage O8 — artifact/dead cleanup

- Figma/donor zero-ref assets;
- exact duplicate manifest;
- zero-ref hero derivatives и `project-gallery-slider.js`;
- rebuild/deploy size comparison; не обещать CWV improvement.

### Stage O9 — optional CMS/admin simplification

- подтвердить внешнее состояние Netlify Identity/Git Gateway;
- при решении пользователя удалить только Decap и синхронные robots/header/check entries;
- admin dashboard оценивать отдельно;
- metrics/lead backend сохранить без отдельного продуктового решения.

### Stage O10 — full regression and production verification

- build, check, typecheck, 49+ unit tests;
- image policy, performance budgets, corrected Lighthouse smoke;
- 1440/390 visual/runtime/a11y;
- SEO/canonical/schema/sitemap;
- consent first/returning, analytics, RUM;
- ContactForm/quiz/modal/Turnstile/idempotency/tracking/error paths;
- Netlify preview and deployed headers/cache/compression.

## Итоговый gate status

| Проверка | Результат |
| --- | --- |
| Production build, 75 routes | PASS |
| `npm run check` | PASS: Astro 0 errors, 0 warnings, 39 hints; ESLint/NAP/privacy PASS |
| Typecheck | PASS |
| Unit/integration tests | PASS: 17 files, 49 tests |
| Performance budgets | PASS, но dynamic JS gap documented |
| Image policy | PASS |
| SEO/canonical/schema/sitemap/anchors/geo | PASS |
| Admin storage/privacy/contact context/Decap header | PASS |
| Existing E2E smoke | PASS на том же baseline SHA до аудита, 6/6 |
| Official Lighthouse smoke | FAIL infrastructure: Windows `EPERM`; no fresh official summary |
| Manual representative mobile Lighthouse | COMPLETED с описанными ограничениями |
| Desktop Lighthouse | NOT RUN из-за harness; desktop runtime выполнен |
| Existing accessibility command, fresh run | FAIL infrastructure: webServer timeout |
| Direct Axe/runtime 1440/390 | FAIL product: project contrast + five `/projects` image 404 |
| `npm audit --omit=dev` | FAIL: 60 findings, включая 2 critical |
| `check:audit` | NOT RUN: изменяет tracked baseline |
| Admin token leak | NOT RUN: нет required sentinel |
| Production/deployed API and real-secret checks | NOT RUN |

## Final decision

Оптимизации начинать не с массовой чистки `dist`, banner или удаления CSS, а с P0 functional/a11y/security blockers. После этого восстановить достоверную production-like Lighthouse/RUM измеримость, затем отдельно оптимизировать `/projects` LCP и только после stable trace — main-thread/layout. Donor/duplicate cleanup держать отдельной maintenance стадией, чтобы его эффект не смешивался с Core Web Vitals.
