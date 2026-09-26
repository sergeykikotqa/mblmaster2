(() => {
const API_PATH = '/api/admin/metrics';
const form = document.getElementById('metrics-filter');
const submitButton = document.getElementById('metrics-submit');
const tableBody = document.getElementById('metrics-table-body');
const summary = document.getElementById('metrics-summary');
const UI_STATE = Object.freeze({
IDLE: 'idle',
LOADING: 'loading',
SUCCESS: 'success',
ERROR: 'error',
RATE_LIMITED: 'rate_limited',
});
let uiState = UI_STATE.IDLE;
let rateLimitUntilMs = 0;
let rateLimitTimerId = 0;

if (
!(form instanceof HTMLFormElement) ||
!(submitButton instanceof HTMLButtonElement) ||
!(tableBody instanceof HTMLElement) ||
!(summary instanceof HTMLElement)
)
return;

const formatDuration = (totalSeconds) => {
const safe = Math.max(0, Math.floor(totalSeconds));
const hours = Math.floor(safe / 3600);
const minutes = Math.floor((safe % 3600) / 60);
const seconds = safe % 60;
if (hours > 0) {
return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(
2,
'0'
)}`;
}
return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const setSummaryText = (message) => {
summary.textContent = message;
};

const setSummaryHtml = (html) => {
summary.innerHTML = html;
};

const setSubmitDisabled = (disabled) => {
submitButton.disabled = disabled;
submitButton.setAttribute('aria-disabled', disabled ? 'true' : 'false');
submitButton.classList.toggle('opacity-60', disabled);
submitButton.classList.toggle('cursor-not-allowed', disabled);
};

const stopRateLimitTimer = () => {
if (!rateLimitTimerId) return;
window.clearInterval(rateLimitTimerId);
rateLimitTimerId = 0;
};

const parseRetryAfterSeconds = (headerValue) => {
const value = String(headerValue || '').trim();
if (!value) return 0;

const asSeconds = Number(value);
if (Number.isFinite(asSeconds) && asSeconds > 0) {
return Math.max(1, Math.ceil(asSeconds));
}

const asDateMs = Date.parse(value);
if (!Number.isNaN(asDateMs)) {
const deltaMs = asDateMs - Date.now();
if (deltaMs > 0) return Math.max(1, Math.ceil(deltaMs / 1000));
}

return 0;
};

const renderEmptyRows = (message = 'Нет данных для отображения.') => {
tableBody.innerHTML = `<tr><td colspan="6" class="px-4 py-6 text-center text-slate-500">${message}</td></tr>`;
};

const renderRows = (entries) => {
tableBody.innerHTML = '';
if (!Array.isArray(entries) || entries.length === 0) {
renderEmptyRows('Нет данных для выбранного фильтра.');
return;
}

for (const entry of entries) {
const views = Number(entry.pageViews || 0);
const opened = Number(entry.formOpened || 0);
const submitted = Number(entry.formSubmitted || 0);

const row = document.createElement('tr');
row.className = 'border-t border-[#f0e6de]';
row.innerHTML = `
<td class="px-4 py-3"><a class="text-[#9f6d4b] hover:underline" href="${entry.pageSlug}" target="_blank" rel="noopener">${entry.pageSlug}</a></td>
<td class="px-4 py-3">${entry.city || '-'}</td>
<td class="px-4 py-3">${entry.service || '-'}</td>
<td class="px-4 py-3">${views}</td>
<td class="px-4 py-3">${opened}</td>
<td class="px-4 py-3">${submitted}</td>
`;
tableBody.appendChild(row);
}
};

const updateRateLimitedSummary = () => {
if (uiState !== UI_STATE.RATE_LIMITED) return;
const remainingSec = Math.max(0, Math.ceil((rateLimitUntilMs - Date.now()) / 1000));
if (remainingSec <= 0) {
stopRateLimitTimer();
rateLimitUntilMs = 0;
uiState = UI_STATE.IDLE;
summary.dataset.state = uiState;
setSummaryText('Блокировка снята. Повторите запрос.');
setSubmitDisabled(false);
return;
}
setSummaryText(`TOO_MANY_REQUESTS: повторите через ${formatDuration(remainingSec)}.`);
setSubmitDisabled(true);
};

const startRateLimitTimer = () => {
stopRateLimitTimer();
updateRateLimitedSummary();
rateLimitTimerId = window.setInterval(updateRateLimitedSummary, 1000);
};

const setState = (nextState, options = {}) => {
uiState = nextState;
summary.dataset.state = nextState;
const message = options.message || '';

if (nextState === UI_STATE.IDLE) {
stopRateLimitTimer();
setSubmitDisabled(false);
setSummaryText(message || 'Настройте фильтры и нажмите «Обновить».');
return;
}

if (nextState === UI_STATE.LOADING) {
stopRateLimitTimer();
setSubmitDisabled(true);
setSummaryText('Загрузка...');
return;
}

if (nextState === UI_STATE.SUCCESS) {
stopRateLimitTimer();
setSubmitDisabled(false);
setSummaryHtml(options.html || message || 'Успешно.');
return;
}

if (nextState === UI_STATE.ERROR) {
stopRateLimitTimer();
setSubmitDisabled(false);
setSummaryText(message || 'Ошибка загрузки.');
return;
}

if (nextState === UI_STATE.RATE_LIMITED) {
setSubmitDisabled(true);
const retryAfterSec = Number(options.retryAfterSec || 0);
if (retryAfterSec > 0) {
rateLimitUntilMs = Date.now() + retryAfterSec * 1000;
startRateLimitTimer();
return;
}
stopRateLimitTimer();
rateLimitUntilMs = 0;
setSummaryText(message || 'TOO_MANY_REQUESTS: слишком много неудачных попыток.');
}
};

const parseResponseJson = async (response) => {
try {
return await response.json();
} catch {
return null;
}
};

const loadMetrics = async () => {
if (uiState === UI_STATE.RATE_LIMITED && rateLimitUntilMs > Date.now()) {
updateRateLimitedSummary();
return;
}

const fd = new FormData(form);
const params = new URLSearchParams();
for (const [key, value] of fd.entries()) {
const normalized = String(value || '').trim();
if (!normalized) continue;
params.set(key, normalized);
}

setState(UI_STATE.LOADING);
try {
const response = await fetch(`${API_PATH}?${params.toString()}`, {
credentials: 'same-origin',
});
const payload = await parseResponseJson(response);
if (!response.ok || !payload?.ok) {
const code = payload?.code || `HTTP_${response.status}`;
if (code === 'UNAUTHORIZED') {
renderEmptyRows('Сессия завершена. Войдите через Telegram повторно.');
setState(UI_STATE.ERROR, {
message: 'UNAUTHORIZED: сессия завершена.',
});
window.location.assign(`/admin/login?next=${encodeURIComponent(window.location.pathname)}`);
return;
}

if (code === 'TOO_MANY_REQUESTS' || response.status === 429) {
renderEmptyRows('Слишком много неудачных попыток. Дождитесь завершения блокировки.');
const retryAfterSec = parseRetryAfterSeconds(response.headers.get('retry-after'));
setState(UI_STATE.RATE_LIMITED, {
retryAfterSec,
message: 'TOO_MANY_REQUESTS: слишком много неудачных попыток, повторите позже.',
});
return;
}

if (code === 'ADMIN_AUTH_NOT_CONFIGURED') {
renderEmptyRows('Сервер не настроен для admin auth.');
setState(UI_STATE.ERROR, {
message: 'ADMIN_AUTH_NOT_CONFIGURED: вход владельца не настроен на сервере.',
});
return;
}

if (code === 'TOKEN_IN_QUERY_NOT_ALLOWED') {
renderEmptyRows('Токен в query запрещён.');
setState(UI_STATE.ERROR, {
message: 'TOKEN_IN_QUERY_NOT_ALLOWED: передавайте токен только в Authorization заголовке.',
});
return;
}

renderEmptyRows('Не удалось загрузить данные.');
setState(UI_STATE.ERROR, {
message: `Ошибка загрузки: ${code}`,
});
return;
}

const summaryHtml = `
<strong>Bucket:</strong> ${payload.bucket} |
<strong>Auth:</strong> ${payload.authMethod || '-'} |
<strong>Source:</strong> ${payload.dataSource} |
<strong>Просмотры (с согласием):</strong> ${payload.report?.pageViews ?? payload.totalPageViews ?? 0} |
<strong>Открытия (с согласием):</strong> ${payload.report?.opened ?? payload.totalOpened ?? 0} |
<strong>Принятые заявки (server):</strong> ${payload.report?.submitted ?? payload.totalSubmitted ?? 0} |
<strong>Конверсия:</strong> Нет сопоставимых данных
`;
renderRows(payload.entries);
setState(UI_STATE.SUCCESS, { html: summaryHtml });
} catch (error) {
renderEmptyRows('Ошибка запроса. Проверьте сеть и повторите.');
setState(UI_STATE.ERROR, {
message: `Ошибка загрузки: ${error instanceof Error ? error.message : 'UNKNOWN'}`,
});
}
};

form.addEventListener('submit', (event) => {
event.preventDefault();
void loadMetrics();
});

renderEmptyRows('Данные появятся после успешной загрузки.');
setState(UI_STATE.IDLE);
})();
