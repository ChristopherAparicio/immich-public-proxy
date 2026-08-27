# syntax=docker/dockerfile:1.7

# Node 24 LTS / Alpine 3.24, pinned to a multi-architecture manifest digest.
# Renovation is explicit and must pass the complete CI and ZIP regression suite.
ARG NODE_IMAGE=node:24.19.0-alpine3.24@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

FROM ${NODE_IMAGE} AS build
USER node
WORKDIR /build/app
COPY --chown=node:node app/package.json app/package-lock.json ./
RUN npm ci --include=dev --ignore-scripts
COPY --chown=node:node app/ ./
RUN npm run build \
 && npm test \
 && npm audit --omit=dev --audit-level=high

FROM ${NODE_IMAGE} AS production-dependencies
USER node
WORKDIR /build/app
COPY --chown=node:node app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ARG PACKAGE_VERSION=development
ARG VCS_REF=unknown
ARG SOURCE_URL=https://github.com/ChristopherAparicio/immich-public-proxy

LABEL org.opencontainers.image.title="Immich Public Proxy — immich-share fork" \
      org.opencontainers.image.description="Security-focused Immich share proxy with bounded resumable ZIP downloads" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${PACKAGE_VERSION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

ENV APP_VERSION=${PACKAGE_VERSION} \
    NODE_ENV=production \
    IPP_PORT=3000

WORKDIR /app
COPY --from=production-dependencies --chown=node:node /build/app/node_modules ./node_modules
COPY --from=build --chown=node:node /build/app/dist ./dist
COPY --from=build --chown=node:node /build/app/public ./public
COPY --from=build --chown=node:node /build/app/config.json ./config.json
COPY --from=build --chown=node:node /build/app/package.json ./package.json

# The runtime starts Node directly and does not need package managers.
USER root
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.IPP_PORT||3000)+'/share/healthcheck').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
