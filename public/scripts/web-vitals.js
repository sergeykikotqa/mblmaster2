(() => {
  if (typeof window === 'undefined') return;

  const loadWebVitals = async () => {
    try {
      const { onCLS, onINP, onLCP } = await import('web-vitals');

      const config = window.__LEAD_TRACKING_CONFIG || {};
      const trackEndpoint = typeof config.trackEndpoint === 'string' ? config.trackEndpoint : '/api/track';
      const lcpAlertThresholdMs =
        Number.isFinite(Number(config.rumLcpAlertThresholdMs)) && Number(config.rumLcpAlertThresholdMs) > 0
          ? Number(config.rumLcpAlertThresholdMs)
          : 2500;

      const sendEvent = (eventName, payload) => {
        const body = JSON.stringify({
          event: eventName,
          payload,
          page: window.location.pathname + window.location.search,
          sentAt: new Date().toISOString(),
        });

        let sentViaBeacon = false;
        if (typeof navigator.sendBeacon === 'function') {
          try {
            const data = typeof Blob === 'function' ? new Blob([body], { type: 'application/json' }) : body;
            sentViaBeacon = navigator.sendBeacon(trackEndpoint, data);
          } catch {
            sentViaBeacon = false;
          }
        }

        if (!sentViaBeacon && typeof fetch === 'function') {
          fetch(trackEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
          }).catch(() => {});
        }
      };

      const emitMetric = (metricName, value, id, rating) => {
        sendEvent('web_vital', {
          metric_name: metricName,
          value: metricName === 'CLS' ? Number(value.toFixed(4)) : Math.round(value),
          rating: String(rating || ''),
          metric_id: String(id || ''),
          threshold_ms: metricName === 'LCP' ? lcpAlertThresholdMs : undefined,
        });
      };

      onLCP((metric) => emitMetric('LCP', metric.value, metric.id, metric.rating));
      onCLS((metric) => emitMetric('CLS', metric.value, metric.id, metric.rating));
      onINP((metric) => {
        const inpThreshold = 200;

        emitMetric('INP', metric.value, metric.id, metric.rating);

        if (metric.value > inpThreshold) {
          fetch(trackEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
            body: JSON.stringify({
              event: 'rum_alert',
              metric: 'INP',
              value: Math.round(metric.value),
              threshold: inpThreshold,
              page: window.location.pathname,
              rating: metric.rating,
            }),
          }).catch(() => {});
        }
      });
    } catch {
      // ignore web-vitals load failures
    }
  };

  loadWebVitals();
})();
