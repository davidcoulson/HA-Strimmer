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

This add-on sits in front of Home Assistant and sends each dashboard **only what it
actually shows**. Same Home Assistant. Same dashboards. Same cards. Just not the other
9,000 entities.

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

The surprise for most people is the catalogue row: on a large install the *catalogue* — the
names and areas, not the values — is the biggest thing a dashboard downloads. It is sent in
full, for the whole house, on every single page load.

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
- 📱 **Way less mobile data** — great if you reach HA from outside the house
- 🔋 **Old tablets and wall panels become usable again** — no new hardware
- 🎨 **Nothing looks different.** It is your real Home Assistant frontend, your real
  cards, your real theme. Nothing is re-implemented or approximated
- 🧩 **No changes to your dashboards.** It works out what each one needs by reading it
- 🛟 **Fails safe.** If it is ever unsure, it sends *more*, not less
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

It also **turns compression back on**, which the add-on had previously been removing. Each
one is explained with examples further down.

---

## 🤔 What it will *not* fix

Being straight with you, because measuring this took a while:

- **It does not make Home Assistant's own frontend boot faster.** That is roughly 16
  seconds on a slow panel and this add-on cannot touch it. A dashboard with *one* card
  was no quicker than a full one
- **It is for kiosks and panels.** Send your admin browsing through it and
  Settings → Entities and Developer Tools will look oddly empty, because they genuinely
  expect everything. Keep a normal URL for that
- **It helps in proportion to your instance.** A few hundred entities? You will barely
  notice. A few thousand? Night and day

---

## 🛠️ Set it up (about 5 minutes)

1. HA → **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add:
   `https://github.com/davidcoulson/HA-Websocket-Stripper`  <!-- fork -->
2. Install **WebSocket Stripper**, open **Configuration**, and set `dashboards` to your own
   dashboards' `url_path` values (Settings → Dashboards). It ships **empty** — until you set
   it, the add-on refuses `/api/websocket` and says so in the log, rather than silently
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
   there. To move it off `9123`, set the `port` option — because the add-on runs
   `host_network: true`, the **Network** tab can't remap it.

> **Tip — keep broad admin dashboards out of the `dashboards` list.** The allowlist is the
> *union* of every listed dashboard, so a big admin/overview dashboard built on wide
> `auto-entities` filters (`integration:`, whole-`area:`) can legitimately resolve to
> thousands of entities and erase most of the trimming benefit. List only the lean kiosk
> dashboards you actually serve; the trim is dramatic for those (dozens of entities) and
> pointless for a dashboard that shows most of the instance anyway.

No long-lived token needed in the add-on — it uses the add-on's `SUPERVISOR_TOKEN` to
read the dashboard configs.

## 🔓 Skip the login screen on a wall panel

For a wall panel / fridge kiosk you usually don't want a password prompt. HA's
[`trusted_networks`](https://www.home-assistant.io/docs/authentication/providers/#trusted-networks)
auth provider shows a "pick a user" screen (or auto-selects one) for clients on trusted
IPs. To make it work **through this proxy**, HA must see the real browser IP — and getting
that right has two subtle requirements, both handled by this add-on out of the box:

1. **The add-on runs with `host_network: true`** (built in). This is essential: with a
   *mapped* port, Docker rewrites every client to the gateway `172.30.32.1` before the
   proxy ever sees it, so the kiosk's real IP is lost and trusted login can never match.
   Host networking lets the add-on see the real browser IP.
2. **The add-on forwards that IP via `X-Forwarded-For`, normalized to plain IPv4** (built
   in). Node reports dual-stack clients as IPv4-mapped IPv6 (`::ffff:192.168.1.50`), which
   won't match an IPv4 `trusted_networks` subnet; the add-on strips that prefix for you, on
   both HTTP requests and websocket upgrades.

Because of `host_network`, HA sees the proxied request coming from the **host itself**, so
trust the host (not the add-on docker subnet) in your HA `configuration.yaml`:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1
    - ::1
    # - 192.168.1.2          # also add the host's own LAN IP if the add-on reaches HA via it

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
> reach the add-on's port effectively gets trusted-network login. That's the point for a
> kiosk on a trusted LAN, but it does mean the trimmed dashboards are reachable without a
> password by anything on that network — size your `trusted_networks` accordingly.

> 🛠️ **If `host_network` breaks startup** (the add-on can't resolve the internal
> `homeassistant`/`supervisor` hostnames), set the `ha_base` / `allow_ws_url` options to
> pin them to IPs, e.g. `ha_base: http://192.168.1.2:8123`.

## 🌐 Behind your own reverse proxy (Caddy / nginx / Traefik, HTTPS)

Putting your own reverse proxy in front of the add-on works — useful for TLS termination and
external access, and required for browser features that only work on a secure origin (mic
input for Assist, for instance).

The add-on **preserves the `X-Forwarded-For` chain** rather than replacing it, so HA sees the
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

> **Note:** versions before 0.2.3 flattened that chain, which made HA reject every proxied
> request with **400 Bad Request** (`Incorrect number of elements in X-Forward-Proto`) while
> a direct connection to `:8123` worked fine. If you hit that, update.

## 💻 Run it locally (for developers)

```bash
cd websocket-stripper
npm install
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
  option still needs an add-on restart (options are read at boot).
- Each recompute logs the exact `+added` / `-removed` entity diff, so you can see from the
  add-on log what a dashboard edit changed.
- **Restarting Home Assistant is safe.** The add-on stays up and waits: HTTP degrades to 502
  while core is down, then it reconnects, rebuilds, and open dashboards recover on their own.
  Same at host boot, when the add-on starts before core is listening.
- Cards can still show "unavailable" if a filter type isn't supported yet — currently `not`,
  `and`, `or`, `floor`, `device_manufacturer`, `device_model`, `last_changed`. List those
  entities in `always_forward` and open an issue.
- A **local** add-on bakes the code into its image at build time, so updates need a
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
- 🏷️ **Every setting now explains itself** right in the add-on's Configuration tab
- 📊 **A stats panel in your HA sidebar.** See what it is actually saving you — connected panels, before/after sizes per dashboard, live traffic — instead of only finding out when something looks wrong. There is a `stats.json` behind it too, so you can graph any of it with a `rest` sensor

### 0.2.3

- **auto-entities globs and regexes work on every filter key** — `/^sensor\.pv_.*_power$/`
  and friends resolve instead of matching nothing, on `domain` / `area` / `label` / `device`
  / `integration` / `name`, not just `entity_id`.
- **`filter: template:` cards resolve** — rendered through HA rather than skipped.
- **Group members are pulled in transitively**, so cards that expand a group client-side
  (`show_group_members`) stop showing their members as "unavailable".
- **Fixed 400 Bad Request behind another reverse proxy** — the `X-Forwarded-For` chain is
  preserved, so Caddy / nginx / Traefik in front of the add-on works.
- **Open dashboards pick up new entities by themselves** — no more reloading every wall panel
  after a dashboard edit.

### 0.2.2 — important if you're upgrading from ≤ 0.2.1

- **An empty allowlist is never forwarded as "no filter" again.** HA reads
  `set(msg["entity_ids"]) or None`, so an empty `entity_ids` meant *no filter at all* — and
  because `dashboards` used to default to the author's own dashboards, a fresh install
  resolved nothing and relayed **every entity on the instance**, the exact opposite of the
  point. `dashboards` now defaults to `[]` and the websocket is refused (with the reason
  logged) rather than sending an empty filter.
- **Surviving an HA restart** — the add-on no longer crash-loops when core goes away.

### 0.2.0

- **auto-entities `area` / `label` / `device` / `integration` filters resolve** against the
  registries, so you don't have to hand-list them in `always_forward`.
- **Configurable `port` option** — coexist with other add-ons on busy hosts.
- **Recompute logs the `+added` / `-removed` entity diff**, not just the total.
- **Defensive egress filter** re-filters `subscribe_entities` event payloads to the
  allowlist on the way to the browser — a belt-and-suspenders guarantee the firehose can't
  leak even if a future HA ignored the subscription filter.
- Added a test suite (`cd websocket-stripper && npm test`): unit tests for the extractor +
  registry resolver, and integration tests that run the real proxy against a mock HA.
