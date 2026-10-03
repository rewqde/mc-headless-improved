# mc-headless-improved — headless Minecraft (Fabric) + MineScript + dashboard.
#
# Improvements vs the original Dockerfile:
#  - pinned base image (reproducible; override with --build-arg BASE_IMAGE=...)
#  - pinned Node 20.x via Nodesource, python3 from the distro (no deadsnakes
#    PPA needed on noble), tini for signal handling, curl healthcheck
#  - reproducible Node install: copies package.json AND package-lock.json,
#    uses `npm ci --omit=dev`
#  - HEALTHCHECK against /api/health so orchestrators see real readiness
#  - no baked secrets; documented volumes; labels
ARG BASE_IMAGE=3arthqu4ke/headlessmc:2.10.0
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# tini (PID 1 reaping + signal forwarding), X + GL, curl for healthchecks.
# NOTE: gnupg is required — the Nodesource setup script uses it to keyring-sign
# the Node repo. Without it the next layer fails.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg tini \
      xvfb mesa-utils libgl1 libgl1-mesa-dri \
      python3 \
 && rm -rf /var/lib/apt/lists/*

# Node 20.x for the dashboard sidecar.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && node --version && npm --version

# Single source of truth for paths/versions (override at `docker run -e`).
ENV HMC_HOME=/data \
    MC_GDIR=/data/.minecraft \
    MC_LOGS=/data/logs \
    DASH_DATA=/app/data \
    MC_XMX=1280M \
    MC_VERSION=1.21.11 \
    MC_LOADER=fabric \
    HMC_LOGIN_TIMEOUT=600 \
    PORT=3000

RUN mkdir -p /data/logs /app/data /app/scripts

WORKDIR /app
COPY package.json package-lock.json* ./
# package-lock may not exist on first checkout — fall back to npm install then.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm cache clean --force
COPY server.js ./
COPY public/ ./public/
COPY scripts/ ./scripts/

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

VOLUME ["/data", "/app/data"]
EXPOSE 3000

LABEL org.opencontainers.image.title="mc-headless-improved" \
      org.opencontainers.image.description="HeadlessMC + dashboard + MineScript (hardened easy-setup rewrite)" \
      org.opencontainers.image.version="2.0.0"

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/bin/bash", "/entrypoint.sh"]
