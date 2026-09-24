# syntax=docker/dockerfile:1.7

# Node 22 is the production contract (.nvmrc / package.json). Keep the exact
# patch and Alpine release pinned so a Git revision always builds on a known
# runtime rather than a moving lts/latest tag.
FROM node:22.22.0-alpine3.23 AS base
WORKDIR /app

FROM base AS build-dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund

FROM base AS build
ARG PUBLIC_SITE_URL
ARG PUBLIC_PRIMARY_SEO_CITY_ID
ARG PUBLIC_ENABLE_LEAD_TRACKING
ARG PUBLIC_YANDEX_METRIKA_ID
ARG PUBLIC_YANDEX_VERIFICATION
ARG PUBLIC_GA4_ID
ARG PUBLIC_LEAD_FORM_ABANDON_MS
ARG PUBLIC_ENABLE_RUM_WEB_VITALS
ARG PUBLIC_RUM_LCP_ALERT_THRESHOLD_MS
ARG PUBLIC_BUSINESS_PHONE
ARG PUBLIC_BUSINESS_EMAIL
ARG PUBLIC_BUSINESS_ADDRESS_LOCALITY
ARG PUBLIC_BUSINESS_ADDRESS_DISTRICT
ARG PUBLIC_BUSINESS_STREET_ADDRESS
ARG PUBLIC_BUSINESS_REGION
ARG PUBLIC_BUSINESS_POSTAL_CODE
ARG PUBLIC_BUSINESS_OPENING_HOURS
ARG PUBLIC_BUSINESS_OPENING_HOURS_TEXT
ARG PUBLIC_BUSINESS_IMAGE
ARG PUBLIC_BUSINESS_SAME_AS
ARG PUBLIC_TELEGRAM_URL
ARG PUBLIC_BUSINESS_YANDEX_MAPS_URL
ARG PUBLIC_BUSINESS_GOOGLE_MAPS_URL
ARG PUBLIC_BUSINESS_PRICE_RANGE
ARG PUBLIC_BUSINESS_LAT
ARG PUBLIC_BUSINESS_LON
ARG PUBLIC_BUSINESS_LEGAL_NAME
ARG PUBLIC_BUSINESS_TAX_ID
ARG PUBLIC_BUSINESS_REGISTRATION_ID
ARG PUBLIC_BUSINESS_CHECKING_ACCOUNT
ARG PUBLIC_BUSINESS_BIC
ARG PUBLIC_BUSINESS_BANK_NAME
ARG PUBLIC_BUSINESS_REGISTERED_ADDRESS
ENV PUBLIC_SITE_URL=${PUBLIC_SITE_URL} \
    PUBLIC_PRIMARY_SEO_CITY_ID=${PUBLIC_PRIMARY_SEO_CITY_ID} \
    PUBLIC_ENABLE_LEAD_TRACKING=${PUBLIC_ENABLE_LEAD_TRACKING} \
    PUBLIC_YANDEX_METRIKA_ID=${PUBLIC_YANDEX_METRIKA_ID} \
    PUBLIC_YANDEX_VERIFICATION=${PUBLIC_YANDEX_VERIFICATION} \
    PUBLIC_GA4_ID=${PUBLIC_GA4_ID} \
    PUBLIC_LEAD_FORM_ABANDON_MS=${PUBLIC_LEAD_FORM_ABANDON_MS} \
    PUBLIC_ENABLE_RUM_WEB_VITALS=${PUBLIC_ENABLE_RUM_WEB_VITALS} \
    PUBLIC_RUM_LCP_ALERT_THRESHOLD_MS=${PUBLIC_RUM_LCP_ALERT_THRESHOLD_MS} \
    PUBLIC_BUSINESS_PHONE=${PUBLIC_BUSINESS_PHONE} \
    PUBLIC_BUSINESS_EMAIL=${PUBLIC_BUSINESS_EMAIL} \
    PUBLIC_BUSINESS_ADDRESS_LOCALITY=${PUBLIC_BUSINESS_ADDRESS_LOCALITY} \
    PUBLIC_BUSINESS_ADDRESS_DISTRICT=${PUBLIC_BUSINESS_ADDRESS_DISTRICT} \
    PUBLIC_BUSINESS_STREET_ADDRESS=${PUBLIC_BUSINESS_STREET_ADDRESS} \
    PUBLIC_BUSINESS_REGION=${PUBLIC_BUSINESS_REGION} \
    PUBLIC_BUSINESS_POSTAL_CODE=${PUBLIC_BUSINESS_POSTAL_CODE} \
    PUBLIC_BUSINESS_OPENING_HOURS=${PUBLIC_BUSINESS_OPENING_HOURS} \
    PUBLIC_BUSINESS_OPENING_HOURS_TEXT=${PUBLIC_BUSINESS_OPENING_HOURS_TEXT} \
    PUBLIC_BUSINESS_IMAGE=${PUBLIC_BUSINESS_IMAGE} \
    PUBLIC_BUSINESS_SAME_AS=${PUBLIC_BUSINESS_SAME_AS} \
    PUBLIC_TELEGRAM_URL=${PUBLIC_TELEGRAM_URL} \
    PUBLIC_BUSINESS_YANDEX_MAPS_URL=${PUBLIC_BUSINESS_YANDEX_MAPS_URL} \
    PUBLIC_BUSINESS_GOOGLE_MAPS_URL=${PUBLIC_BUSINESS_GOOGLE_MAPS_URL} \
    PUBLIC_BUSINESS_PRICE_RANGE=${PUBLIC_BUSINESS_PRICE_RANGE} \
    PUBLIC_BUSINESS_LAT=${PUBLIC_BUSINESS_LAT} \
    PUBLIC_BUSINESS_LON=${PUBLIC_BUSINESS_LON} \
    PUBLIC_BUSINESS_LEGAL_NAME=${PUBLIC_BUSINESS_LEGAL_NAME} \
    PUBLIC_BUSINESS_TAX_ID=${PUBLIC_BUSINESS_TAX_ID} \
    PUBLIC_BUSINESS_REGISTRATION_ID=${PUBLIC_BUSINESS_REGISTRATION_ID} \
    PUBLIC_BUSINESS_CHECKING_ACCOUNT=${PUBLIC_BUSINESS_CHECKING_ACCOUNT} \
    PUBLIC_BUSINESS_BIC=${PUBLIC_BUSINESS_BIC} \
    PUBLIC_BUSINESS_BANK_NAME=${PUBLIC_BUSINESS_BANK_NAME} \
    PUBLIC_BUSINESS_REGISTERED_ADDRESS=${PUBLIC_BUSINESS_REGISTERED_ADDRESS}
COPY --from=build-dependencies /app/node_modules ./node_modules
COPY . .
RUN node scripts/check-public-build-env.mjs && npm run build

# Install only runtime dependencies. The compiler, test stack and other
# devDependencies never enter the production Node image.
FROM base AS production-dependencies
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --omit=optional --no-audit --no-fund

# Backup tooling is versioned with the application release but runs only as a
# one-shot job. Restic encrypts before upload; redis-cli obtains a consistent
# RDB over the private Redis protocol, so the production data volume is never
# mounted in this image. The Restic multi-platform digest is pinned.
FROM restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 AS restic-tools
FROM redis:7.4.7-alpine3.21 AS redis-tools

FROM base AS backup-runtime
ARG MBL_BUILD_REVISION=unknown
ARG MBL_PUBLIC_BUILD_CONFIG_SHA256=unknown
LABEL org.opencontainers.image.title="MBL encrypted Redis backup tool" \
      org.opencontainers.image.revision="${MBL_BUILD_REVISION}" \
      org.mbl.public-build-config-sha256="${MBL_PUBLIC_BUILD_CONFIG_SHA256}" \
      org.opencontainers.image.version="restic-0.19.1"
ENV NODE_ENV=production \
    RESTIC_CACHE_DIR=/tmp/restic-cache
COPY --from=restic-tools /usr/bin/restic /usr/local/bin/restic
COPY --from=redis-tools /usr/local/bin/redis-cli /usr/local/bin/redis-server /usr/local/bin/
RUN ln -s redis-server /usr/local/bin/redis-check-rdb
COPY --chown=node:node scripts/redis-backup.mjs ./scripts/redis-backup.mjs
USER node
ENTRYPOINT ["node", "scripts/redis-backup.mjs"]
CMD ["backup"]

FROM base AS web-runtime
ARG MBL_BUILD_REVISION=unknown
ARG MBL_PUBLIC_BUILD_CONFIG_SHA256=unknown
LABEL org.opencontainers.image.title="MBL Astro Node runtime" \
      org.opencontainers.image.revision="${MBL_BUILD_REVISION}" \
      org.mbl.public-build-config-sha256="${MBL_PUBLIC_BUILD_CONFIG_SHA256}"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node \
    /app/scripts/start-node.mjs \
    /app/scripts/worker-trigger.mjs \
    ./scripts/
USER node
EXPOSE 4321
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4321/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "scripts/start-node.mjs"]

# Nginx receives the same immutable build output as the Node image and serves
# only static assets directly. HTML and application routes still go to Astro.
FROM nginx:1.30.4-alpine3.24 AS nginx-runtime
ARG MBL_BUILD_REVISION=unknown
ARG MBL_PUBLIC_BUILD_CONFIG_SHA256=unknown
LABEL org.opencontainers.image.title="MBL Nginx edge" \
      org.opencontainers.image.revision="${MBL_BUILD_REVISION}" \
      org.mbl.public-build-config-sha256="${MBL_PUBLIC_BUILD_CONFIG_SHA256}"
RUN rm -f /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /app/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=build --chown=nginx:nginx /app/nginx/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build --chown=nginx:nginx /app/nginx/generated /etc/nginx/generated
COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/health/live"]
ENTRYPOINT ["nginx", "-g", "daemon off;"]
