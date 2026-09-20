import { isSmartCaptchaReady, isSmartCaptchaRequired, resolveSmartCaptchaClientKey } from '~/server/leads/smartcaptcha';

export const prerender = false;

const JSON_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Content-Type': 'application/json',
};

export function GET() {
  const required = isSmartCaptchaRequired();
  const ready = isSmartCaptchaReady();

  return new Response(
    JSON.stringify({
      provider: 'smartcaptcha',
      required,
      ready,
      clientKey: required && ready ? resolveSmartCaptchaClientKey() : '',
    }),
    {
      status: required && !ready ? 503 : 200,
      headers: JSON_HEADERS,
    }
  );
}
