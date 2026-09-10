# Claude Content Audit Export

Этот каталог генерируется командой `npm run audit:content:claude`.

## Что внутри

- `pages.json` — полный канонический корпус страниц
- `pages.jsonl` — одна страница в строке
- `pages.csv` — плоский экспорт для сортировки
- `project-instructions.md` — текст для Claude Project Instructions
- `batches/` — батчи для ручной загрузки в Claude Projects/Artifacts
- `prompts/` — полный prompt pack под этот формат

## Корпус

- Страниц: 69
- Батчей: 10
- Источник текста: очищенный рендер из `dist/**/*.html`

## Рекомендуемый поток

1. Запусти сборку и экспорт:
   - PowerShell: `$env:PUBLIC_SITE_URL='https://mebel-irkutsk.ru'; npm run audit:content:claude`
2. Открой один файл из `batches/`, начиная с первого батча, и загрузи его в Claude Projects/Artifacts.
3. Вставь `project-instructions.md` в Claude Project Instructions.
4. Запусти `prompts/full-content-audit.md`.
5. Затем запусти `prompts/deepen-weakest-pages.md`.
6. Затем запусти `prompts/money-pages-audit.md`.
7. Затем запусти `prompts/faq-guides-audit.md`.
8. При необходимости запусти `prompts/thin-eeat-quick-scan.md`.

## Примечания

- В корпус входят все публичные user-facing HTML-страницы, включая noindex/support pages.
- `/admin/*`, `/api/*`, `/404` и `/410` исключены.
- Для Claude v1 используется только manual Projects/chunks flow: без API и без обратного импорта оценок.
