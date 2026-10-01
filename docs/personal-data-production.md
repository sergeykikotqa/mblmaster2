# Personal-data production map — pending launch

## Phone lead

Browser (phone + separate required consent) -> API -> contract-v2 Redis ->
authenticated admin inbox/detail -> expiry. Record: opaque leadId, normalized
phone, timestamps, hashed idempotency/fingerprint, status/retry metadata,
server-timestamped consent and allowlisted service/pageSlug/placement. No name,
message, raw IP/User-Agent, arbitrary referrer, URL query or attribution object.
Raw IP is transient for rate-limit/SmartCaptcha; rate-limit identity is hashed.

## Notification

Separate PII-free envelope; opaque leadId is retained for HMAC/dedupe/fencing,
not as an analytics user identifier. External recipient gets no raw LeadRecord
or phone. Telegram signals a new lead; owner reads phone through admin auth.

## Analytics

Yandex Metrika only after separate analytics consent. Webvisor, automatic link
tracking and clickmap are disabled. No form content, phone, UserID/CRM upload,
query strings or leadId as user identity. GA is absent. Analytics deny does not
block lead submission. The application does not retain lead attribution.

## Logs and retention

Operational logs: opaque IDs/status/error codes/latency, not lead PII or raw
webhook response bodies. Forensic log defaults off in production; enabled mode
redacts phone aliases semantically. CONTACT_LEAD_RECORD_TTL_SEC=2592000 is a
business policy, not a claim of a statutory period. DLQ/fences remain bounded.

## Backup/recovery

Encrypted contract-v2 backups. Retention remains 24 hourly / 7 daily / 4 weekly.
Production storage must be in the approved Russian perimeter; actual provider
and location are not yet supplied. Cross-version rollback/recovery/restore are
blocked; first production starts with an empty v2 Redis volume. Local isolated
drills do not constitute proof of a real VPS disaster-recovery drill.

## Required inputs before production

- Legal operator identity/status, address and requisite details.
- Operator contact details and requests-handling process.
- Actual Russian VPS and Russian backup storage/provider locations.
- Production start date and Roskomnadzor notification applicability/data/status.
- Approved final legal disclosure and consent text.

No operator/provider identity is invented here. No filing or production
readiness is asserted.
