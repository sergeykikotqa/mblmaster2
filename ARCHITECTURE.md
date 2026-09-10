# Architecture Contract

Этот документ фиксирует инварианты текущей SEO-архитектуры.

## 1. URL Model

Разрешенная модель:

- `/`
- `/{city}`
- `/{service}`
- `/projects`
- `/projects/{slug}`
- `/articles`, `/articles/{slug}`
- `/guides`, `/guides/{slug}`
- `/faq`, `/faq/{slug}`
- `/contacts`, `/o-kompanii`, `/privacy`, `/terms`, `/thanks`

Города:

- `irkutsk`
- `angarsk`
- `shelekhov`

Услуги:

- `kuhni`
- `shkafy`
- `garderobnye`

## 2. Forbidden Routes

В проекте не должно быть:

- micro-кластеров (`src/pages/kuhni/*`, `src/pages/shkafy/*`, `src/pages/garderobnye/*`)
- районных money-страниц (`/{city}/{district}/{service}`)
- city-service страниц (`/{city}/{service}`)
- catch-all страниц в `src/pages` (`[...*]`)

## 3. Project Content Contract

SEO-кейсы хранятся только в:

- `src/content/projects/*.md`

Текущий контракт frontmatter:

- обязательные поля:
  - `title`
  - `city`
  - `service`
- поддерживаемые optional-поля:
  - `slug`
  - `street`
  - `district`
  - `complex`
  - `images`
  - `imageBaseDir`
  - `imageCaptions`
  - `estimatedPrice`, `estimatedPriceNote`
  - `serviceLabelOverride`
  - `blocks`

Slug:

- явный `slug` имеет приоритет
- если `slug` не задан, используется детерминированная генерация из контентных полей

Изображения:

- стандартный путь: `public/images/projects/{slug-or-imageBaseDir}/*`
- `imageBaseDir` нужен только если папка ассетов не совпадает со slug

Практический инвариант добавления нового проекта:

1. добавить один `.md`-файл в `src/content/projects/`
2. положить изображения в стандартную папку проекта
3. при нестандартной папке указать `imageBaseDir`

Новый проект не должен требовать правок renderer/adapters/pages.

## 4. Build And Render Pipeline

### Money pages

Единый pipeline генерации money-страниц:

1. `npm run build:data`
2. генерация `data/generated-pages.json`
3. рендер Astro страниц из `generated-pages.json`

Инварианты `generated-pages.json`:

- ровно 3 страницы
- только `pageType = service-money`
- slug-формат только `/{service}`

### Project pages

Единый внутренний pipeline project pages:

1. `getCollection('projects')`
2. `readProjectBoundary(entry)`
3. `normalizeProjectContent(entry)` → `NormalizedProjectContent`
4. `buildProjectViewModel(...)`
5. `buildProjectRenderPlan(viewModel)`
6. `ProjectRenderer.astro`
7. `BlockRenderer.astro` → `block-registry.ts`

Инварианты project pipeline:

- unsafe typing изолирован на boundary-слое
- `NormalizedProjectContent` — единственный source of truth для derived project-data
- `ProjectBlocks.astro` — только thin facade над `ProjectRenderer.astro`
- `BlockRenderer.astro` не содержит orchestration-логики, только registry lookup + dev diagnostics

## 5. SEO Invariants

- canonical для money pages: `https://mebel-irkutsk.ru/{service}`
- canonical для city hubs: `https://mebel-irkutsk.ru/{city}`
- canonical для кейсов: `https://mebel-irkutsk.ru/projects/{slug}`
- без query/hash в canonical
- sitemap обязан включать `/projects` и `/projects/*`
- кейсы должны содержать JSON-LD (`Product/Service/Breadcrumb`)

## 6. Internal Linking

Обязательная перелинковка:

- money page -> блок кейсов по `service`
- project page -> обратная ссылка на `/{service}`
- project page -> похожие кейсы по `city + service`

## 7. Renderer And Extension Contract

Block system:

- схема блоков описана в `src/content/config.ts`
- registry блоков описан в `src/components/projects/block-registry.ts`
- порядок рендера и вставка derived sections централизованы в `src/components/projects/ProjectRenderer.astro`
- неизвестные block types допускаются только как dev-diagnostic path, не как вторая runtime-система

При добавлении нового block type нужно менять:

1. `src/content/config.ts`
2. `src/components/projects/block-registry.ts`
3. `src/components/projects/ProjectRenderer.astro` — только если блоку нужен фиксированный slot в порядке страницы

При добавлении нового проекта менять renderer не требуется.

## 8. Test Contract

Архитектура защищается инвариантными тестами и quality gates:

- `tests/architecture.test.ts`
- `tests/generated-pages.test.ts`
- `tests/seo-canonical.test.ts`
- `tests/projects.test.ts`
- `tests/project-render-plan.test.ts`
- `tests/project-block-registry.test.ts`
- `tests/project-block-atoms-integration.test.ts`

Основные команды:

- `npm test`
- `npm run check:architecture`
- `npm run check:no-legacy-project-fields`
- `npm run audit:pre-launch`

## 9. Runtime / Edge Contract

- Production edge: `Netlify`
- `/api/*` должен исполняться как platform functions
- Docker + Nginx (текущая конфигурация) допускается только как static preview (`dist`)
- `Vercel` для этого репозитория считается deprecated / неиспользуемым target

## 10. Proxy Trust Policy

- По умолчанию:
  - `CONTACT_TRUST_PROXY_HEADERS=false`
  - `TRACK_TRUST_PROXY_HEADERS=false`
  - `ADMIN_TRUST_PROXY_HEADERS=false`
- Включать trust proxy можно только при документированной доверенной proxy-цепочке
- Нельзя включать trust proxy одновременно с неподтвержденной edge-конфигурацией
