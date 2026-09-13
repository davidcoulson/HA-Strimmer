# Multi-arch Node base; the Supervisor builds the right arch from config.yaml.
FROM node:20-alpine

WORKDIR /app

# Install production deps first (cached layer).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App code. This list is explicit, so a new module that is not added here builds fine and then
# dies at startup with ERR_MODULE_NOT_FOUND — add every .mjs the proxy imports.
COPY ha_ws_trim_proxy.mjs lovelace_extract.mjs stats.mjs history.mjs route.mjs panel.html ./

# Supervisor provides SUPERVISOR_TOKEN and mounts user config at /data/options.json.
CMD ["node", "ha_ws_trim_proxy.mjs"]
