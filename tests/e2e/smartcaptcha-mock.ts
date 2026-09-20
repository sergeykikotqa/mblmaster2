import type { Page } from '@playwright/test';

const CLIENT_KEY = 'ysc1_local_integration_mock_key';

const MOCK_WIDGET_SCRIPT = `
(() => {
  let token = '';
  let resetCount = 0;
  let nextId = 1;
  const callbacks = new Map();
  const listeners = new Map();

  window.__smartCaptchaMock = {
    issue(value = 'mock-valid-token') {
      token = value;
      callbacks.forEach((callback) => callback(token));
    },
    expire() {
      token = '';
      (listeners.get('token-expired') || []).forEach((callback) => callback());
    },
    networkError() {
      token = '';
      (listeners.get('network-error') || []).forEach((callback) => callback());
    },
    get resetCount() { return resetCount; },
  };

  window.smartCaptcha = {
    render(container, params) {
      const id = nextId++;
      callbacks.set(id, params.callback);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Я не робот';
      button.setAttribute('aria-label', 'Пройти проверку SmartCaptcha');
      button.addEventListener('click', () => window.__smartCaptchaMock.issue());
      container.appendChild(button);
      return id;
    },
    getResponse() { return token; },
    reset() { token = ''; resetCount += 1; },
    subscribe(_id, event, callback) {
      const current = listeners.get(event) || [];
      current.push(callback);
      listeners.set(event, current);
      return () => listeners.set(event, current.filter((item) => item !== callback));
    },
  };

  if (typeof window.__mblSmartCaptchaLoaded === 'function') {
    window.__mblSmartCaptchaLoaded();
  }
})();
`;

export async function mockSmartCaptcha(page: Page, options: { scriptUnavailable?: boolean } = {}) {
  await page.route('**/api/captcha/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'smartcaptcha',
        required: true,
        ready: true,
        clientKey: CLIENT_KEY,
      }),
    });
  });

  await page.route('https://smartcaptcha.cloud.yandex.ru/captcha.js**', async (route) => {
    if (options.scriptUnavailable) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: MOCK_WIDGET_SCRIPT,
    });
  });
}
