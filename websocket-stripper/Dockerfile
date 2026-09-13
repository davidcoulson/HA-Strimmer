# Multi-arch Node base; the Supervisor builds the right arch from config.yaml.
#
# This is a plain Node image, not an HA base image — no bashio, no s6. That is deliberate:
# the same image runs as a Supervisor add-on AND as an ordinary container for people running
# Home Assistant Container or Core, who cannot install add-ons at all. The proxy detects which
# it is by the presence of SUPERVISOR_TOKEN and reads its config from /data/options.json or
# from environment variables accordingly.
FROM node:20-alpine

# Points the GHCR package at this repo and its README.
LABEL org.opencontainers.image.source="https://github.com/davidcoulson/HA-Websocket-Stripper" \
      org.opencontainers.image.description="Serves your real Home Assistant dashboards but trims the entity websocket to only what each dashboard uses." \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Install production deps first (cached layer).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App code. This list is explicit, so a new module that is not added here builds fine and then
# dies at startup with ERR_MODULE_NOT_FOUND — add every .mjs the proxy imports.
COPY ha_ws_trim_proxy.mjs lovelace_extract.mjs stats.mjs history.mjs route.mjs panel.html ./

# The stats endpoint is the honest liveness probe: it is served by the same process that
# proxies, and it answers even while Home Assistant is still down (the proxy retries the
# control connection rather than exiting). So a failing probe means THIS container is broken,
# not that HA is restarting — which is exactly the distinction a healthcheck should draw.
#
# busybox wget, because the image has no curl and adding one for a healthcheck is not worth a
# layer. Shell form so STATS_PORT is expanded at runtime rather than baked in.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${STATS_PORT:-8100}/stats.json" >/dev/null 2>&1 || exit 1

# Deliberately runs as root, like every other HA add-on: Supervisor mounts /data as root, and
# dropping privileges here would break history persistence for add-on users to buy very little
# for standalone ones. Standalone users who want it can pass `--user` and mount /data
# accordingly; see the compose example in the README.
#
# Supervisor provides SUPERVISOR_TOKEN and mounts user config at /data/options.json.
CMD ["node", "ha_ws_trim_proxy.mjs"]
