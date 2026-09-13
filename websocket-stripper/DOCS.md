# WebSocket Stripper

Serves your real Home Assistant dashboards but only forwards the entities each dashboard
uses, so kiosk/wall-panel pages load fast on large instances — with no loss of fidelity
(it's the real frontend and real cards).

## Configuration

| Option | Type | Description |
|--------|------|-------------|
| `dashboards` | list of strings | Dashboard `url_path`s to serve (e.g. `fridge-status`). The forwarded entity set is the **union** of all of them, so you can navigate between them. Find a dashboard's `url_path` in Settings → Dashboards. |
| `always_forward` | list | Entities to forward even if no listed dashboard uses them. Each item is a literal `entity_id` or a `/regex/` (matched against all entities). |
| `never_forward` | list | Entities to never forward. Applied last — **wins** over `always_forward` and dashboard detection. Literal or `/regex/`. |
| `strip_entities` | bool | `true` (default) strips the websocket to the allowlist. `false` = full passthrough (for A/B comparison). |
| `per_dashboard` | bool | `true` (default) serves each connection only the dashboard it is actually viewing, instead of the union of every dashboard in `dashboards`. A panel showing one dashboard stops paying for the others. The dashboard is inferred from the page request that immediately precedes the websocket; a connection that can't be attributed falls back to the union, so nothing is ever served *less* than it was before this option existed. **Limit:** navigating to another dashboard *without* a page reload keeps the allowlist the connection opened with, so that dashboard's own entities show as unavailable until reload — see below. `false` = always serve the union (pre-2026.09 behaviour). |
| `trim_registries` | bool | `true` (default) also trims the entity/device/area registries to what the connection can see, **including `config/entity_registry/list_for_display`**, which is typically the single largest payload the frontend fetches (1.44MB of a 2.46MB load on a 9,553-entity instance). Once states are trimmed this is the largest remaining payload on a big instance — it is one row per entity for the *whole* install. Devices and areas are kept wherever a surviving entity still reaches them, so names and area assignments keep resolving. Turn this **off first** if names, areas or device links render oddly. |
| `trim_services` | bool | `false` (default). Cuts `get_services` to the domains the connection can see. It carries every service of every integration and is sent on every page load — **193KB across 115 domains** on the instance this was built against, where only **45 domains** had any entity. `homeassistant` is always kept, since its services are domain-agnostic. Off by default because the frontend uses this for service pickers and the automation editor. |
| `compress_websocket` | bool | `true` (default) negotiates `permessage-deflate` with the browser, as HA's own websocket does. The `ws` library does not enable this server-side by default, so without it this app *removes* compression that HA would have provided — kiosks receive plaintext JSON. Deflate runs on libuv's threadpool, not the main loop. Set `false` only on very weak hardware where the CPU costs more than the bytes saved. |
| `trim_resources` | bool | `false` (default). Trims **Lovelace resources** (custom cards) per dashboard. Resources are instance-wide in HA, so every kiosk downloads and parses every custom card you have installed — 21MB of JavaScript for a 4-card wall panel on the instance this was built against. A resource is kept when the dashboard's card types (or non-builtin icon prefixes) appear in its file. **Off by default**, and see the tuning section below before turning it on — some resources fail *silently* when dropped. Every drop is logged with its size. |
| `dashboard_overrides` | list | Per-**dashboard** always/never lists. The global lists above are right for something every dashboard needs and wrong for something only one needs, because every panel then pays for it. Each entry takes a `dashboard` (its `url_path`) plus its own `always_forward` / `never_forward`, same syntax as the global lists. The global `never_forward` still wins last. |
| `user_overrides` | list | Per-**user** always/never lists — the one thing per-dashboard rules cannot express: two people opening the *same* dashboard who should not be served the same entities. Give the user's name as shown in Settings → People (or their user id). Add `dashboard` to scope a rule to one dashboard, so "David sees `update.*` on lovelace" does not follow him onto a wall panel. Identity comes from the browser's own access token, resolved once per session against `auth/current_user`. **Cost:** a connection that a rule *could* match is held until the user resolves. Connections whose dashboard no rule is scoped to skip the lookup entirely, so scoping your rules is also a speed optimisation. Leave this empty and no lookup ever happens. |
| `client_overrides` | list | Per-**device** always/never lists, pinned to a physical client rather than to a dashboard or a user. Some entities belong to the machine in front of you, not to the page it happens to be showing — a browser-based voice satellite is the clearest case, where the satellite's entities are only ever useful to the one panel that *is* that satellite. A dashboard rule gets that wrong both ways: the panel loses them when it navigates elsewhere, and every other client opening that dashboard pays for them. Each entry takes a `client` — an IP, an IPv4 CIDR (`10.2.4.0/24`), or a hostname — plus `devices` and/or `always_forward` / `never_forward`. `devices` names whole **devices** by registry name or id and pulls in every entity that device owns, which keeps working when an integration adds entities in a later release. Hostnames resolve when the allowlist is built, so a moved DHCP lease is picked up on the next rebuild; note mDNS/`.local` names generally do **not** resolve from inside a container, so use a real DNS record. |
| `exclude_device_categories` | list | Empty by default. When a **device** is expanded — by a card configured with a device rather than entities, or by a `client_overrides` rule — drop entities Home Assistant labels `config` (controls that configure the device: panel brightness, a reset button, a firmware update) or `diagnostic` (readings about its health: last seen, signal, status code). A litter robot carries 21 entities and a card rendering a fill level needs a handful. **Empty on purpose:** whether a given card renders a diagnostic sensor is not knowable from here, and a wrongly dropped entity blanks part of a card with no error anywhere. Every device expansion logs its split — `+21 entities (8 primary, 7 config, 6 diagnostic)` — so decide with the real numbers for *your* devices in front of you. Note a browser voice satellite measured 18 of 21 entities as `config`, because its pipeline and wake-word selects are configuration controls that the page's JavaScript nonetheless reads to work. |
| `resources_always_forward` | list | URL patterns (literal substring, e.g. `kiosk-mode`, or `/regex/`) always sent. Needed for plugins that patch the frontend instead of registering a card — they contain none of the dashboard's card names, so the content match cannot tell they're used. In practice: `kiosk-mode`, icon packs, and anything that restyles core cards. |
| `resources_never_forward` | list | URL patterns never sent to any dashboard. Wins over `resources_always_forward`. |
| `port` | int | Port the app listens on (default `9123`). Because it runs with `host_network: true`, this option is how you move it off `9123` — the **Network** tab can't remap a host-network port. Change it if `9123` collides with another app (e.g. Zigbee2MQTT). |
| `ha_base` | string | Optional. Override the Home Assistant base URL the app proxies to (default `http://homeassistant:8123`). Set this if `host_network` is on and the internal `homeassistant` hostname doesn't resolve — e.g. `http://192.168.4.2:8123`. |
| `allow_ws_url` | string | Optional. Override the websocket URL used once at startup to precompute the allowlist (default `ws://supervisor/core/websocket`). Set if `supervisor` doesn't resolve under `host_network` — e.g. `ws://192.168.4.2:8123/api/websocket` (also requires a token via `ALLOW_TOKEN`). |

### Example

```yaml
dashboards:
  - fridge-status
  - home-status
  - dashboard-deck
always_forward:
  - "/^sun\\./"
  - person.gabriel
never_forward:
  - "/_battery$/"
strip_entities: true
```

Regex entries are slash-wrapped with optional flags, e.g. `"/_motion$/i"`. In YAML,
backslashes must be escaped (`"\\."`).

### Scoping rules: dashboard, user, or device

The three override blocks answer three different questions. Pick by what the entity actually
belongs to:

```yaml
# "this dashboard needs an entity none of its cards name"
dashboard_overrides:
  - dashboard: hallway-kiosk
    always_forward: ["input_boolean.hallway_night_mode"]

# "David sees update.* on the main dashboard; nobody else does"
user_overrides:
  - user: David Coulson
    dashboard: lovelace
    always_forward: ["/^update\\./"]

# "this panel IS a voice satellite, wherever it navigates"
client_overrides:
  - client: 10.2.4.109
    devices: ["Basement Stairs Panel"]
```

A rule pinned to a **client** applies whether or not the dashboard could be attributed — that is
the point of pinning to a device. A global `never_forward` still wins last over all three.

## Usage

After starting, browse to `http://<ha-host>:9123/<dashboard-url-path>`, e.g.
`http://homeassistant.local:9123/fridge-status`. Point your kiosk browser at that URL.

> **Port:** because this app runs with `host_network: true` (see the tradeoff below),
> it binds directly on the host and the **Network** tab cannot remap it. If `9123` collides
> with another app (e.g. Zigbee2MQTT), set the `port` option instead.

The first visit prompts a normal HA login (it's a different origin); after that it's your
real dashboard.

### Trusted-network (password-less) kiosk login

To let a kiosk skip the password via HA's `trusted_networks` auth provider, the app
must run with `host_network: true` (the default in this app). Without it, Docker
rewrites every client to the gateway IP (`172.30.32.1`) before the proxy sees it, so the
kiosk's real LAN IP never reaches HA and `trusted_networks` can't match it.

On the HA side (`configuration.yaml`), the request now arrives from the **host itself**:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1
    - ::1
    # add the host's own LAN IP too if the app reaches HA via it, e.g. 192.168.4.2
homeassistant:
  auth_providers:
    - type: trusted_networks
      trusted_networks:
        - 192.168.5.0/24      # the kiosk's subnet
      allow_bypass_login: true
    - type: homeassistant     # keep this or you lose password login entirely
```

Then `ha core restart` (a full restart — `http:` changes need it).

### Why `host_network` is on — and what it costs

This app ships with `host_network: true` on purpose. That single flag is a tradeoff, so
here is exactly what you get and what you give up.

**What it buys you.** The app shares the host's network stack instead of Docker's
bridged network, so HA sees the **browser's real LAN IP**. That is the *only* clean way to
make the trusted-network (password-less) kiosk login above work: in bridged mode Docker
NATs every client to the gateway `172.30.32.1` before the proxy sees it, so the kiosk's
real IP never reaches HA and `trusted_networks` can't match it.

**What it costs.**

- **The port is rigid.** It binds `:9123` on the host directly; the **Network** tab can't
  remap it, so a clash with another app on `9123` can't be fixed there (see #6 above).
- **Internal DNS can break.** The `homeassistant` and `supervisor` hostnames may not
  resolve in host-network mode. If startup fails, pin them to IPs with the `ha_base` and
  `allow_ws_url` options (e.g. `ha_base: http://192.168.4.2:8123`).
- **HA sees the request from the host itself**, so `trusted_proxies` must list
  `127.0.0.1`/`::1` (and optionally the host LAN IP) — not the Docker gateway subnet.

**If you don't need password-less-by-IP login**, none of the above helps you and bridged
mode is simpler (free port remapping, working DNS). Some users run a locally-modified copy
with `host_network: false` for exactly that reason. It is not exposed as an option because
`host_network` is a build-time app setting, not a runtime one — changing it means
editing `config.yaml` and rebuilding. If you log in normally (or with a token) and don't
rely on trusted-network auto-login, that's a reasonable local change; you then trim the
port via the Network tab as usual. The default stays `true` so the documented kiosk login
keeps working out of the box.

## Statistics panel

The app registers an Ingress panel, so there is a **Stripper** entry in the Home Assistant
sidebar. (If it is missing, turn on *Show in sidebar* on the app's own page — Supervisor
stores that flag per install and leaves it off for apps that gained Ingress in an update.)

It shows:

- **clients connected now** — address, which dashboard each was attributed to and how, how
  many entities it is subscribed to, and its live update throughput;
- **what got trimmed** — per payload, the size Home Assistant sent, the size the browser
  received, and the difference;
- **per-dashboard** entity counts against the size of the instance, and resource kept/dropped
  figures when `trim_resources` is on;
- **the last 24 hours** — data not sent, clients connected, and update traffic, as charts.

Two JSON endpoints back it, both read-only:

| URL | What |
|---|---|
| `http://<host>:8100/stats.json` | Current snapshot |
| `http://<host>:8100/history.json` | Rolling 24h, 5-minute buckets |

Point a `rest` sensor at either to graph it in Home Assistant itself:

```yaml
sensor:
  - platform: rest
    name: Stripper entities served
    resource: http://homeassistant.local:8100/stats.json
    value_template: "{{ value_json.allowlist.union }}"
    json_attributes_path: "$.savings"
    json_attributes: [before, after, savedPct]
```

### How the 24h history works

Sampled every five minutes into 288 buckets and persisted to `/data`, so an app restart
costs one bucket rather than the whole day.

Buckets hold **deltas**, not cumulative counters. The counters themselves reset when the
process restarts, so a cumulative series goes backwards and a naive difference would emit a
large negative bucket. A counter that decreased is treated as the first sample of a new
process, where the reading is its own delta. Gaps in the charts are periods the app was not
running.

The window total reports the span it actually covers, so an app that has been up for twenty
minutes says twenty minutes rather than implying a full day.

### What the numbers mean

Sizes are **uncompressed payload** — the bytes the browser has to parse. Fewer than that cross
the wire, because the websocket negotiates compression.

The trimmed payloads report a genuine before/after: the proxy holds Home Assistant's full
answer and its own trimmed answer in the same function, so the saving is a subtraction rather
than an estimate.

**Live update traffic is throughput, not a saving.** Home Assistant filters the event stream
server-side from the `entity_ids` this app injects, so the untrimmed volume never exists
anywhere and cannot be measured. Reporting a saving there would mean inventing a
counterfactual. For that comparison, run once with `strip_entities: false` and compare the two
throughput figures.

A connection younger than a minute reports no rate at all rather than extrapolating its
opening burst — the panel shows "—" until there is a full minute to divide by.

## Notes & limits

- Trimming affects the **entity** stream (`get_states` / `subscribe_entities`), the
  **entity/device/area registries** (`trim_registries`, on by default) and optionally the
  **Lovelace resource list** (`trim_resources`, off by default). Lovelace config,
  translations and the frontend JS bundles always pass through untouched.
- Cards referencing entities outside the allowlist will show "unavailable". The allowlist
  is computed generously (all views + template-referenced ids), but if something's
  missing add it via `always_forward`.
- The allowlist is computed at startup and **rebuilt live** when a dashboard is saved (or a
  registry changes) — no restart needed. When the rebuild **adds** entities, open dashboard
  connections are dropped so the frontend reconnects and picks them up on its own; no manual
  kiosk reload. (Removals don't churn open connections — carrying a few entities you no
  longer need is harmless.) Adding a whole new dashboard to `dashboards` still needs a
  restart, since options are read at boot.

### auto-entities filter support

Filter values accept the same forms auto-entities itself accepts — an exact id, a `*` glob
(anchored), or a `/regex/` (**not** auto-anchored; include your own `^`/`$`) — on every key
below, not just `entity_id`.

| Key | Resolved how |
|---|---|
| `entity_id`, `domain` | matched directly |
| `area`, `label`, `device`, `integration` | via the HA registries (matches id **or** name) |
| `name` | against `friendly_name` |
| `group` | expands to the group's members |
| `template` | rendered through HA, then real entity ids are taken from the output |
| `state`, `attributes` | deliberately **over-included** — an entity that doesn't match right now is still forwarded, so the card can show it when it later does |

Entities are also pulled in **transitively through groups**: if a card names a group (or
expands one client-side, e.g. `show_group_members`), its members are allowlisted even though
they appear nowhere in the dashboard config.

Still unsupported, and treated as matching nothing: `not`, `and`, `or`, `floor`,
`device_manufacturer`, `device_model`, `last_changed`. If you rely on one of these, list the
entities in `always_forward` and open an issue.
- **Restarting Home Assistant is safe.** The app keeps running and waits: HTTP returns
  502 and `/api/websocket` is refused while core is down, then it reconnects, rebuilds the
  allowlist, and open dashboards recover on their own. The same applies at host boot, when
  the app starts before core is listening.
- Navigating (via the HA sidebar) to a dashboard **not** in `dashboards` will show its
  entities as unavailable; add it to the list if you want it served too.

### Tuning `trim_resources`

Turn it on, load each kiosk once, and read the app log — it prints what each dashboard
needs and every resource it dropped, with sizes:

```
resources basement-stairs-panel needs: entity-progress-multi-feature, grid-layout, navbar-card, whisker-card
resources basement-stairs-panel: 8/45 kept (2536KB), 37 dropped (18471KB)
    drop   4570KB /hacsfiles/custom-brand-icons/custom-brand-icons.js
    drop   3159KB /bambu_lab/ha-bambulab-cards.js
```

Then look at the dashboard. Anything that looks wrong goes in `resources_always_forward`.
Three classes of plugin reliably need it, because none registers a card the config names.
The first two announce themselves; **the third does not**:

- **Frontend patchers** — `kiosk-mode` (without it the HA header and sidebar reappear),
  `custom-sidebar`, and anything that restyles core cards. Loud when missing.
- **Icon packs** — dropping them can blank icons across the dashboard. Loud when missing.
- **Resident behavioural modules** — resources that register no element and are named by no
  dashboard, but run on load and subscribe to state: an idle return-to-home timer, a camera
  pop-up, a heartbeat another system keys on. **Silent when missing.** The dashboard renders
  pixel-identically; only the behaviour stops, and nothing reports it on either side.

That third class is why "load it and see what looks wrong" is not sufficient on its own, and
why this option stays off by default. It is a real failure, not a hypothetical: it was
reported against this feature by someone who had already lost a doorbell pop-up on 28 panels
for three days to the same failure one level down, where entity scoping stripped the helpers
a resident module read. Home Assistant's half kept working, the chime still played, and the
screens simply never lit up.

**The log names this class for you.** Any resource dropped by *every* dashboard is either
genuinely unused or a resident module about to go quietly inert — the proxy can't tell, but
you can:

```
resources: 3 dropped by ALL dashboards (no dashboard references them), 78KB.
  If any of these run on load rather than rendering a card — an idle timer, a
  pop-up, a heartbeat — add them to resources_always_forward. Dropping one of
  those is INVISIBLE: the dashboard renders normally and only the behaviour stops.
    drop     30KB /local/panel-idle.js
```

Check that list before you decide the feature is working.

A note on judging the result: check that Home Assistant has **finished starting** before you
decide a card is broken. During startup HA serves entities as unavailable, and tile features
like `light-color-favorites` render empty — which looks exactly like a missing resource.

### Cross-dashboard navigation with `per_dashboard` on

A connection is attributed to a dashboard by the page GET that precedes it, and keeps that
allowlist for its whole life. Navigating to a **different** dashboard client-side — the HA
sidebar, a `navigate` tap action, a navbar card — does not reopen the websocket, so entities
unique to the new dashboard render as unavailable until the page reloads.

This is deliberate. The obvious fix is to watch for `lovelace/config` and re-attribute the
connection, but requesting a dashboard's config does not mean displaying it: Kiosk Satellite,
for one, enumerates every dashboard's views at startup. Acting on that signal caused a
reconnect storm and served panels the wrong allowlist (see `2026.09.11.02` in the changelog).

If your panels navigate between dashboards, either set `per_dashboard: false` to serve the
union, or make the navigation a full page load.
