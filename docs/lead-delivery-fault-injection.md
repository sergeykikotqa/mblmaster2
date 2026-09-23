# Lead delivery fault-injection contract

## Reproducible local gate

Run `npm run check:lead-faults` from a clean checkout with Docker Desktop running.
The gate creates a uniquely named Compose project, a dedicated Redis volume and
a loopback-only receiver. It uses synthetic leads and removes its containers,
network, volume and temporary DLQ audit log on completion.

The gate exercises the production worker, Redis store and webhook sender without
adding test branches to those modules:

- receiver acceptance followed by a lost acknowledgement;
- delivery-claim loss after receiver acceptance and before the Redis commit;
- retry exhaustion, DLQ insertion, operator replay and successful recovery.
- a blocked POST held longer than the base processing-lock TTL while a competing
  worker attempts to process the same lead.

The expected transport guarantee is **at least once**. A delivery fence prevents
additional sends after a successful Redis commit, but it cannot prevent a repeat
when the receiver accepted a request and the acknowledgement or worker process was
lost before that commit.

While the worker process and event loop remain healthy, it renews the processing
lock during a blocked POST, so a competing worker cannot enter delivery. The
delivery claim itself is not renewed. If that shorter claim expires, the first
worker must not commit a false delivered state; the queued lead is retried with the
same webhook identifier.

## Required downstream receiver contract

The component behind `CONTACT_WEBHOOK_URL` must:

1. accept HTTPS only and reject redirects;
2. read the unmodified raw request body;
3. require `X-Webhook-Id`, `X-Webhook-Timestamp` and `X-Hub-Signature-256`;
4. reject timestamps with more than 300 seconds of skew;
5. verify `sha256=HMAC_SHA256(secret, timestamp + "." + webhookId + "." + rawBody)` using a constant-time comparison;
6. atomically reserve `X-Webhook-Id` in durable storage before executing the business action;
7. store a payload fingerprint with the identifier, return the same successful outcome for an identical replay, and reject conflicting content for the same identifier;
8. keep the deduplication record for at least the maximum configured lead-record and DLQ retention period;
9. return 2xx only after the identifier and business outcome are durably committed;
10. avoid logging the raw lead payload, secret or HMAC value.

An acceptance test for the real receiver must send two valid signed requests with
the same `X-Webhook-Id` and verify two HTTP observations but exactly one durable
business record/action. It must also reject an invalid signature, stale timestamp,
missing identifier and a same-identifier request with conflicting content.

## External verification status

The repository contains the sender and illustrative HMAC examples, but not the
implementation deployed behind `CONTACT_WEBHOOK_URL`. Therefore receiver-side
signature enforcement, durable atomic deduplication and TTL policy are
`NOT_VERIFIED_EXTERNAL_RECEIVER`.

The existing `examples/hmac_verification_example.js` and
`docs/hmac_verification_example.js` are illustrative only. They do not implement
the complete timestamp, raw-body and durable deduplication contract above and must
not be used as production receiver evidence.

## Remaining deterministic crash windows

The following scenarios require a reviewed process-level coordinator and remain
blocked rather than being approximated with a timer-based kill:

- stop the worker after claim acquisition but before the proxy forwards the POST;
- stop the worker after the receiver returns 2xx but before Redis commit;
- suspend the worker long enough for the processing lock and delivery claim to
  expire, then start a second worker while the first request is still blocked.

A future test-only preload can expose `before_forward` and `response_received`
barriers to a parent coordinator. The parent should kill only its own worker child,
inspect Redis, start a second worker, and compare HTTP attempts with idempotent
business acceptances. No test flags or crash branches are required in production
code.
