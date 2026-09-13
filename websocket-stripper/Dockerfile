# Multi-arch Node base; the Supervisor builds the right arch from config.yaml.
#
# This is a plain Node image, not an HA base image — no bashio, no s6. That is deliberate:
# the same image runs as a Supervisor add-on AND as an ordinary container for people running
# Home Assistant Container or Core, who cannot install add-ons at all. The proxy detects which
# it is by the presence of SUPERVISOR_TOKEN and reads its config from /data/options.json or
# from environment variables accordingly.
# ARG BUILD_FROM is the Home Assistant add-on convention: Supervisor can inject a per-arch base
# from build.yaml. The DEFAULT is what matters here though, because the same Dockerfile also
# builds the plain container published to GHCR, where nothing injects anything.
#
# node:24-alpine, for two reasons. Node 20 reached end-of-life on 2026-03-24 — no security
# patches — and httpxy requires Node >= 22. Alpine because that is what the whole add-on
# ecosystem uses: both the official Home Assistant bases and the community hassio-addons bases
# are Alpine, and Node-RED (the most-installed Node add-on) runs Alpine with Node 24. Nothing
# here compiles, so a Debian base would buy nothing and cost image size — every dependency is
# pure JavaScript with no native bindings.
ARG BUILD_FROM=node:24-alpine
FROM ${BUILD_FROM}

# Points the GHCR package at this repo and its README.
LABEL org.opencontainers.image.source="https://github.com/davidcoulson/HA-Websocket-Stripper" \
      org.opencontainers.image.description="Serves your real Home Assistant dashboards but trims the entity websocket to only what each dashboard uses." \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Install production deps first (cached layer).
#
# `npm ci` against the committed lockfile, NOT `npm install`. With the lockfile absent from the
# image, `npm install` re-resolved every `^` range at build time — so the tree in the published
# image depended on the day it was built, and the lockfile we carefully keep in git described
# nothing that ever shipped. Two builds of the same commit could differ. `ci` also fails loudly
# when the lock and the manifest disagree, which is the check that catches a hand-edited
# dependency before it reaches a user.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# App code. This list is explicit, so a new module that is not added here builds fine and then
# dies at startup with ERR_MODULE_NOT_FOUND — add every .mjs the proxy imports.
COPY ha_ws_trim_proxy.mjs lovelace_extract.mjs stats.mjs history.mjs route.mjs mdns.mjs mqtt_sensors.mjs http_log.mjs panel.html ./

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
