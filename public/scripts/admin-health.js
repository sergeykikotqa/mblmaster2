(() => {
const $ = (id) => document.getElementById(id);
const esc = (value) =>
String(value ?? '-')
.replaceAll('&', '&amp;')
.replaceAll('<', '&lt;')
.replaceAll('>', '&gt;')
.replaceAll('"', '&quot;')
.replaceAll("'", '&#39;');
const API_PATH = '/api/admin/health';
const ui = {
refresh: $('health-check-button'),
auto: $('health-auto-refresh'),
interval: $('health-refresh-interval'),
status: $('health-status'),
chip: $('health-overall-chip'),
dashboard: $('health-dashboard'),
cards: $('health-cards'),
ops: $('health-operations'),
details: $('health-detail-body'),
raw: $('health-raw'),
authMethod: $('health-auth-method'),
lastUpdated: $('health-last-updated'),
totalDuration: $('health-total-duration'),
averageLatency: $('health-average-latency'),
slowest: $('health-latency'),
systemAuth: $('health-system-auth'),
proxy: $('health-proxy-trust'),
failOpen: $('health-fail-open'),
};
if (
Object.values(ui).some(
(node) =>
!(node instanceof HTMLElement) &&
!(node instanceof HTMLInputElement) &&
!(node instanceof HTMLButtonElement) &&
!(node instanceof HTMLSelectElement)
)
)
return;

const baseTitle = document.title;
const timeFormatter = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const chipClasses = {
neutral: 'bg-slate-100 text-slate-700',
ok: 'bg-emerald-100 text-emerald-800',
warning: 'bg-amber-100 text-amber-800',
fail: 'bg-rose-100 text-rose-800',
};
const cardClasses = {
ok: 'border-emerald-200 bg-emerald-50 text-emerald-900',
warning: 'border-amber-200 bg-amber-50 text-amber-900',
fail: 'border-rose-200 bg-rose-50 text-rose-900',
};
const state = {
ui: 'idle',
inFlight: false,
rateLimitedUntil: 0,
rateTimer: 0,
freshnessTimer: 0,
autoTimer: 0,
lastUpdatedAtMs: 0,
};
const setStatus = (next, message) => {
state.ui = next;
ui.status.dataset.state = next;
ui.status.textContent = message;
const disabled = state.inFlight || (state.ui === 'rate_limited' && state.rateLimitedUntil > Date.now());
ui.refresh.disabled = disabled;
ui.refresh.classList.toggle('opacity-60', disabled);
ui.refresh.classList.toggle('cursor-not-allowed', disabled);
};
const stopTimer = (key) => {
if (state[key]) window.clearInterval(state[key]);
state[key] = 0;
};
const formatMs = (value) =>
Number.isFinite(Number(value)) && Number(value) >= 0 ? `${Math.round(Number(value))} ms` : '-';
const formatPercent = (value) =>
Number.isFinite(Number(value)) && Number(value) >= 0 ? `${(Number(value) * 100).toFixed(1)}%` : '-';
const retryAfterSeconds = (value) => {
const seconds = Number(value);
if (Number.isFinite(seconds) && seconds > 0) return Math.max(1, Math.ceil(seconds));
const parsed = Date.parse(String(value || ''));
return Number.isNaN(parsed) ? 0 : Math.max(0, Math.ceil((parsed - Date.now()) / 1000));
};
const payloadOf = (entry) => (entry && typeof entry === 'object' ? entry.payload || {} : {});
const latencyOf = (entry) => Number(payloadOf(entry).latencyMs);
const checkedAtOf = (entry) => Number(payloadOf(entry).checkedAtMs);
const getCode = (entry) => String(payloadOf(entry).code || '');
const isTimeout = (entry) => getCode(entry) === 'TIMEOUT';
const isInternalError = (entry) => getCode(entry) === 'INTERNAL_ERROR';
const toneFromSummary = (status) => (status === 'ok' ? 'ok' : status === 'warning' ? 'warning' : 'fail');
const formatLastUpdated = () => {
if (state.lastUpdatedAtMs <= 0) return '-';
const age = Math.max(0, Math.floor((Date.now() - state.lastUpdatedAtMs) / 1000));
return `${age === 0 ? 'just now' : `${age}s ago`} (${timeFormatter.format(state.lastUpdatedAtMs)})`;
};
const updateLastUpdated = () => {
ui.lastUpdated.textContent = formatLastUpdated();
};
const summarizeSystem = (payload) => {
const parts = [];
if (!payload.tokenConfigured) parts.push('admin token missing');
if (Number(payload.invalidAllowlistEntriesCount || 0) > 0)
parts.push(`invalid allowlist: ${payload.invalidAllowlistEntriesCount}`);
return parts.length > 0 ? parts.join(' · ') : 'token and allowlist look valid';
};
const summarizeWorker = (entry) => {
const payload = payloadOf(entry);
if (isTimeout(entry)) return `timeout after ${payload.timeoutMs || '?'} ms`;
if (isInternalError(entry)) return 'internal error';
const deps = payload.dependencies || {};
const missing = [];
if (deps.workerTokenConfigured === false) missing.push('worker token');
if (deps.redisConfigured === false) missing.push('redis');
if (deps.webhookConfigured === false) missing.push('webhook');
if (deps.smartCaptchaRequired && deps.smartCaptchaReady === false) missing.push('SmartCaptcha');
return missing.length > 0 ? `missing: ${missing.join(', ')}` : 'runtime ready';
};
const summarizePipeline = (entry) => {
const payload = payloadOf(entry);
if (isTimeout(entry)) return `timeout after ${payload.timeoutMs || '?'} ms`;
if (isInternalError(entry)) return 'internal error';
if (payload.metricsDegraded) return 'running on fallback memory';
if (payload.alerts?.dlqIncident) return 'DLQ incidents detected';
if (payload.alerts?.retryRateWarning) return `retry rate ${formatPercent(payload.retryRateLastHour)}`;
if (Number.isFinite(payload.p95LatencyMs)) return `p95 delivery ${Math.round(payload.p95LatencyMs)} ms`;
return payload.metricsDataSource === 'redis' ? 'durable store available' : 'pipeline healthy';
};
const summarizeMetrics = (entry) => {
const payload = payloadOf(entry);
if (isTimeout(entry)) return `timeout after ${payload.timeoutMs || '?'} ms`;
if (isInternalError(entry)) return 'internal error';
if (payload.alerts?.lowConversion) return 'conversion below threshold';
if (payload.dataSource && payload.dataSource !== 'redis') return `using ${payload.dataSource} snapshot`;
return Number.isFinite(payload?.totals?.pageViews)
? `${payload.totals.pageViews} page views today`
: 'snapshot healthy';
};
const deriveCards = (payload) => {
const summary = payload.summary || {};
const checks = payload.checks || {};
return [
{
label: 'System auth',
tone: summary.systemAuth?.status === 'WARNING' ? 'warning' : 'ok',
status: summary.systemAuth?.status === 'WARNING' ? 'WARNING' : 'OK',
detail: summarizeSystem(payloadOf(checks.system)),
},
{
label: 'Redis',
tone: isInternalError(checks.pipeline)
? 'fail'
: String(summary.redis?.label || '').startsWith('OK')
? 'ok'
: 'warning',
status: isInternalError(checks.pipeline)
? 'FAIL'
: String(summary.redis?.label || '').startsWith('OK')
? 'OK'
: 'DEGRADED',
detail: summarizePipeline(checks.pipeline),
},
{
label: 'Worker',
tone: isInternalError(checks.worker) ? 'fail' : payloadOf(checks.worker).ok === true ? 'ok' : 'warning',
status: isInternalError(checks.worker) ? 'FAIL' : payloadOf(checks.worker).ok === true ? 'OK' : 'DEGRADED',
detail: summarizeWorker(checks.worker),
},
{
label: 'Snapshot',
tone: isInternalError(checks.metrics)
? 'fail'
: payloadOf(checks.metrics).ok === true && String(summary.snapshot?.label || '').startsWith('OK')
? 'ok'
: 'warning',
status: isInternalError(checks.metrics)
? 'FAIL'
: payloadOf(checks.metrics).ok === true && String(summary.snapshot?.label || '').startsWith('OK')
? 'OK'
: 'DEGRADED',
detail: summarizeMetrics(checks.metrics),
},
{
label: 'Proxy',
tone: 'ok',
status: 'OK',
detail: summary.proxyTrust?.enabled ? 'trusted proxy headers enabled' : 'trusted proxy headers disabled',
},
];
};
const renderCards = (payload) => {
ui.cards.innerHTML = deriveCards(payload)
.map(
(card) =>
`<article class="rounded-xl border p-4 ${cardClasses[card.tone]}"><div class="flex items-center justify-between gap-3"><div><p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">${esc(card.label)}</p><p class="mt-2 text-lg font-semibold">${esc(card.status)}</p></div><span class="h-3 w-3 rounded-full ${card.tone === 'ok' ? 'bg-emerald-500' : card.tone === 'warning' ? 'bg-amber-500' : 'bg-rose-500'}"></span></div><p class="mt-3 text-sm">${esc(card.detail)}</p></article>`
)
.join('');
};
const renderOperations = (payload) => {
const metrics = payloadOf(payload.checks?.metrics);
const pipeline = payloadOf(payload.checks?.pipeline);
const items = [
['Leads today', metrics?.totals?.formSubmitted ?? '-'],
['Forms opened', metrics?.totals?.formOpened ?? '-'],
['Retry rate 1h', formatPercent(pipeline?.retryRateLastHour)],
['DLQ 24h', pipeline?.dlqLast24Hours ?? '-'],
];
ui.ops.innerHTML = items
.map(
([label, value]) =>
`<div class="rounded-xl border border-[#e8d8cb] bg-[#f9f4ef] p-4"><p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">${esc(label)}</p><p class="mt-2 text-2xl font-semibold text-slate-900">${esc(value)}</p></div>`
)
.join('');
};
const renderDetails = (payload) => {
const summary = payload.summary || {};
const rows = [
[
'System auth',
summary.systemAuth?.status || 'OK',
formatMs(latencyOf(payload.checks.system)),
checkedAtOf(payload.checks.system) > 0 ? timeFormatter.format(checkedAtOf(payload.checks.system)) : '-',
summarizeSystem(payloadOf(payload.checks.system)),
],
[
'Worker',
payloadOf(payload.checks.worker).ok === true
? 'OK'
: isInternalError(payload.checks.worker)
? 'FAIL'
: 'DEGRADED',
formatMs(latencyOf(payload.checks.worker)),
checkedAtOf(payload.checks.worker) > 0 ? timeFormatter.format(checkedAtOf(payload.checks.worker)) : '-',
summarizeWorker(payload.checks.worker),
],
[
'Redis / pipeline',
isInternalError(payload.checks.pipeline)
? 'FAIL'
: String(summary.redis?.label || '').startsWith('OK')
? 'OK'
: 'DEGRADED',
formatMs(latencyOf(payload.checks.pipeline)),
checkedAtOf(payload.checks.pipeline) > 0 ? timeFormatter.format(checkedAtOf(payload.checks.pipeline)) : '-',
summarizePipeline(payload.checks.pipeline),
],
[
'Snapshot',
isInternalError(payload.checks.metrics)
? 'FAIL'
: payloadOf(payload.checks.metrics).ok === true && String(summary.snapshot?.label || '').startsWith('OK')
? 'OK'
: 'DEGRADED',
formatMs(latencyOf(payload.checks.metrics)),
checkedAtOf(payload.checks.metrics) > 0 ? timeFormatter.format(checkedAtOf(payload.checks.metrics)) : '-',
summarizeMetrics(payload.checks.metrics),
],
];
ui.details.innerHTML = rows
.map(
(row) =>
`<tr class="border-t border-[#f1e6dd]">${row.map((cell) => `<td class="px-4 py-3 text-slate-700">${esc(cell)}</td>`).join('')}</tr>`
)
.join('');
};
const renderPerformance = (payload) => {
const entries = Object.values(payload.checks || {});
const latencies = entries
.map((entry) => latencyOf(entry))
.filter((value) => Number.isFinite(value) && value >= 0);
const starts = entries
.map((entry) => checkedAtOf(entry) - latencyOf(entry))
.filter((value) => Number.isFinite(value));
const average = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null;
const slowest = entries
.map((entry) => ({ service: payloadOf(entry).service || 'unknown', latencyMs: latencyOf(entry) }))
.filter((entry) => Number.isFinite(entry.latencyMs) && entry.latencyMs >= 0)
.reduce((current, entry) => (!current || entry.latencyMs > current.latencyMs ? entry : current), null);
state.lastUpdatedAtMs = Number(payload.generatedAtMs || 0);
updateLastUpdated();
ui.totalDuration.textContent =
starts.length && Number.isFinite(state.lastUpdatedAtMs)
? formatMs(Math.max(0, state.lastUpdatedAtMs - Math.min(...starts)))
: '-';
ui.averageLatency.textContent = average === null ? '-' : formatMs(average);
ui.slowest.textContent = slowest ? `${slowest.service} (${Math.round(slowest.latencyMs)} ms)` : '-';
ui.authMethod.textContent = payload.authMethod || '-';
ui.systemAuth.textContent = payload.summary?.systemAuth?.status || '-';
ui.proxy.textContent = payload.summary?.proxyTrust?.label || '-';
ui.failOpen.textContent = payload.summary?.failOpen ? 'enabled' : 'no';
};
const refreshFreshness = () => {
ui.lastUpdated.textContent = formatLastUpdated();
};
const renderDashboard = (payload) => {
ui.dashboard.hidden = false;
ui.raw.textContent = JSON.stringify(payload, null, 2);
renderCards(payload);
renderPerformance(payload);
renderOperations(payload);
renderDetails(payload);
stopTimer('freshnessTimer');
state.freshnessTimer = window.setInterval(refreshFreshness, 1000);
ui.chip.className = `inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] ${chipClasses[toneFromSummary(payload.summary?.status)]}`;
ui.chip.textContent =
payload.summary?.status === 'ok' ? 'OK' : payload.summary?.status === 'warning' ? 'WARNING' : 'DEGRADED';
document.title = `${ui.chip.textContent} · ${baseTitle}`;
};
const resetDashboard = () => {
ui.dashboard.hidden = true;
ui.cards.innerHTML = '';
ui.ops.innerHTML = '';
ui.details.innerHTML = '';
ui.raw.textContent = '-';
ui.authMethod.textContent = '-';
ui.lastUpdated.textContent = '-';
ui.totalDuration.textContent = '-';
ui.averageLatency.textContent = '-';
ui.slowest.textContent = '-';
ui.systemAuth.textContent = '-';
ui.proxy.textContent = '-';
ui.failOpen.textContent = '-';
ui.chip.className = `inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] ${chipClasses.neutral}`;
ui.chip.textContent = 'Idle';
document.title = baseTitle;
state.lastUpdatedAtMs = 0;
stopTimer('freshnessTimer');
};
const stopAutoRefresh = () => {
ui.auto.checked = false;
stopTimer('autoTimer');
};
const scheduleAutoRefresh = () => {
stopTimer('autoTimer');
if (!ui.auto.checked) return;
const intervalMs = Math.max(1000, Number(ui.interval.value || 5000));
state.autoTimer = window.setInterval(() => {
if (state.inFlight) return;
if (state.ui === 'rate_limited' && state.rateLimitedUntil > Date.now()) return;
void checkHealth(true);
}, intervalMs);
};
const parseJson = async (response) => {
try {
return await response.json();
} catch {
return null;
}
};
const checkHealth = async (background = false) => {
if (state.inFlight) return;
if (state.ui === 'rate_limited' && state.rateLimitedUntil > Date.now()) return;
state.inFlight = true;
if (!background) setStatus('loading', 'Проверка health-состояния...');
try {
const response = await fetch(API_PATH, {
credentials: 'same-origin',
});
const payload = await parseJson(response);
ui.raw.textContent = JSON.stringify(payload || {}, null, 2);
if (response.status === 429 || String(payload?.code || '') === 'TOO_MANY_REQUESTS') {
stopAutoRefresh();
resetDashboard();
const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
state.rateLimitedUntil = retryAfter > 0 ? Date.now() + retryAfter * 1000 : 0;
setStatus(
'rate_limited',
retryAfter > 0
? `TOO_MANY_REQUESTS: повторите через ${retryAfter}s.`
: 'TOO_MANY_REQUESTS: слишком много попыток.'
);
stopTimer('rateTimer');
if (retryAfter > 0)
state.rateTimer = window.setInterval(() => {
if (state.rateLimitedUntil <= Date.now()) {
stopTimer('rateTimer');
state.rateLimitedUntil = 0;
setStatus('idle', 'Блокировка снята. Можно повторить проверку.');
}
}, 1000);
return;
}
if (response.status === 401 || String(payload?.code || '') === 'UNAUTHORIZED') {
stopAutoRefresh();
resetDashboard();
setStatus('error', 'UNAUTHORIZED: сессия завершена. Войдите через Telegram повторно.');
window.location.assign(`/admin/login?next=${encodeURIComponent(window.location.pathname)}`);
return;
}
if (String(payload?.code || '') === 'ADMIN_AUTH_NOT_CONFIGURED') {
stopAutoRefresh();
resetDashboard();
setStatus('error', 'ADMIN_AUTH_NOT_CONFIGURED: вход владельца не настроен на сервере.');
return;
}
if (!payload || typeof payload !== 'object' || typeof payload.summary !== 'object') {
stopAutoRefresh();
resetDashboard();
setStatus('error', 'Ошибка health-check: INVALID_PAYLOAD');
return;
}
renderDashboard(payload);
setStatus(
'success',
`Health: ${payload.summary.status === 'ok' ? 'OK' : payload.summary.status === 'warning' ? 'WARNING' : 'DEGRADED'} · ${ui.totalDuration.textContent}`
);
scheduleAutoRefresh();
} catch (error) {
stopAutoRefresh();
resetDashboard();
ui.raw.textContent = JSON.stringify({ ok: false, code: 'NETWORK_ERROR' }, null, 2);
setStatus('error', `Ошибка health-check: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
} finally {
state.inFlight = false;
setStatus(state.ui, ui.status.textContent || '');
}
};

ui.refresh.addEventListener('click', () => void checkHealth(false));
ui.auto.addEventListener('change', () => {
scheduleAutoRefresh();
if (ui.auto.checked && ui.dashboard.hidden) void checkHealth(false);
});
ui.interval.addEventListener('change', scheduleAutoRefresh);
resetDashboard();
setStatus('idle', 'Нажмите «Refresh now», чтобы получить актуальное состояние системы.');
})();
