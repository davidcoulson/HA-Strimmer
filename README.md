<p align="center">
  <img src="assets/banner.png" alt="WebSocket Stripper — not the whole house" width="640">
</p>

### Your Home Assistant dashboards are slow because every page loads *your entire house*.

Open a dashboard — even one showing four lights — and Home Assistant sends the browser
**every entity you own**, plus a full catalogue of every entity, device and area in the
house, plus every custom card you have ever installed. Then it streams every change to all
of it, forever. On a big install that is tens of megabytes before a single card appears. On
a wall panel or an old tablet, it is the difference between a dashboard and a loading
screen.

This app sits in front of Home Assistant and sends each dashboard **only what it
actually shows**. Same Home Assistant. Same dashboards. Same cards. Just not the other
9,000 entities.

**On a phone this is the difference between usable and not.** Measured end-to-end in a
browser, the same dashboard: **5.8 MB of entity data becomes 844 KB**, and the load goes
from **8.6 s to 3.3 s on 4G** — or **47 s to 18 s** on a weak cellular link. That is 29
seconds of waiting deleted, and about 5 MB of mobile data *per page load* that never
leaves the house.

---

## ⚡ The difference

Measured on a Sonoff NSPanel Pro (a genuinely slow wall panel) against a Home Assistant
with **9,751 entities**:

| | 😴 Without | 🚀 With | 📉 |
|---|---|---|---|
| **Dashboard appears in** | 60 seconds | **16 seconds** | **73%** faster |
| Entities sent to the page | 9,751 | **104** | **98.9%** |
| 📇 Name/device/area catalogue | 12.7 MB | **~200 KB** | **98.5%** |
| 🎨 Custom card code | 21 MB | **3 MB** | **86%** |
| 🔌 Entity states | 2.5 MB | **112 KB** | **96%** |
| ⚙️ Service list | 196 KB | **~43 KB** | **78%** |
| Data per hour, just sitting there | ~17 MB | **~0.5 MB** | **97%** |

**≈ 4× faster**, and the panel stops thrashing.

### 📱 And on a phone, where it matters most

The table above is a wall panel — a slow client, where the cost is *parsing* 5.8 MB of JSON rather
than moving it. Cellular is where payload size turns directly into waiting.

Headless Chrome, same dashboard, loaded through the app and then straight at Home Assistant.
Median of three runs (five on LAN), timed to the first `<ha-card>` actually rendered:

| Link | 😴 Untrimmed | 🚀 Trimmed | | Time saved |
|---|---|---|---|---|
| **Weak cell** (1.5 Mbps, 150 ms) | 47.1 s | **18.4 s** | **2.6× faster** | **−28.7 s** |
| **4G** (9 Mbps, 40 ms) | 8.6 s | **3.3 s** | **2.6× faster** | **−5.4 s** |
| **Unthrottled LAN** | 0.66 s | **0.43 s** | **1.5× faster** | −0.23 s |

| | Untrimmed | Trimmed |
|---|---|---|
| WebSocket payload | 5,799 KB | **844 KB** (85% less) |
| HTTP payload (frontend bundle) | ~2.6 MB | ~2.3 MB (untouched) |

**The ratio is the same 2.6× on both cellular profiles.** That is not a coincidence: the ratio is
set by the byte counts, which do not change with the link. What the link decides is how many
seconds that ratio is worth — 5 on 4G, 29 on a weak cell. Slower link, same multiple, more waiting
removed. Both cellular rows land just above their theoretical transfer time at the stated bitrate,
which is the check that they are measuring the link and not the harness.

**On a fast LAN the margin narrows, as it must** — when the link is not the bottleneck, deleting
5 MB from it buys less. The app is still ahead, and noticeably steadier: across five runs the
trimmed loads sat between 412 and 630 ms while the untrimmed ones ranged from 474 to 2,028 ms.

> **A cautionary tale, kept here because it cost a real second.** An earlier version of this table
> showed the app **2.2× slower** on LAN. That was real, and the cause was a per-user rule scoped
> to a dashboard the benchmark never opened: every connection was held while the app resolved
> the user, to reach a conclusion that could not change anything. Skipping that lookup when no rule
> could match took the same load from **2,043 ms to 429 ms**. If you use `user_overrides`, scope
> them to a dashboard — it is a correctness feature and a speed feature at once.

Two things worth knowing if you are reasoning about where the time goes. Proxying the frontend is
**not** a cost: measured against this instance the app serves it *faster* than Home Assistant
does — 0.029 s versus 0.043 s for the same 564 KB bundle, and 31 ms versus 75 ms per request over
40 sequential requests. And the HTTP column is the control throughout: the app does not trim
the frontend bundle, and it stays put.

**[Full data and methodology → `docs/PERFORMANCE.md`](docs/PERFORMANCE.md)** — every run, the
validity checks, the limitations, a profile that produced invalid results and why it was
discarded, and a measurement that was wrong for an hour before it was explained.

Reproduce any of it with
[`tools/bench-dashboard-load.mjs`](websocket-stripper/tools/bench-dashboard-load.mjs) — it needs no
configuration change, because it compares the app's port against Home Assistant's own.

### 📅 Now scale that to a day

Per-load numbers are easy to shrug at. The same numbers over 24 hours are not.

One wall panel, connected all day, reloading ten times (screensaver wake, app restart,
network blip):

| | 😴 Without | 🚀 With |
|---|---|---|
| 10 page loads<br/>*(catalogue + states + services)* | 154 MB | **3.6 MB** |
| 24 h of live updates | 408 MB | **12 MB** |
| **One panel, one day** | **≈ 562 MB** | **≈ 16 MB** |
| **Five panels, one day** | **≈ 2.8 GB** | **≈ 78 MB** |

**That's ~36× less — more than half a gigabyte a day, per panel, that never leaves Home
Assistant.** Every byte of it was assembled by your HA box, serialised to JSON, pushed over
the network, and parsed by a cheap wall tablet, so that it could be ignored.

> Custom-card JavaScript is left out of the day totals on purpose: browsers cache it, so the
> 21 MB → 3 MB is paid on first load rather than every load. It still matters — it is 18 MB
> the panel does not parse on a cold start, which is most of the 60 → 16 second gap.

---

## 🎁 What you get

- 🏃 **Dashboards that open in seconds**, not in "go and make a coffee"
- 📱 **~5 MB less mobile data per page load, and seconds off every open.** 5.8 MB of entity
  data down to 844 KB — 8.6 s → 3.3 s on 4G, 47 s → 18 s on a weak signal. If you check
  Home Assistant from outside the house, this is the headline
- 🔋 **Old tablets and wall panels become usable again** — no new hardware
- 🎨 **Nothing looks different.** It is your real Home Assistant frontend, your real
  cards, your real theme. Nothing is re-implemented or approximated
- 🧩 **No changes to your dashboards.** It works out what each one needs by reading it
- 🛟 **Fails safe.** If it is ever unsure, it sends *more*, not less
- 🎯 **Rules that follow the thing they belong to** — scope entities to a dashboard, to a
  person, or to a **physical device**. A wall panel running a browser voice satellite keeps
  its own entities wherever it navigates, and no other client pays for them
- 🔎 **Cards configured with a *device* work properly.** Some custom cards are set up by
  pointing at a device rather than at entities — a 3D printer card, a litter-robot card —
  and the device's entities are pulled in automatically instead of being stripped, which
  used to leave the card rendering blank with no error anywhere
- 📊 **A stats panel in your sidebar** that shows what it is actually doing — per-client
  payload sizes, what each dashboard costs, and where every byte went
- 🐳 **Runs on plain Docker too**, if you have no Supervisor
- 🧱 **Running on a current, supported stack — and kept there.** Node 26 on Alpine, with
  [httpxy](https://github.com/unjs/httpxy) (the maintained unjs fork of node-http-proxy, and
  what `http-proxy-middleware` moved onto) rather than a proxy library last touched in 2024.
  Four direct runtime dependencies and **zero native bindings** — nothing here compiles, so
  there is nothing to rebuild when the runtime moves. The test suite runs on Node
  22, 24 and 26 on every push, the image build is smoke-tested before anything publishes, and
  Dependabot watches the dependencies so "current" does not quietly rot back into
  "end-of-life"
- 🤖 **Built with AI assistance — and proven on real hardware.** Every number above was
  measured on a live Home Assistant instance and a real wall panel, not estimated. The
  optimisations were AI-assisted, then tested against actual dashboards, tablets and
  devices until the stopwatch agreed

---

## 🔍 How it works, briefly

```mermaid
flowchart LR
    B["📱 Your panel<br/>or phone"] --> S["🚿 Stripper"]
    S --> H["🏠 Home<br/>Assistant"]
    H -. "the whole house<br/>9,751 entities + 12.7MB catalogue<br/>+ 21MB of cards" .-> S
    S -. "just this dashboard<br/>104 entities, ~200KB, 3MB" .-> B
```

Home Assistant has no way to tell one dashboard *"only subscribe to what I show"*. This
adds exactly that, as a transparent proxy — so you point your kiosk at it instead of at
Home Assistant, and everything else stays the same.

It trims four separate payloads, and they are genuinely different things:

- 🔌 **Entity states** — what your things are doing, and the endless stream of changes
- 📇 **The catalogue** — the entity/device/area registries: what everything is *called* and
  where it lives. On a big install, quietly the largest download of the lot
- 🎨 **Custom cards** — so a panel stops parsing every card you ever installed
- ⚙️ **The service list** — every action every integration can perform *(opt-in)*

It also **turns compression back on**, which the app had previously been removing. Each
one is explained with examples further down.

---

## 🤔 What it will *not* fix

Being straight with you, because measuring this took a while:

- **It does not make Home Assistant's own frontend boot faster.** That is roughly 16
  seconds on a slow panel and this app cannot touch it. A dashboard with *one* card
  was no quicker than a full one
- **It is for kiosks and panels.** Send your admin browsing through it and
  Settings → Entities and Developer Tools will look oddly empty, because they genuinely
  expect everything. Keep a normal URL for that
- **It helps in proportion to your instance.** A few hundred entities? You will barely
  notice. A few thousand? Night and day

---

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
   strip_entities: true        # the main switch
   per_dashboard: true         # each connection gets only its own dashboard's entities
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

*Trimmed by `strip_entities`* — by telling Home Assistant, at subscribe time, the only entities
this dashboard cares about. Which is why **this is the one saving the stats panel can't show
you**: HA filters server-side, so the untrimmed version is never built and there's nothing to
measure against. Sized once by running with `strip_entities: false` and comparing: **2.5 MB**
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

- ✅ **`strip_entities` and `trim_registries`** — on by default. If either goes wrong you see it
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
   there. To move it off `9123`, set the `port` option — because the app runs
   `host_network: true`, the **Network** tab can't remap it.

> **Tip — keep broad admin dashboards out of the `dashboards` list.** The allowlist is the
> *union* of every listed dashboard, so a big admin/overview dashboard built on wide
> `auto-entities` filters (`integration:`, whole-`area:`) can legitimately resolve to
> thousands of entities and erase most of the trimming benefit. List only the lean kiosk
> dashboards you actually serve; the trim is dramatic for those (dozens of entities) and
> pointless for a dashboard that shows most of the instance anyway.

No long-lived token needed in the app — it uses the app's `SUPERVISOR_TOKEN` to
read the dashboard configs.

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

A ready-to-edit [`docker-compose.yml`](docker-compose.yml) is in the repo root, with every
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
| `PORT` | `port` | Listen port (default `9123`). |
| `STATS_PORT` | `stats_port` | Stats panel + JSON API (default `9122`). Only the default is reachable from the HA sidebar — Ingress routes to `ingress_port`, fixed at install. |
| `ALWAYS_FORWARD` | `always_forward` | Literal ids or `/regex/`. |
| `NEVER_FORWARD` | `never_forward` | Wins over everything. |
| `STRIP_ENTITIES` | `strip_entities` | `0` = plain passthrough, for an A/B comparison. |
| `PER_DASHBOARD` | `per_dashboard` | Each connection gets only its own dashboard's entities. |
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

## 📓 Good to know

- The frontend JS bundles still load (and are cached after first visit); this targets the
  per-load entity firehose, which is the part that scales with instance size. Custom-card
  bundles can additionally be trimmed per dashboard with `trim_resources`, which is off by
  default — read the tuning section in `DOCS.md` first, because a wrongly dropped resource
  can fail *silently*.
- The allowlist **recomputes live** on dashboard edits and registry changes, and open kiosk
  pages reconnect themselves when it grows. Adding a whole new dashboard to the `dashboards`
  option still needs an app restart (options are read at boot).
- Each recompute logs the exact `+added` / `-removed` entity diff, so you can see from the
  app log what a dashboard edit changed.
- **Restarting Home Assistant is safe.** The app stays up and waits: HTTP degrades to 502
  while core is down, then it reconnects, rebuilds, and open dashboards recover on their own.
  Same at host boot, when the app starts before core is listening.
- Cards can still show "unavailable" if a filter type isn't supported yet — currently `not`,
  `and`, `or`, `floor`, `device_manufacturer`, `device_model`, `last_changed`. List those
  entities in `always_forward` and open an issue.
- A **local** app bakes the code into its image at build time, so updates need a
  **Rebuild**, not a Restart.
- See `CLAUDE.md` for architecture/decisions and `websocket-stripper/DOCS.md` for option
  details.

## ☕ Credit & support

This is a fork of [GabrielGoldsteinAnidea/HA-Websocket-Stripper](https://github.com/GabrielGoldsteinAnidea/HA-Websocket-Stripper)
— the original idea and the hard part are Gabriel's. If it saved you an evening, a coffee is
appreciated.

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=flat-square&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/gabrielgoldstein)

## 🆕 What's new

Full history in [`websocket-stripper/CHANGELOG.md`](websocket-stripper/CHANGELOG.md).

**The big ones, in plain English:**

- 🔎 **Find a missing entity from the panel, and send it without restarting.** When a card is
  blank, the entity it needs is usually outside the allowlist — and that entity appeared
  *nowhere* in the stats, because everything there describes what is being sent. The panel now
  has a search box over every entity on the instance, showing which are currently sent, with an
  **Always send** button on the ones that are not. Pinning applies **immediately**: the allowlist
  rebuilds and panels pick it up on their own reconnect, with nothing to restart
- 🧹 **Each connection gets only the devices and areas its own entities reach.** The entity
  registry always worked this way; devices and areas were being cut to the union of *every*
  dashboard, so a panel showing 48 entities received every device reachable by all 418. Fixing it
  took the device registry from 87% trimmed to 92%
- 🌍 **Translations are the biggest thing left, and can now be trimmed.** Home Assistant sends
  the browser translations for *every installed integration* on every page load — measured here
  at **5,359 keys / 432 KB across 69 integrations**, of which `tuya_local` alone contributed 823
  keys to panels that show no Tuya at all. `trim_translations` cuts it to what a connection can
  actually see: **~190 KB off every load, 79% of that payload**. Off by default, and the one
  option whose failure is *visible* rather than silent — a missing translation renders its raw
  key on the dashboard — so turn it on and look at your panels. With `trim_repairs` alongside it
  (the admin Repairs backlog, ~27 KB a load, which a kiosk never shows) total savings on the
  instance this was built against reached **96%**
- 🔍 **A log you can turn down, and turn up.** `log_level` adds `warn` / `info` / `debug`.
  `info` is the default and is exactly what it always wrote, so nothing changes on upgrade —
  the point is `debug`, which adds per-connection and per-decision detail that is not written at
  any other level, for when you are actually hunting something
- 🧱 **The whole stack got modernised, and wired up so it stays that way.** The runtime moved
  Node 20 → 24 → 26 (20 hit end-of-life in March 2026 and had been shipping without security
  patches), and `http-proxy` — untouched since December 2024 — was replaced with
  [httpxy](https://github.com/unjs/httpxy), which also has **zero dependencies**, so
  `follow-redirects`, `eventemitter3` and `requires-port` left the tree entirely. More
  importantly the gaps that let it rot are closed: the 229 tests now run in CI on three Node
  versions instead of on whichever laptop last touched the code, the image installs from the
  committed lockfile (`npm ci`) so a build is reproducible rather than "whatever resolved
  today", pull requests build and smoke-test the image before anything publishes, and
  Dependabot watches for the next round
- 🎯 **Each panel gets only its own dashboard.** Before, every kiosk got everything *any*
  listed dashboard needed. Now a panel showing one dashboard pays for one dashboard —
  104 entities instead of 391 on the instance this was built against
- 📇 **The hidden address-book downloads got trimmed too.** Home Assistant sends a list of
  every entity, device and area you own on *every* page load. On a big install this is
  quietly the largest download of all — **10 MB of it here**, now about a hundred rows
- 🗜️ **Compression is back on.** Home Assistant compresses its websocket; the proxy
  accidentally dropped that. It doesn't any more
- 🎨 **Only the custom cards a dashboard uses.** Home Assistant hands every dashboard every
  custom card you have ever installed — **21 MB** here. Opt-in, since it's the one feature
  that can fail quietly (`trim_resources`)
- 🧠 **Repeat visits are cheaper.** Identical answers are remembered and served instantly
  instead of making Home Assistant build them all over again
- 🏷️ **Every setting now explains itself** right in the app's Configuration tab
- 📊 **A stats panel in your HA sidebar.** See what it is actually saving you — connected panels, before/after sizes per dashboard, live traffic — instead of only finding out when something looks wrong. There is a `stats.json` behind it too, so you can graph any of it with a `rest` sensor
- 🔁 **Your own HTTPS proxy works properly now.** Caddy, nginx or Traefik in front used to send
  pages into an endless redirect loop and break remote login. Fixed — including the
  custom-scheme callback the iOS and Android companion apps use to sign in
- 🚿 **A hidden 490 MB/hour firehose got shut off.** One subscription type bypassed the
  trimming entirely, and it hid because Home Assistant *batches* messages into arrays that
  every type check quietly ignored
- 🖼️ **Camera and media frames are no longer corrupted.** Binary frames were being decoded as
  text in transit. On a wall panel they were 90% of everything received
- 👤 **Rules can be scoped three ways** — to a dashboard, to a person, or to a **device**.
  The last one matters for anything that belongs to the machine rather than the page: a
  browser-based voice satellite needs its own entities wherever it navigates, and no other
  client should pay for them
- 📱 **Companion-app connections get attributed properly**, by User-Agent, since the native
  socket doesn't carry the cookie a browser does
- 🌐 **You can see how each client reaches you** — LAN or internet, and whether it came via
  Cloudflare, a reverse proxy, Ingress or directly. Purely observational; it never gates access
- 🐳 **Runs on plain Docker**, no Supervisor needed —
  `ghcr.io/davidcoulson/ha-websocket-stripper`, amd64 and arm64
- 🔌 **Default port moved to 9123**, because 8099 collides with Zigbee2MQTT

### 0.2.3

- **auto-entities globs and regexes work on every filter key** — `/^sensor\.pv_.*_power$/`
  and friends resolve instead of matching nothing, on `domain` / `area` / `label` / `device`
  / `integration` / `name`, not just `entity_id`.
- **`filter: template:` cards resolve** — rendered through HA rather than skipped.
- **Group members are pulled in transitively**, so cards that expand a group client-side
  (`show_group_members`) stop showing their members as "unavailable".
- **Fixed 400 Bad Request behind another reverse proxy** — the `X-Forwarded-For` chain is
  preserved, so Caddy / nginx / Traefik in front of the app works.
- **Open dashboards pick up new entities by themselves** — no more reloading every wall panel
  after a dashboard edit.

### 0.2.2 — important if you're upgrading from ≤ 0.2.1

- **An empty allowlist is never forwarded as "no filter" again.** HA reads
  `set(msg["entity_ids"]) or None`, so an empty `entity_ids` meant *no filter at all* — and
  because `dashboards` used to default to the author's own dashboards, a fresh install
  resolved nothing and relayed **every entity on the instance**, the exact opposite of the
  point. `dashboards` now defaults to `[]` and the websocket is refused (with the reason
  logged) rather than sending an empty filter.
- **Surviving an HA restart** — the app no longer crash-loops when core goes away.

### 0.2.0

- **auto-entities `area` / `label` / `device` / `integration` filters resolve** against the
  registries, so you don't have to hand-list them in `always_forward`.
- **Configurable `port` option** — coexist with other apps on busy hosts.
- **Recompute logs the `+added` / `-removed` entity diff**, not just the total.
- **Defensive egress filter** re-filters `subscribe_entities` event payloads to the
  allowlist on the way to the browser — a belt-and-suspenders guarantee the firehose can't
  leak even if a future HA ignored the subscription filter.
- Added a test suite (`cd websocket-stripper && npm test`): unit tests for the extractor +
  registry resolver, and integration tests that run the real proxy against a mock HA.
