# Architecture Rules

## Stack

- Framework: Astro
- Styling: Tailwind CSS
- Images: Astro Image (src/assets, no raw large raster in public)
- Hosting: Netlify

## Routing Allowlist

Разрешены только текущие маршруты:

- /
- /contacts
- /o-kompanii
- /privacy
- /terms
- /thanks
- /projects
- /projects/[slug]
- /articles
- /articles/[slug]
- /guides
- /guides/[slug]
- /faq
- /faq/[slug]
- /[service]
- /irkutsk
- /angarsk
- /shelekhov
- /admin
- /admin/metrics
- /404
- /410

Запрещено:

- новые routing-структуры
- catch-all страницы
- micro-кластеры в src/pages/kuhni, src/pages/shkafy, src/pages/garderobnye

## Prohibited Changes

- NO NEW ROUTING STRUCTURES
- NO NEW CMS
- NO CLIENT FRAMEWORKS

## Content Allowlist

Разрешенные папки контента:

- src/content/projects
- src/content/articles
- src/content/guides
- src/content/faq
- src/content/cities
- src/content/services
- src/content/keywords
- src/data/post (legacy)

## Forbidden Dependencies

Нельзя добавлять:

- react
- react-dom
- next
- vue
- nuxt
- angular
- @angular/\*

## Layers (1 PR = 1 layer)

Слои:

- content
- components
- layout
- scripts
- seo

Запрещено менять несколько слоев в одном PR.

## Task Template

```
TASK TYPE
fix | refactor | feature | content

FILES ALLOWED
<explicit paths>

FILES FORBIDDEN
routing
config
seo pipeline

SUCCESS CRITERIA
npm run check PASS
npm test PASS
npm run check:lighthouse PASS
```

## PR Template

```
Summary

Files changed

Risk

Tests

Performance impact
```

## PR Size Limit

- MAX 300 lines OR <= 10 files

## CI Gate (must pass)

- npm run check
- npm run typecheck
- npm test
- npm run check:audit
- npm run check:lighthouse
- npm run check:accessibility
- npm run check:image-policy
- npm run check:performance-budgets
- npm run check:architecture
- npm run check:pr-size

## Performance Budgets

- Total JS (gzip) <= 30KB
- Per-page JS (gzip) <= 15KB
- Total CSS (gzip) <= 120KB

## Image Policy

- public/images: raster <= 500KB
- SVG/иконки разрешены
- крупные изображения только через Astro Image и src/assets

## JS Policy

- No JS unless necessary
- Default: CSS-first (scroll-snap и минимальный JS)
- Максимум 10KB gzip на новый функциональный блок

## Workflow

PLAN → GENERATE TASK → AI IMPLEMENT → LOCAL CHECKS → CI CHECKS → MERGE

## Nightly Checks

- 03:00 UTC: check:lighthouse, check:seo, check:accessibility
