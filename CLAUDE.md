# HA WebSocket Stripper — project context

## What this is / why it exists

Home Assistant Lovelace dashboards on a large instance (here ~3,600 entities) load
slowly because, at startup, the frontend pulls **every** entity over the websocket
(`get_states` + a full `subscribe_entities`) plus the entity/device/area registries, on
top of the frontend JS bundles and every HACS custom-card module.

For wall-panel / kiosk dashboards (a fridge screen, etc.) that only show a handful of
entities, that firehose is pure waste. This project makes those dashboards load fast
**without changing how they look**, by serving the *real* HA frontend through a reverse
proxy that trims the entity websocket to just the entities each dashboard uses.

### Why this approach (history — don't re-litigate)

We first tried a lighter path: a long-poll backend + a hand-written **approximated**
renderer that redrew cards in plain HTML. It loaded fast but the owner wants
**pixel-perfect** fidelity, and re-implementing Mushroom/button-card/clock-weather/etc. is
a losing battle. So we pivoted to: **run HA's real frontend, just strip the websocket.**
That approximation approach was abandoned; this repo is the chosen direction.

A pure "reuse only the card-rendering JS" idea isn't viable: HA's core cards live inside
the compiled frontend bundle and can't be loaded standalone. The realistic way to get the
real cards + a trimmed subscription is this reverse proxy.

## Mechanism

HTTP: everything proxies straight to HA untouched (frontend bundles, `/auth/*`,
registries, `lovelace/config`, `/hacsfiles/*`, camera proxy, …).

WebSocket (`/api/websocket`): the proxy terminates the browser socket, opens its own
socket to HA, and relays both ways, modifying only:
- `subscribe_entities` with no filter → inject `entity_ids = <allowlist>` so HA streams
  only those entities (trims at the source);
- the `get_states` **result** → filtered to the allowlist.

Everything else (auth handshake, registry calls, config, events) passes through, so the
real frontend renders your real cards — just without the all-entities firehose. The
browser relays its own user token in the ws auth; the proxy doesn't touch auth.

**Only `/api/websocket` is intercepted.** Every *other* websocket upgrade is proxied
straight through to HA — notably `/api/webrtc/ws` (go2rtc / WebRTC + MSE camera-stream
signaling) and Assist-pipeline sockets. The original code `socket.destroy()`'d all
non-`/api/websocket` upgrades, which broke camera streams with ws close code 1006; the
upgrade handler now forwards them via `proxy.ws()`.

## Allowlist computation

Union, across all configured dashboards, of:
1. `extractEntities()` (`lovelace_extract.mjs`) — walks the card tree for entities in the
   standard keys (`entity`, `entities`, `entity_id`, `camera_image`, …) across **all
   views**, and expands `auto-entities` filter cards against live states + registries.
2. every **real** entity id that appears anywhere in the dashboard config text — catches
   ids referenced inside `button-card` / `mushroom-template` / `decluttering-card`
   templates that a structural walk can't parse.

Then `+ always_forward`, then `- never_forward` (never wins), then **group members**
(`expandGroupMembers`, transitive via `attributes.entity_id`). Over-inclusion is harmless
(still tiny vs the instance); under-inclusion makes a card show "unavailable".

### auto-entities filter resolution (`condTests` / `toMatcher`)

`toMatcher()` is a deliberate port of auto-entities' own `src/match.ts` — keep it that way
rather than inventing semantics. A `/regex/` is used **unanchored** (the author supplies
`^`/`$`); a `*` glob is anchored; otherwise exact equality; regex is OR'd with exact match.
It applies to **every** filter key, which is what upstream does — that was issue #10.

Supported keys: `entity_id`, `domain`, `area`, `label`, `device`, `integration`, `name`
(vs `friendly_name`), `group`, `template`, `state`/`attributes` (volatile → over-included).
Values may also arrive in HA's selector object form `{ custom: …, active_choice: 'custom' }`;
`coerceVal` uses `active_choice` to pick the real key. Still unsupported: `not`/`and`/`or`,
`floor`, `device_manufacturer`, `device_model`, `last_changed`.

`filter: template:` is rendered over the control ws (`collectTemplates` → `render_template`
→ real ids scraped from the output). Note `render_template` is a **subscription**: HA answers
`result: null` then pushes events, so `renderTemplate()` takes the first event and
unsubscribes. Don't route it through `rpc()`, which resolves on `result`.

## Files

- `websocket-stripper/ha_ws_trim_proxy.mjs` — the proxy (HTTP passthrough + ws intercept + allowlist precompute).
- `websocket-stripper/lovelace_extract.mjs` — the card-tree entity extractor.
- `websocket-stripper/config.yaml` / `Dockerfile` / `package.json` — HA app packaging.
- `websocket-stripper/DOCS.md` — app Documentation tab (option reference).
- `repository.yaml` — lets HA add this GitHub URL as an app repository.
- `README.md` — install + dev-run.

## Run modes (auto-detected)

- **App** (`SUPERVISOR_TOKEN` present): reads `/data/options.json`; precomputes the
  allowlist via the supervisor proxy `ws://supervisor/core/websocket` using
  `SUPERVISOR_TOKEN` (no long-lived token needed); proxies to `http://homeassistant:8123`.
- **Dev/CLI**: reads env (`HA_TOKEN`, `HA_BASE`, `DASH_PATHS`, `ALWAYS_FORWARD`,
  `NEVER_FORWARD`, `TRIM`, `PORT`). Verified working against the live HA from a dev box.

Dev run:
```bash
cd websocket-stripper && npm ci     # `ci`, not `install` — the image builds from the lockfile
HA_TOKEN="<token>" HA_BASE="http://homeassistant.mgmt:8123" \
  DASH_PATHS="fridge-status,home-status,dashboard-deck" node ha_ws_trim_proxy.mjs
# open http://localhost:9123/fridge-status
```

## Environment specifics

- HA instance: `http://homeassistant.mgmt:8123` (also `192.168.4.2` = the HA host itself).
  The HA host is the only always-on machine, so production = this app running on it.
- This ships as its **own standalone app with its own port** (8099), independent of any
  other app on the host.
- Target dashboards (storage mode): `fridge-status` (views: fridge-main, weather, audio),
  `home-status` (views: Home, Home Std, Front Door Camera, Kids Cam — note: its Home view
  has malformed `auto-entities` keys like `"domain 1"` from the visual editor),
  `dashboard-deck`.
- Validated numbers: full instance ≈ 3,630 entities; union allowlist for the three
  dashboards ≈ 58. `get_states` confirmed trimmed 3630 → 58 through the proxy.

## Known caveats / open items

- **Frontend JS bundles still load** (cached after first visit). This targets the entity
  firehose, which is what scales with instance size — not first-ever bundle load.
- **Allowlist recomputes live on dashboard edits.** A persistent control ws (`startController`
  in `ha_ws_trim_proxy.mjs`) builds the allowlist at boot, then subscribes to HA's
  `lovelace_updated` event and rebuilds (debounced 1.5 s) on every dashboard save, with
  reconnect-on-drop. So editing a dashboard's cards no longer needs an app restart. A
  recompute still only affects **new** ws connections (HA can't amend a live
  `subscribe_entities`), so since 0.2.3 a rebuild that **adds** entities drops the open
  bridges — the frontend reconnects itself and re-subscribes, no manual kiosk reload.
  Removals deliberately don't churn connections. Adding a whole new dashboard to the
  `dashboards` option still needs a restart (options are read at boot). If the control ws
  can't reconnect, the proxy keeps serving the last-known allowlist.
- **Registries (entity/device/area) ARE trimmed and cached** (`trim_registries`, on by
  default), as is `get_services` (`trim_services`, off by default). The shared response cache
  is keyed by **`(kind, dashboard, allowlist version, allowlist SIGNATURE)`**. The signature is
  the load-bearing part: a connection's allowlist can be *wider* than its dashboard's — a
  `client_overrides` pin, a self-identified satellite, or `user_overrides` — and without it in
  the key, such a connection reads rows missing its extra entities and writes another client's
  rows back for everyone else.
  - **Do not "simplify" this to skipping the cache for widened connections.** That was tried
    (`.30`, an `allowDiverged` flag) on the assumption that widened connections are a rare
    minority. Measured on a live instance, they are the MAJORITY — voice-satellite panels
    self-identify and the admin user matches a user rule — and the hit rate fell from **97.9%
    to 9.1%**. Correct and useless. Identity belongs in the key, not in a bypass.
  - The signature is taken **lazily at the first cacheable request**, not at connection open,
    because `user_overrides` widens the set after the auth gate resolves. **And the cache lookup
    itself runs inside the gated thunk** (`cachedOrForward`), not at receive time. Looking it up
    on receipt bypassed the gate: a hit answered before reaching the queue, with the PRE-rule
    signature, so a widened user was served another connection's rows when the cache was already
    warm for that dashboard. The test with a slowed `auth/current_user` pins this.
  - **Pins from the panel write to whichever source owns the option** (`appendToListOption`):
    the console store if it has taken `always_forward`/`resources_always_forward` over, else
    Supervisor. Writing to Supervisor unconditionally put the pin in the shadowed source, so it
    vanished at the next restart.
  - **A rebuild recycles only the bridges whose own dashboard grew** (`openBridges` maps close
    → dashboard; unattributed bridges follow the union). It used to drop every open connection
    whenever the union gained anything.
  - Note for testing it: every loopback test client is `127.0.0.1`, so a `client_overrides` pin
    widens all of them or none and the collision case never arises. Use two USERS instead —
    that is what `two users on one dashboard never share each other's cached registry` does,
    and dropping the signature from the key must make it fail.
- **Reachability:** the app must resolve `http://homeassistant:8123`. `host_network: true`
  is now set (for trusted-network login, below), which can break the internal
  `homeassistant`/`supervisor` DNS names — the `ha_base` / `allow_ws_url` options pin them
  to IPs if startup fails (e.g. `ha_base: http://192.168.4.2:8123`).
- **Architectures: amd64 and aarch64 only.** `armv7` was removed 2026-09-13 and should not be
  re-added: `node:24-alpine` onwards publishes **no `arm/v7` image** (`node:20-alpine` did), so
  the Supervisor build fails outright on 32-bit ARM — and Home Assistant itself deprecated
  32-bit ARM in 2025.6 and dropped it after 2025.12. **Check the registry manifest before any
  base-image bump**, because that regression was silent: the tag existed, the platform did not.
- **Base image is `node:26-alpine`** via `ARG BUILD_FROM`, taken deliberately ahead of its
  2026-10-28 LTS date (v24 LTS 2025-10-28 / EOL 2028-04-30; v26 LTS 2026-10-28 / EOL
  2029-04-30). Cheap because nothing here compiles — no native bindings, no ABI to rebuild.
  CI tests Node 22, 24 and 26; 24 stays in the matrix as the known-good fallback. Dependabot is
  configured to **ignore Node majors** on purpose: odd lines are never LTS, even ones only
  qualify the October after release, so that call is a person's, not a bot's.
- **Auth through the proxy:** first load does a normal HA login against the proxy origin.
  If login loops/400s, the HA `http:` integration may need `use_x_forwarded_for` +
  `trusted_proxies` for the app's IP.
- **Trusted-network (password-less) kiosk login — CONFIRMED 2026-06-18:** for HA's
  `trusted_networks` provider to match the kiosk's real LAN IP, the app must run with
  `host_network: true`. Diagnosed live: with a *mapped* port, Docker rewrites every client
  to the gateway `172.30.32.1` before the proxy sees it, so `X-Forwarded-For` carries the
  gateway, not the browser. Proven by injecting XFF through `:8099` — only a hand-fed
  already-trusted IP produced a trusted login. Fix = `host_network: true` (now in
  `config.yaml`); HA then sees the proxied request from the **host itself**, so
  `trusted_proxies` needs `127.0.0.1`/`::1` (+ optionally the host LAN IP) and
  `trusted_networks` lists the kiosk subnet (kiosk observed on `192.168.5.0/24`). Keep a
  `type: homeassistant` provider alongside or you lose password login. Alternative without
  host_network: add `172.30.32.1/32` to `trusted_networks` (trusts ALL proxy traffic —
  acceptable only for a kiosk on a trusted LAN).
- **IPv4-mapped IPv6 in X-Forwarded-For — CONFIRMED FIXED 2026-06-18:** even with
  `host_network` correct and `trusted_proxies` loaded, trusted login still failed because
  Node reports dual-stack client IPs as IPv4-mapped IPv6 (`::ffff:192.168.5.247`), and HA's
  `trusted_networks` matches plain IPv4 subnets — a mapped address never matches an IPv4
  network, so it silently fell through to the password prompt. The proxy now normalizes
  `X-Forwarded-For` to bare IPv4 in a `proxyReq` handler (strips the `::ffff:` prefix) in
  `ha_ws_trim_proxy.mjs`. Diagnosed with a temporary `/__whoami` echo endpoint, since
  app logs aren't readable with a long-lived token (Supervisor returns 401). NOTE: a
  local app bakes code into the image at build time (`COPY` in the Dockerfile), so code
  changes need a **Rebuild**, not a Restart; config.yaml `host_network` also needs Rebuild,
  and `http:`/`auth_providers` need a full **Core restart** (not a YAML quick-reload).
- **Never flatten the X-Forwarded-For chain — CONFIRMED FIXED 0.2.3, verified live by a user
  behind Caddy.** The normalization above was originally written as
  `proxyReq.setHeader('x-forwarded-for', ip)`, which *replaced* the whole chain with our
  immediate peer, so with any upstream reverse proxy HA received XFF=1 entry and XFP=2, and
  `forwarded.py` raises `HTTPBadRequest` on
  `len(forwarded_proto) not in (1, len(forwarded_for))` → a hard **400 on every request**
  (issue #9). Normalize each entry **in place**; never rebuild the header from a single IP.
  Also note `proxy.ws()` does NOT fire `proxyReq` — the ws path needs its own `proxyReqWs`
  handler or upgrades silently keep the `::ffff:` form.

  **The invariant is that the For and Proto chains agree in LENGTH — not that our hop is
  appended.** The two proxy libraries differ: node-http-proxy *appended* our hop to all three
  headers; **httpxy sets each only when absent**. Both satisfy HA. A test asserting "the chain
  has exactly 2 entries" pins the library instead of the requirement and fails on a swap that
  broke nothing — which is exactly what happened during the httpxy migration.
- **The proxy library is `httpxy`, not `http-proxy`.** Three API differences bite:
  `createProxyServer` is a **named** export; **`ws()` is `(req, socket, options, head)`** where
  node-http-proxy was `(req, socket, head)` — passing `head` third spreads a Buffer into the
  request options and the upgrade silently never completes; and `web()`/`ws()` return promises,
  so both call sites need a `.catch()` or a proxy error becomes an unhandled rejection and
  takes the process down.
- **`proxyTimeout` (120s, `PROXY_TIMEOUT_MS` to override) bounds the wait on HA.** Nothing did
  before: Node's `server.timeout` is `0` and `requestTimeout` only covers *receiving* a request,
  so an HA that stalled rather than died held the socket forever and never errored. Safe for
  camera streams for two reasons worth not re-deriving: it is an **inactivity** timer, so an
  MJPEG/HLS stream resets it as frames flow; and httpxy applies it in `webIncomingMiddleware`
  only, so `proxy.ws()` upgrades are untouched.
- **The control connection's commands are bounded too (`CONTROL_RPC_TIMEOUT_MS`, 60s).**
  `handshakeTimeout` covers only the upgrade; an HA that wedged on `get_states` left the rebuild
  awaiting forever and the `rebuilding` flag set, so no edit could ever trigger another. Expiry
  drops the socket so `onGone()` rebuilds on a fresh one. The mock's `hangTypes` exercises it.
- **The HA-side bridge socket carries `X-Forwarded-*` (`forwardHeadersFor`).** It is the one
  connection opened without httpxy, so HA saw every trimmed panel as the proxy's address — which
  is what `ip_ban` keys on. Same rule as HTTP: set only when absent, For normalised in place.
  The mock records every `/api/websocket` upgrade's headers in order; note the proxy opens TWO
  per browser (bridge, then the identity probe), so a test reads the first after its marker.
- **Backpressure (`BP_HIGH_BYTES` / `BP_STALL_MS`).** `safeSend` checks `bufferedAmount` after
  every write; past the high mark the HA socket is `pause()`d and polled back to a quarter of
  it. A client with no progress for the stall window is **`terminate()`d, not `close()`d** — a
  close frame queues behind the backlog it is not reading and ws holds it 30s more. Testing it
  needs an INCOMPRESSIBLE payload: the browser leg deflates, so 200KB of `x` leaves as 200 bytes.
- **`resolveUser` dedups in flight by token hash (`USER_INFLIGHT`).** A kiosk load opens several
  sockets with one token; they used to cost one probe each.
- **HTTP/2 and QUIC are settled: NO. Do not revisit without new facts.** httpxy has an `http2`
  option, but it only affects httpxy's own `listen()` helper (`http2.createSecureServer`) — we
  build our own server and call `proxy.web()`, so it is inert here, and it serves h2 rather than
  proxying to an h2 upstream. More fundamentally: WS over HTTP/2 needs RFC 8441 Extended
  CONNECT, which `ws` does not support server-side and HA's aiohttp does not serve at all, so
  the HA leg is HTTP/1.1 by necessity. Browsers already get h2/h3 from **NPM and Cloudflare,
  which sit in front** of this; the NPM→stripper hop is plain HTTP over the LAN, where
  multiplexing buys nothing. And NPM measured **3.6× faster** than hitting the proxy directly,
  which is what killed the direct-TLS proposal too. Let the edge own front-end transport.

## Security

A long-lived HA token was used during dev testing from the dev box; the app does not
need it (uses `SUPERVISOR_TOKEN`). Rotate any dev token when done.
