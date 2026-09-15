# Installing and configuring WebSocket Stripper

Everything needed to get the app running and tuned, whichever way you run Home Assistant.
For *why* it exists and what it measures, see the [README](../README.md).

| | |
|---|---|
| 🏠 **Home Assistant OS / Supervised** | [Set it up](#supervisor) — the five-minute path |
| 🐳 **Container / Core** | [Run it on plain Docker](#docker) |
| ⚙️ **Every option, described** | [`websocket-stripper/DOCS.md`](../websocket-stripper/DOCS.md) — also the app's own Documentation tab |
| 📈 **Measurements** | [`PERFORMANCE.md`](PERFORMANCE.md) |

---

<a id="supervisor"></a>

## 🛠️ Set it up (about 5 minutes)

1. HA → **Settings → Apps → App store → ⋮ → Repositories**, add:
   `https://github.com/davidcoulson/HA-Websocket-Stripper`  <!-- fork -->
2. Install **WebSocket Stripper**, open **Configuration**, and set `dashboards` to your own
   dashboards' `url_path` values (Settings → Dashboards). It ships **empty** — until you set
   it, the app refuses `/api/websocket` and says so in the log, rather than silently
   serving the untrimmed firehose:
   ```yaml
   dashboards:
     - kitchen-panel           # <-- your dashboards' url_path values
     - hallway-kiosk
   always_forward: []          # e.g. ["/^sun\\./", "person.alex"]
   never_forward: []           # e.g. ["/_battery$/"]
   trim_entities: true        # the main switch
   by_dashboard: true         # each connection gets only its own dashboard's entities
   trim_registries: true       # also cut the entity/device/area registries
   compress_websocket: true    # leave on: HA's own websocket compresses too
   trim_resources: false       # off by default — see below
   trim_services: false        # off by default — fine for kiosks, lossy in the admin UI
   ```
   Every option has a name and description in the **Configuration** tab, so you can read
   what each does without leaving Home Assistant.

### 🧠 Wait — what's an entity vs a registry vs a resource?

Fair question — and the names don't help, because two of them sound like the same thing and
aren't. Home Assistant sends a dashboard four completely different kinds of thing, and each
switch trims a different one.

The one worth getting straight first: **the states and the registries are separate payloads.**
The states say what your lights are *doing*; the registries say what they're *called* and
where they live. Both are sent, in full, on every page load.

#### 🔌 Entity states — one switch, two payloads

Your actual stuff, and what it's doing. This arrives as **two different things**, which is
worth separating because only one of them ever stops:

**1. The snapshot** — *what is everything doing right now*, sent once when the page loads.

> `light.kitchen_ceiling` → *on, 60% brightness*
> `sensor.outdoor_temperature` → *12.4 °C*
> `binary_sensor.front_door` → *closed*

**2. The stream** — *what just changed*, sent forever after that.

> …four minutes later: `binary_sensor.front_door` → *open*

Modern Home Assistant delivers both down **one subscription**: the first message is the whole
snapshot, everything after it is a diff. (There's an older, separate call for the snapshot
alone — `get_states` — but the current frontend doesn't use it. On the instance this was built
against it is never called once.)

*Trimmed by `trim_entities`* — by telling Home Assistant, at subscribe time, the only entities
this dashboard cares about. Which is why **this is the one saving the stats panel can't show
you**: HA filters server-side, so the untrimmed version is never built and there's nothing to
measure against. Sized once by running with `trim_entities: false` and comparing: **2.5 MB**
of snapshot per page load and roughly **17 MB per hour** of stream, versus 112 KB and 0.5 MB/h
with it on.

#### 📇 Registries — the catalogue, not the values

Here's the bit that trips people up: the registries are a **completely separate** set of lists
from the states above. They hold no values at all. They're the phone book — what exists, what
it's called, what it belongs to.

> The entity registry row for `light.kitchen_ceiling` says it's called "Ceiling" and belongs
> to device *Hue Lamp 3*. The device registry says *Hue Lamp 3* lives in the **Kitchen** area.

That's what lets a card show **"Kitchen · Ceiling"** instead of `light.kitchen_ceiling`. It
changes only when you add, rename or move something — and yet it's one row per entity **for
your entire house**, re-sent on every single page load.

If you take one thing from this section: on a large install **the phone book is far bigger
than the states**. It's the single largest thing your dashboard downloads.

*Trimmed by `trim_registries`.*

#### 🎨 Resources — the custom cards you installed

The JavaScript files behind the cards you added through HACS.

> `/hacsfiles/lovelace-mushroom/mushroom.js`
> `/hacsfiles/mini-graph-card/mini-graph-card-bundle.js`
> `/hacsfiles/ha-bambulab-cards/ha-bambulab-cards.js`

Resources are installed **instance-wide**, so Home Assistant hands *every* dashboard *every*
card you have ever installed. Add a 3D-printer card for one dashboard and your bedroom wall
panel downloads and parses it too — forever, whether or not a single card on it uses one.

*Trimmed by `trim_resources`.*

#### ⚙️ Services — the list of things that can be *done*

> `light.turn_on`, `climate.set_temperature`, `vacuum.start`, `media_player.volume_set`

Every action every installed integration can perform. The frontend uses it to populate service
pickers and the automation editor — so it's essential if you're *editing* automations, and
dead weight on a panel that just shows the temperature.

*Trimmed by `trim_services`.*

---

Measured per page load on the instance this was built against (9,751 entities):

| | Before | After | |
|---|---|---|---|
| 📇 Registries | **12.7 MB** | ~200 KB | the largest download, by a distance |
| 🎨 Resources | **21 MB** | ~3 MB | of custom-card JavaScript |
| 🔌 Entity states | **2.5 MB** | 112 KB | plus ~17 MB/h of stream → ~0.5 MB/h |
| ⚙️ Services | **196 KB** | ~43 KB | across 115 integrations |

### Which are safe to leave on?

- ✅ **`trim_entities` and `trim_registries`** — on by default. If either goes wrong you see it
  instantly: a card shows "unavailable", or a name renders as `light.abc123` instead of
  "Ceiling". Loud, obvious, easy to undo.
- ⚠️ **`trim_resources`** — opt-in. Most mistakes here are loud too: a missing card shows
  *"Custom element doesn't exist"*, a missing icon pack shows blank squares. The catch is one
  specific kind — a resource with **no card at all**, that just runs quietly in the background.
  An idle timer that dims the screen. A pop-up that appears when the doorbell rings. Drop one
  of those and the dashboard looks *pixel-identical*; only the behaviour stops, and nothing
  tells you. Turn it on, load each dashboard once, and read the log's
  **"dropped by ALL dashboards"** list — that's where such a resource would be hiding.
- ⚠️ **`trim_services`** — opt-in, and nothing ever breaks visually. Service dropdowns and the
  automation editor just get shorter. Ideal for a wall panel, irritating if you administer
  Home Assistant through the same URL. Keep a normal HA address for that.

3. Start it. Browse `http://<ha-host>:9123/<your-dashboard>`. Point your kiosk browser
   there. To move it off `9123`, set the `proxy_port` option — because the app runs
   `host_network: true`, the **Network** tab can't remap it.

> **Tip — keep broad admin dashboards out of the `dashboards` list.** The allowlist is the
> *union* of every listed dashboard, so a big admin/overview dashboard built on wide
> `auto-entities` filters (`integration:`, whole-`area:`) can legitimately resolve to
> thousands of entities and erase most of the trimming benefit. List only the lean kiosk
> dashboards you actually serve; the trim is dramatic for those (dozens of entities) and
> pointless for a dashboard that shows most of the instance anyway.

No long-lived token needed in the app — it uses the app's `SUPERVISOR_TOKEN` to
read the dashboard configs.

<a id="docker"></a>

## 🐳 No Supervisor? Run it on plain Docker

Apps need Supervisor, so if you run **Home Assistant Container** or **Core** you can't
install one. Same program, same features — just a container:

```
ghcr.io/davidcoulson/ha-websocket-stripper:latest
```

You need **one thing the app gets for free**: a long-lived access token. In HA, click your
user (bottom left) → **Security** → **Create token**.

### Quickest possible start

```bash
docker run -d --name websocket-stripper --restart unless-stopped \
  -p 9123:9123 -p 9122:9122 \
  -v stripper-data:/data \
  -e HA_BASE="http://homeassistant:8123" \
  -e HA_TOKEN="<your-long-lived-token>" \
  -e DASH_PATHS="kitchen-panel,hallway-kiosk" \
  ghcr.io/davidcoulson/ha-websocket-stripper:latest
```

Then point your kiosks at **`http://<this-host>:9123`** instead of your HA URL, and open
**`http://<this-host>:9122`** for the stats panel. Home Assistant stays on its own port and
nothing about your HA install changes — this sits in front of it.

Check it came up:

```bash
curl -s http://localhost:9122/stats.json | head -20
```

### docker compose

A ready-to-edit [`docker-compose.yml`](../docker-compose.yml) is in the repo root, with every
option commented. The short version:

```yaml
services:
  websocket-stripper:
    image: ghcr.io/davidcoulson/ha-websocket-stripper:latest
    restart: unless-stopped
    ports:
      - "9123:9123"     # what your browsers and kiosks connect to
      - "9122:9122"     # stats panel + JSON API
    volumes:
      - stripper-data:/data       # keeps the 24h stats across restarts
    environment:
      HA_BASE: "http://homeassistant:8123"
      HA_TOKEN: "<your-long-lived-token>"
      DASH_PATHS: "kitchen-panel,hallway-kiosk"

volumes:
  stripper-data:
```

```bash
docker compose up -d
docker compose logs -f      # the log names every dashboard and what it trimmed to
```

If HA runs in Docker too, put both on the same network and `HA_BASE` can use the container
name (`http://homeassistant:8123`). Otherwise use the host's IP — `localhost` inside a
container is the container, not your HA.

### Every option, as an environment variable

The container takes the same settings as the app. Lists are comma-separated; the last three
are JSON.

| Env var | App option | Notes |
|---|---|---|
| `HA_BASE` | — | Your HA, reachable **from the container**. |
| `HA_TOKEN` | — | Long-lived access token. Required; the app uses `SUPERVISOR_TOKEN` instead. |
| `DASH_PATHS` | `dashboards` | `url_path` of each dashboard to serve. **Required** — empty means the proxy refuses websockets rather than serving the untrimmed firehose. |
| `PROXY_PORT` | `proxy_port` | Port browsers and wall panels connect to (default `9123`). The old names `PORT` / `port` still work. |
| `MGMT_PORT` | `mgmt_port` | Management console + JSON API (default `9122`). Only the default is reachable from the HA sidebar — Ingress routes to `ingress_port`, fixed at install. The old names `STATS_PORT` / `mgmt_port` still work. |
| `ALWAYS_FORWARD` | `always_forward` | Literal ids or `/regex/`. |
| `NEVER_FORWARD` | `never_forward` | Wins over everything. |
| `STRIP_ENTITIES` | `trim_entities` | `0` = plain passthrough, for an A/B comparison. |
| `PER_DASHBOARD` | `by_dashboard` | Each connection gets only its own dashboard's entities. |
| `TRIM_REGISTRIES` | `trim_registries` | Entity/device/area registries. |
| `COMPRESS_WS` | `compress_websocket` | Leave on. |
| `TRIM_RESOURCES` | `trim_resources` | **Off by default** — read the tuning notes before enabling. |
| `TRIM_SERVICES` | `trim_services` | **Off by default** — visibly lossy in the admin UI. |
| `TRIM_REPAIRS` | `trim_repairs` | **Off by default.** Empties the admin Repairs backlog (~27 KB per load). |
| `TRIM_THEMES` | `trim_themes` | **Off by default.** Sends only the themes your dashboards name, plus HA's defaults (~28 KB per load). |
| `TRIM_TRANSLATIONS` | `trim_translations` | **Off by default, and the most lossy option here** — a missing translation renders its raw key on the dashboard. ~190 KB saved per load when it fits. |
| `LOG_LEVEL` | `log_level` | `warn` / `info` (default) / `debug`. |
| `PROXY_TIMEOUT_MS` | — | How long to wait on Home Assistant before returning 502 (default `120000`). `0` disables. |
| `RESOURCES_ALWAYS_FORWARD` | `resources_always_forward` | URL fragments, e.g. `kiosk-mode`. |
| `RESOURCES_NEVER_FORWARD` | `resources_never_forward` | |
| `DASHBOARD_OVERRIDES` | `dashboard_overrides` | JSON array. Always/never lists scoped to one dashboard. |
| `USER_OVERRIDES` | `user_overrides` | JSON array. Always/never lists scoped to one HA user. |
| `CLIENT_OVERRIDES` | `client_overrides` | JSON array. Always/never lists pinned to a **device** — an IP, a CIDR, or a hostname — and able to name whole devices whose entities it needs. |
| `EXCLUDE_DEVICE_CATEGORIES` | `exclude_device_categories` | `config` and/or `diagnostic`, comma-separated. Empty by default — trims what a device expansion pulls in. |
| `UA_DASHBOARDS` | `user_agent_dashboards` | JSON array. |
| `HISTORY_DIR` | — | Where to keep the 24h stats. Defaults to `/data` when that exists. |

### One thing that catches people

Home Assistant only trusts a proxy it has been told about. Because the stripper forwards the
real client IP, HA needs to be told to believe it — otherwise every client appears to come
from the container, which breaks `trusted_networks` logins and IP bans. In `configuration.yaml`:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 172.16.0.0/12        # the Docker network the stripper runs on
```

Use the container's actual subnet, and keep it as narrow as you can — anything in
`trusted_proxies` is trusted to *claim* a client IP.

### Which architectures

`linux/amd64` and `linux/arm64` — x86 boxes and 64-bit Raspberry Pi OS, which is what HA's own
documentation recommends.

32-bit `armv7` is **not** published, and this one isn't a case of nobody asking. The Node base
image stopped publishing an `arm/v7` build after Node 20, so there is nothing to build it
*from* — and Home Assistant deprecated 32-bit ARM in 2025.6 and
[dropped it after 2025.12](https://www.home-assistant.io/blog/2025/05/22/deprecating-core-and-supervised-installation-methods-and-32-bit-systems/),
so an armv7 host is running an unsupported Home Assistant regardless. If you're on a Pi 2, or a
Pi 3/4 with a 32-bit OS, the fix is a 64-bit OS rather than a 32-bit build of this.

## 🔓 Skip the login screen on a wall panel

For a wall panel / fridge kiosk you usually don't want a password prompt. HA's
[`trusted_networks`](https://www.home-assistant.io/docs/authentication/providers/#trusted-networks)
auth provider shows a "pick a user" screen (or auto-selects one) for clients on trusted
IPs. To make it work **through this proxy**, HA must see the real browser IP — and getting
that right has two subtle requirements, both handled by this app out of the box:

1. **The app runs with `host_network: true`** (built in). This is essential: with a
   *mapped* port, Docker rewrites every client to the gateway `172.30.32.1` before the
   proxy ever sees it, so the kiosk's real IP is lost and trusted login can never match.
   Host networking lets the app see the real browser IP.
2. **The app forwards that IP via `X-Forwarded-For`, normalized to plain IPv4** (built
   in). Node reports dual-stack clients as IPv4-mapped IPv6 (`::ffff:192.168.1.50`), which
   won't match an IPv4 `trusted_networks` subnet; the app strips that prefix for you, on
   both HTTP requests and websocket upgrades.

Because of `host_network`, HA sees the proxied request coming from the **host itself**, so
trust the host (not the app's Docker subnet) in your HA `configuration.yaml`:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1
    - ::1
    # - 192.168.1.2          # also add the host's own LAN IP if the app reaches HA via it

homeassistant:
  auth_providers:
    - type: trusted_networks
      trusted_networks:
        - 192.168.1.0/24      # <-- your kiosk's LAN subnet
      allow_bypass_login: true # skip the form entirely where one user is unambiguous
      # optional: auto-select a user per IP instead of showing the picker
      # trusted_users:
      #   192.168.1.50: <user-id-from-Settings-People>
    - type: homeassistant      # keep this, or you lose password login entirely
```

Then **restart HA Core** (`use_x_forwarded_for` and `auth_providers` are core-config
changes, not a YAML quick-reload).

> ℹ️ **Note:** because the proxy presents requests to HA from the host, anyone who can
> reach the app's port effectively gets trusted-network login. That's the point for a
> kiosk on a trusted LAN, but it does mean the trimmed dashboards are reachable without a
> password by anything on that network — size your `trusted_networks` accordingly.

> 🛠️ **If `host_network` breaks startup** (the app can't resolve the internal
> `homeassistant`/`supervisor` hostnames), set the `ha_base` / `allow_ws_url` options to
> pin them to IPs, e.g. `ha_base: http://192.168.1.2:8123`.

## 🌐 Behind your own reverse proxy (Caddy / nginx / Traefik, HTTPS)

Putting your own reverse proxy in front of the app works — useful for TLS termination and
external access, and required for browser features that only work on a secure origin (mic
input for Assist, for instance).

The app **preserves the `X-Forwarded-For` chain** rather than replacing it, so HA sees the
real browser IP through both hops and `trusted_networks` still matches the kiosk, not your
edge proxy. Make sure HA trusts every hop:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1               # the stripper (reaches HA from the host, via host_network)
    - ::1
    - 192.168.1.5             # your Caddy / nginx host, if it's a different machine
```

Redirects are rewritten to point back at the origin your **browser** actually used — scheme
and host together, plus absolute URLs carried in `redirect_uri` and `hass_url`. Relative
redirects stay relative and genuinely third-party ones are left alone. The companion apps'
custom-scheme callback (`homeassistant://…`) is preserved rather than rewritten, so app login
works through the proxy too.

> **Two bugs to know about if you are upgrading:**
>
> - Versions before 0.2.3 **flattened the `X-Forwarded-For` chain**, which made HA reject every
>   proxied request with **400 Bad Request** (`Incorrect number of elements in
>   X-Forward-Proto`) while a direct connection to `:8123` worked fine.
> - Versions before 2026.09.13.08 rewrote a redirect's **host but not its scheme**, so an
>   HTTPS terminator in front produced an **infinite redirect loop** — the URL degenerating
>   into `.../:8123./:8123./:8123./...` — and remote login failed because the auth
>   `redirect_uri` still pointed at HA's internal LAN address.
>
> If you hit either, update.

## 💻 Run it locally (for developers)

Needs **Node 22 or newer** (the image ships 26; CI covers 22, 24 and 26).

```bash
cd websocket-stripper
npm ci                     # `ci`, not `install` — installs exactly the committed lockfile
npm test                   # 229 tests, no network and no Home Assistant required
HA_TOKEN="<long-lived-token>" \
  HA_BASE="http://homeassistant.mgmt:8123" \
  DASH_PATHS="kitchen-panel,hallway-kiosk" \
  node ha_ws_trim_proxy.mjs
# then open http://localhost:9123/kitchen-panel
```

Run `npm test` for the suite (extractor + registry/filter resolution unit tests, plus
integration tests that drive the real proxy against a mock HA).

Set `STRIP_ENTITIES=0` to passthrough untrimmed for an A/B load comparison.
