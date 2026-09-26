import { authorizeAdminRequest } from '~/server/admin/auth';
import { getHealthStateStoreRuntimeStats, probeHealthStateStoreAvailability } from '~/server/metrics/state-store';
import type { HealthScope, HealthState } from '~/server/metrics/health-types';

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

function emptySummary() {
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

  return {
    statesTracked: 0,
    transitionsSampled: 0,
    byState,
    byScope,
  };
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
    const view = parseView(new URL(request.url).searchParams.get('view'));
    const stateStoreProbe = await probeHealthStateStoreAvailability();
    const runtime = getHealthStateStoreRuntimeStats();

    return new Response(
      JSON.stringify({
        ok: true,
        view,
        authMethod: auth.method,
        conversion: {
          available: false,
          reason: 'CONSENT_SCOPE_MISMATCH',
        },
        statisticsSource: {
          status: 'NOT_CHECKED',
          reason: 'CONVERSION_ASSESSMENT_UNAVAILABLE',
        },
        stateStore: {
          available: stateStoreProbe.value.available,
          dataSource: stateStoreProbe.dataSource,
          degraded: stateStoreProbe.degraded,
          legacyPayloadRead: stateStoreProbe.value.legacyPayloadRead,
        },
        runtime,
        legacyStateDataSuppressed: true,
        summary: emptySummary(),
        states: view === 'states' ? [] : undefined,
        transitions: view === 'transitions' ? [] : undefined,
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
