# Pre-Launch Audit Playbook (42 Questions)

## Purpose

Этот документ задаёт отдельный pre-launch контур на 42 вопроса.

- 28-вопросный `pre-release` остаётся совместимым быстрым контуром.
- 42-вопросный `pre-launch` — финальный релизный аудит перед публикацией.

Итог всегда бинарный: `GO` или `NO-GO`.

## Operating Rules

- Запускать из корня репозитория.
- Использовать `npm run audit:pre-launch` как единый auto-runner.
- Для manual/ops пунктов обязательно указывать: `Owner`, `Due`, `Mitigation`.
- Статусы: `PASS`, `FAIL`, `MANUAL`, `NA/ops`.

## Default Environments

Если переменные не заданы, runner использует:

- `PUBLIC_SITE_URL=https://example.com`
- `METRICS_ADMIN_TOKEN=__SENTINEL__`
- `NODE_OPTIONS=--max-old-space-size=4096`
- `LHCI_NUMBER_OF_RUNS=1`
- `LHCI_BUILD_CONTEXT__CURRENT_BRANCH=local`

## Q22 Required Lighthouse Route Set

Для pre-launch minimum CWV coverage runner обязан проверять:

- `/`
- `/kuhni`
- `/shkafy`
- `/garderobnye`
- `/kuhni-3-metra`
- `/projects/biruzovaya-uglovaya-kuhnya-irkutsk`

## Verdict and Scoring

- `NO-GO`, если красный любой auto-blocker: `Q1,Q2,Q4,Q5,Q6,Q9,Q10,Q19,Q20,Q22,Q24,Q32,Q39`.
- `GO`, если auto-blockers зелёные и critical manual-пункты закрыты (`Owner + Due + Mitigation` заполнены, без P1-риска).
- `Auto Score`: только auto-вопросы (по блокам, 0..10).
- `Final Score`: заполняется после закрытия manual/ops части.

## Artifacts

Auto-runner обязан писать:

- `artifacts/pre-launch-audit/latest/auto-results.json`
- `artifacts/pre-launch-audit/latest/summary.md`

Датированный отчёт:

- `docs/pre-launch-audit-YYYY-MM-DD.md`

---

## 42-Question Matrix

| Question                                                                       | Type        | Blocker | Evidence                                                      | OwnerRequired | Rule                          |
| ------------------------------------------------------------------------------ | ----------- | ------- | ------------------------------------------------------------- | ------------- | ----------------------------- |
| Q1. Все базовые гейты зелёные (`lint/typecheck/check:astro/test/build`)?       | auto        | yes     | npm commands + logs                                           | no            | Любой fail => `NO-GO`         |
| Q2. `npm run audit:pre-release` зелёный?                                       | auto        | yes     | command log                                                   | no            | Fail => `NO-GO`               |
| Q3. В project-layer нет `any/unknown/as`?                                      | auto        | no      | source scan result                                            | no            | Fail снижает score            |
| Q4. Нет сырого `/images/projects/` в шаблонах/dist?                            | auto        | yes     | source/dist scan + image policy                               | no            | Fail => `NO-GO`               |
| Q5. LCP smoke + hero-LCP contract зелёные?                                     | auto        | yes     | lighthouse summary + lhr                                      | no            | Fail => `NO-GO`               |
| Q6. Нет duplicate `slug/id`?                                                   | auto        | yes     | `check:slugs`, `check:content-duplicates`                     | no            | Fail => `NO-GO`               |
| Q7. Build устойчив при альтернативном `PUBLIC_SITE_URL`?                       | auto        | no      | alt build + canonical/sitemap checks                          | no            | Fail снижает score            |
| Q8. Ключевые block-атомы имеют интеграционное покрытие?                        | auto        | no      | test evidence scan                                            | no            | Fail снижает score            |
| Q9. Legacy project fields/path отсутствуют?                                    | auto        | yes     | `check:no-legacy-project-fields` + marker scan                | no            | Fail => `NO-GO`               |
| Q10. Рендер идёт только через `ProjectRenderer/BlockRenderer` контракт?        | auto        | yes     | contract files + no-legacy markers                            | no            | Fail => `NO-GO`               |
| Q11. Trust-блок в первых 2–3 экранах money pages подтверждён?                  | manual      | no      | screenshot + DOM note                                         | yes           | Требуется owner/due           |
| Q12. На money pages есть `data-service-projects` + «Наши работы»?              | auto        | no      | dist HTML scan                                                | no            | Fail снижает score            |
| Q13. На money pages есть `service_reentry_primary` + `service_reentry_call`?   | auto        | no      | dist HTML scan                                                | no            | Fail снижает score            |
| Q14. E-E-A-T (Claude full-content-audit) >= 8/10?                              | manual      | no      | prompt output                                                 | yes           | Требуется owner/due           |
| Q15. Семантическая полнота money clusters >= 8/10?                             | manual      | no      | editorial evidence                                            | yes           | Требуется owner/due           |
| Q16. Indexable-link coverage + weak-page feeding подтверждены?                 | auto+manual | no      | `check:indexable-link-coverage` + manual notes                | yes           | Manual часть обязательна      |
| Q17. Schema coverage достаточна (`LocalBusiness/Offer/Review/BreadcrumbList`)? | auto+manual | no      | `check:schema` + JSON-LD review                               | yes           | Manual часть обязательна      |
| Q18. Rich Results Test подтверждает валидность?                                | NA/ops      | no      | external run link                                             | yes           | Если нет доступа: `NA/ops`    |
| Q19. Sitemap/robots/indexability полностью зелёные?                            | auto        | yes     | sitemap/indexability checks                                   | no            | Fail => `NO-GO`               |
| Q20. Нет thin-content среди indexable страниц?                                 | auto        | yes     | `check:content-length`                                        | no            | Fail => `NO-GO`               |
| Q21. Topical authority кластеров подтверждён?                                  | manual      | no      | cluster map + links                                           | yes           | Требуется owner/due           |
| Q22. CWV smoke на обязательном route-наборе зелёный?                           | auto+manual | yes     | required-route LH run + metrics                               | no            | Fail => `NO-GO`               |
| Q23. Mobile adaptation audit без критичных дефектов?                           | auto+manual | no      | `mobile-adaptation-audit` report                              | yes           | Manual visual sign-off        |
| Q24. Local SEO/NAP сигналы подтверждены?                                       | auto+manual | yes     | `check:nap-consistency`, `check:geo-signals`, schema + manual | yes           | Fail => `NO-GO`               |
| Q25. Новый проект добавляется без лишних touchpoints?                          | manual      | no      | onboarding walkthrough                                        | yes           | Требуется owner/due           |
| Q26. Block registry остаётся декларативным?                                    | auto        | no      | registry contract check                                       | no            | Fail снижает score            |
| Q27. `NormalizedProjectContent` остаётся единым source of truth?               | auto        | no      | source contract scan                                          | no            | Fail снижает score            |
| Q28. Нет дублирования orchestration между renderers?                           | manual      | no      | code review notes                                             | yes           | Требуется owner/due           |
| Q29. Компоненты блоков атомарны и переиспользуемы?                             | manual      | no      | component audit                                               | yes           | Требуется owner/due           |
| Q30. `ARCHITECTURE.md` актуален относительно кода?                             | manual      | no      | doc vs code diff                                              | yes           | Требуется owner/due           |
| Q31. Нет `TODO: legacy` / `temporary fix`?                                     | auto        | no      | source scan                                                   | no            | Fail снижает score            |
| Q32. CI/CD quality gates покрывают release path, включая lead runtime smoke?   | auto        | yes     | `QUALITY_GATES.md` + runtime scripts + workflow inventory     | no            | Fail => `NO-GO`               |
| Q33. CTA видимы на mobile в длинных money pages?                               | manual      | no      | viewport screenshots                                          | yes           | Требуется owner/due           |
| Q34. CTA тексты и стили унифицированы?                                         | manual      | no      | UI consistency review                                         | yes           | Требуется owner/due           |
| Q35. A11y smoke baseline зелёный?                                              | auto        | no      | `check:accessibility`                                         | no            | Fail снижает score            |
| Q36. Hero содержит оффер + локальную привязку?                                 | manual      | no      | hero copy review                                              | yes           | Требуется owner/due           |
| Q37. Карточки проектов визуально консистентны?                                 | manual      | no      | design audit captures                                         | yes           | Требуется owner/due           |
| Q38. В money flow нет визуального шума/дублей?                                 | manual      | no      | visual QA notes                                               | yes           | Требуется owner/due           |
| Q39. Есть P1-блокеры?                                                          | auto        | yes     | aggregated blocker state                                      | no            | Любой blocker fail => `NO-GO` |
| Q40. Content moat достаточен для целевых запросов?                             | manual      | no      | editorial verdict                                             | yes           | Обязательный owner            |
| Q41. Можно перейти в режим “только контентные улучшения”?                      | manual      | no      | architecture freeze verdict                                   | yes           | Обязательный owner            |
| Q42. Dual score и финальный verdict зафиксированы?                             | auto        | no      | auto score + final score fields                               | no            | Должен быть заполнен          |
