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
# Alpine because that is what the whole app ecosystem uses: both the official Home Assistant
# bases and the community hassio-addons bases are Alpine. Nothing here compiles, so a Debian
# base would buy nothing and cost image size — every dependency is pure JavaScript with no
# native bindings, and there is no ABI to rebuild against when the runtime moves.
#
# node:26-alpine is a DELIBERATE choice to run the Current line slightly ahead of its LTS date,
# not an oversight. The schedule:
#
#     v24   LTS 2025-10-28   maintenance 2026-10-20   EOL 2028-04-30
#     v26   LTS 2026-10-28   maintenance 2027-10-20   EOL 2029-04-30
#
# As of this commit 26 is still "Current" — the line where breaking changes land — and reaches
# Active LTS on 2026-10-28, almost exactly when 24 drops into maintenance. Taking it now buys
# the longer support window a few weeks early, and the cost is those few weeks on Current.
# The test suite runs on 22, 24 and 26, so a regression specific to the new line is caught in
# CI rather than on a wall panel; 24 stays in that matrix as the fallback if this bites.
ARG BUILD_FROM=node:26-alpine
FROM ${BUILD_FROM}

# Points the GHCR package at this repo and its README.
LABEL org.opencontainers.image.source="https://github.com/davidcoulson/HA-Strimmer" \
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
COPY ha_ws_trim_proxy.mjs lovelace_extract.mjs stats.mjs history.mjs route.mjs mdns.mjs mqtt_sensors.mjs http_log.mjs config_store.mjs resource_invariants.mjs pause.mjs panel.html ./

# The stats endpoint is the honest liveness probe: it is served by the same process that
# proxies, and it answers even while Home Assistant is still down (the proxy retries the
# control connection rather than exiting). So a failing probe means THIS container is broken,
# not that HA is restarting — which is exactly the distinction a healthcheck should draw.
#
# busybox wget, because the image has no curl and adding one for a healthcheck is not worth a
# layer. Shell form so the port is resolved at runtime rather than baked in.
#
# The port comes from a file the proxy writes after its stats server actually binds, NOT from a
# default written here. A default here is a SECOND COPY of the one in the source, and as an add-on
# it is the only copy that ever runs: Supervisor passes config in /data/options.json, so
# STATS_PORT is absent from the environment and the shell default is always what gets probed.
# When the port moved 8100 -> 9122 that copy stayed behind, the probe hit a closed port, and the
# watchdog restarted a perfectly healthy container every ~85 seconds — while Supervisor, never
# seeing `started`, left Ingress showing "The app is starting, this can take some time".
# Reading the bound port means the probe cannot disagree with the server about where it is.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD p="$(cat /tmp/stats-port 2>/dev/null)"; [ -n "$p" ] && wget -qO- "http://127.0.0.1:$p/stats.json" >/dev/null 2>&1 || exit 1

# Cache compiled bytecode on the persistent volume, so a restart does not recompile the whole
# app from source. It has to be set here rather than called in the entrypoint: ha_ws_trim_proxy.mjs
# is an ES module, so its static imports are all evaluated before its first statement — a
# module.enableCompileCache() call in the source would run after everything it could cache and
# write nothing at all. This variable is read before any of it is compiled.
#
# /data is the add-on's persistent volume; Node's own default sits under /tmp, which the container
# throws away on the restart this exists to speed up. If the path is unwritable (a standalone run
# with no volume mounted) Node ignores it and the app starts normally, just without the cache.
ENV NODE_COMPILE_CACHE=/data/compile-cache

# Deliberately runs as root, like every other HA add-on: Supervisor mounts /data as root, and
# dropping privileges here would break history persistence for add-on users to buy very little
# for standalone ones. Standalone users who want it can pass `--user` and mount /data
# accordingly; see the compose example in the README.
#
# Supervisor provides SUPERVISOR_TOKEN and mounts user config at /data/options.json.
CMD ["node", "ha_ws_trim_proxy.mjs"]
