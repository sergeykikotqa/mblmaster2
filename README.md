# МБЛ

МБЛ — сайт мебельной компании в Иркутске. Репозиторий объединяет публичный
лидогенерирующий сайт, страницы услуг, проектов и контента, защищённую
веб-админку, метрики и средства эксплуатационного мониторинга.

Production target — самостоятельно управляемый российский VPS. Основной runtime:
Astro Node за Nginx, Redis и закрытый worker trigger внутри production envelope.
Vercel и Netlify не являются production target проекта.

## Current stack

- Astro `^7.3.2` и TypeScript `^5.8.3`;
- Node.js `>=22.12.0`;
- Redis `7.4.7-alpine3.21`;
- Nginx и Docker Compose для production runtime;
- Vitest `^4.1.11` для unit/integration tests;
- Playwright `^1.54.2` для browser, accessibility и smoke-проверок.

Актуальные версии зависимостей определяются `package.json` и lockfile, а
production images — Compose/Docker-конфигурацией.

## Architecture

```text
public browser
  -> nginx
  -> astro node
  -> redis

lead:
browser
  -> SmartCaptcha
  -> /api/leads
  -> Redis queue
  -> private worker
  -> signed HTTPS webhook
```

Маршруты `/api/workers/*` являются закрытыми служебными endpoint и не служат
публичным scheduler. В production worker запускается внутри утверждённого
production envelope.

Оценка conversion health намеренно недоступна: числитель и знаменатель сейчас
имеют несовместимые consent scopes. Это fail-closed контракт, а не ошибка
runtime. Metrics Snapshot V2 хранит только сопоставимые raw counters и не
перезаписывает legacy snapshot/state.

## Local development

```sh
npm ci
npm run dev
npm run check
npm run typecheck
npm test
PUBLIC_SITE_URL=https://example.com npm run build
```

Для PowerShell последний пример эквивалентен:

```powershell
$env:PUBLIC_SITE_URL = 'https://example.com'
npm run build
```

Сборка использует явно заданный тестовый origin; production origin задаётся
только утверждённым deployment environment.

## Important quality gates

- [Quality gates](docs/QUALITY_GATES.md)
- [Pre-launch audit playbook](docs/pre-launch-audit-playbook.md)
- [Release and rollback](docs/release-and-rollback.md)
- [Production runtime](docs/production-runtime.md)
- [Backup and restore](docs/backup-restore-runbook.md)
- [External monitoring](docs/external-monitoring.md)

Полный список специализированных команд находится в `package.json`. Тяжёлые
runtime, recovery и fault-injection gates запускаются только в предусмотренном
ими изолированном окружении.

## Production boundary

Локально реализованы и тестируются механизмы runtime, приёма и доставки заявок,
авторизации, release/rollback, backup/restore и мониторинга. Это не является
доказательством production readiness.

Production acceptance отдельно требует:

- утверждённый VPS, DNS и TLS;
- реальные secrets и их безопасную доставку;
- SmartCaptcha keys и разрешённые домены;
- Telegram OAuth credentials и настоящий HTTPS callback;
- реальный внешний webhook/CRM;
- off-host backup repository и restore drill;
- независимый monitoring host и dead-man receiver;
- deployed runtime smoke и проверку внешних аналитических сервисов.

## Source of truth

При расхождениях используется следующий порядок доверия:

1. текущий код, тесты и конфигурация;
2. текущие operational runbooks из `docs/`;
3. датированные audit, WIP и planning documents только как исторические
   свидетельства.

Git SHA является release identity. Bundle, apply и rollback выполняются через
release tooling; README не закрепляет конкретный SHA как постоянную истину.
