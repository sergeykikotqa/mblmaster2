import { authorizeAdminRequest } from '~/server/admin/auth';
import {
  getHealthStateStoreRuntimeStats,
  getHealthTransitionHistory,
  listHealthStates,
} from '~/server/metrics/state-store';
import type { HealthScope, HealthState, HealthStateRecord } from '~/server/metrics/health-types';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

type AdminHealthView = 'summary' | 'states' | 'transitions';

function parseView(value: string | null): AdminHealthView {
  if (value === 'states') return 'states';
  if (value === 'transitions') return 'transitions';
  return 'summary';
}

function parseLimit(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 200;
  return Math.max(1, Math.min(2000, Math.floor(parsed)));
}

function parseScope(value: string | null): HealthScope | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) return undefined;
  if (normalized === 'global') return normalized;
  if (normalized === 'city') return normalized;
  if (normalized === 'service') return normalized;
  if (normalized === 'city_service') return normalized;
  if (normalized === 'page_type') return normalized;
  return undefined;
}

function summarizeStates(states: HealthStateRecord[]) {
  const byState: Record<HealthState, number> = {
    HEALTHY: 0,
    DEGRADED: 0,
    CRITICAL: 0,
    RECOVERING: 0,
  };
  const byScope: Record<HealthScope, number> = {
    global: 0,
    city: 0,
    service: 0,
    city_service: 0,
    page_type: 0,
  };

  for (const state of states) {
    byState[state.state] += 1;
    byScope[state.scope] += 1;
  }

  return {
    byState,
    byScope,
  };
}

function mergeSource(left: 'redis' | 'memory' | 'mixed', right: 'redis' | 'memory'): 'redis' | 'memory' | 'mixed' {
  if (left === right) return left;
  return 'mixed';
}

export async function handleAdminHealthStateRequest(
  request: Request,
  scope: string,
  clientAddress?: string
): Promise<Response> {
  const auth = await authorizeAdminRequest(request, {
    scope,
    clientAddress,
    rateLimitScope: 'admin:health',
  });
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const url = new URL(request.url);
    const view = parseView(url.searchParams.get('view'));
    const limit = parseLimit(url.searchParams.get('limit'));
    const requestedScope = parseScope(url.searchParams.get('scope'));

    const states = await listHealthStates({
      limit,
      scope: requestedScope,
    });
    const transitions =
      view === 'transitions' || view === 'summary'
        ? await getHealthTransitionHistory({ limit })
        : {
            value: [],
            dataSource: states.dataSource,
            degraded: states.degraded,
          };

    const combinedSource = mergeSource(states.dataSource, transitions.dataSource);
    const degraded = states.degraded || transitions.degraded;
    const summary = summarizeStates(states.value);
    const runtime = getHealthStateStoreRuntimeStats();

    return new Response(
      JSON.stringify({
        ok: true,
        view,
        authMethod: auth.method,
        dataSource: combinedSource,
        degraded,
        runtime,
        summary: {
          statesTracked: states.value.length,
          transitionsSampled: transitions.value.length,
          byState: summary.byState,
          byScope: summary.byScope,
        },
        states: view === 'states' ? states.value : undefined,
        transitions: view === 'transitions' ? transitions.value : undefined,
      }),
      {
        status: 200,
        headers: JSON_HEADERS,
      }
    );
  } catch (error) {
    console.error('[admin-health-state] unhandled_error', {
      scope,
      error: error instanceof Error ? error.message : 'UNKNOWN',
    });
    return new Response(
      JSON.stringify({
        ok: false,
        code: 'INTERNAL_ERROR',
      }),
      {
        status: 500,
        headers: JSON_HEADERS,
      }
    );
  }
}
