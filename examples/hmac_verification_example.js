/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Simple Express example showing how to verify `X-Hub-Signature-256` HMAC
 * sent from the website webhook (sha256).
 *
 * Usage:
 * 1. Install dependencies: `npm install express`
 * 2. Set `WEBHOOK_SECRET` env var to the same secret used by the website
 * 3. Run: `node examples/hmac_verification_example.js`
 */

const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '200kb' }));

function computeSignature(secret, payloadString) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

function verifySignature(req, secret) {
  const header = req.get('x-hub-signature-256') || '';
  const payloadRaw = JSON.stringify(req.body || {});
  const expected = computeSignature(secret, payloadRaw);

  try {
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

app.post('/webhook', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET || 'replace_me';

  if (!verifySignature(req, secret)) {
    console.warn('Rejected webhook: invalid signature');
    return res.status(401).send('invalid signature');
  }

  // signature ok — handle payload
  console.log('Verified payload:', req.body);

  // TODO: save to DB, send notification, enqueue job, etc.

  res.status(200).send('ok');
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Webhook receiver listening on ${port}`));
