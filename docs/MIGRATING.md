# Migrating an existing configuration

**Short version: you do not have to do anything.** Every old option name is still read, every old
override list still works, and an existing `configuration` block keeps behaving exactly as it did.
Nothing below is required — it is here for when you want the newer names and the console.

That is deliberate. Silently ignoring a renamed key is the worst thing an upgrade can do: the
setting appears to be there, the default quietly takes over, and nothing says so.

---

## Renamed options

Each old name is still read. Where a config carries **both**, the new name wins.

| Old | New | Why |
|-----|-----|-----|
| `strip_entities` | `trim_entities` | It was the one option doing the central trim that was not called `trim_*`. |
| `per_dashboard` | `by_dashboard` | The old name described the mechanism; the new one describes the effect — serve each connection the dashboard it is actually viewing. |
| `port` | `proxy_port` | Which port? This one is where browsers and panels connect. |
| `stats_port` | `mgmt_port` | It stopped being only statistics once the console could change configuration. |
| `host:` *(inside an override rule)* | `entrypoint:` | "Host" already means three things here: the Home Assistant being proxied *to*, the machine this runs *on*, and the hop in front of it. |

Two of these are worth a moment's thought rather than a blind rename:

- **`strip_entities: false`** is a deliberate choice — it turns the app into a pass-through for an
  A/B comparison. If the old key had been made inert, trimming would have switched back **on** for
  exactly the people who had turned it off.
- **`per_dashboard: false`** is deliberate for panels that navigate between dashboards without
  reloading. An inert key would have re-scoped those connections and blanked half their cards until
  someone reloaded.

Both still work. If you rename them, keep the value.

---

## Override rules: four lists became one

`dashboard_overrides`, `user_overrides`, `client_overrides` and `user_agent_dashboards` still work
and are read into the unified `overrides` list at startup. They existed as four keys because rules
are evaluated at four different moments — not because they were four different kinds of thing.

The unified list lets one rule carry **several** matchers, which none of the old keys could
express.

### Before

```yaml
dashboard_overrides:
  - dashboard: hallway-kiosk
    always_forward: ["input_boolean.hallway_night_mode"]

user_overrides:
  - user: David Coulson
    dashboard: lovelace
    always_forward: ["/^update\\./"]

client_overrides:
  - client: 10.2.4.109
    devices: ["Basement Stairs Panel"]

user_agent_dashboards:
  - match: io.robbie.HomeAssistant
    dashboard: lovelace
```

### After

```yaml
overrides:
  - dashboard: hallway-kiosk
    always_forward: ["input_boolean.hallway_night_mode"]

  - user: David Coulson
    dashboard: lovelace
    always_forward: ["/^update\\./"]

  - client: 10.2.4.109
    devices: ["Basement Stairs Panel"]

  - user_agent: io.robbie.HomeAssistant
    assume_dashboard: lovelace
```

Line for line, the same rules. The gain is that you can now write things the old shape could not:

```yaml
overrides:
  # Whoever is an administrator, rather than a named person. Keeps working when admins change.
  - role: admin
    always_forward: ["/^update\\./"]

  # Every Kiosk Satellite panel, with no addresses to maintain as DHCP moves them.
  - mdns_kind: Kiosk Satellite
    always_forward: ["/^assist_satellite\\./"]

  # Anything logged in through trusted networks, arriving via the IoT entry point.
  - auth_provider: trusted_networks
    entrypoint: home-iot.example.org
    never_forward: ["/^camera\\./"]
```

### The one that is usually worth rewriting

A per-user rule naming a person is very often approximating a role:

```yaml
# Before: stops covering a new admin, and keeps covering David if he stops being one.
user_overrides:
  - user: David Coulson
    always_forward: ["/^update\\./"]

# After: says what you meant.
overrides:
  - role: admin
    always_forward: ["/^update\\./"]
```

---

## Moving configuration into the console

From the **Config** tab in the app's sidebar panel you can change most options without editing
YAML. Ownership is **per option**: an option is read from the console only when you deliberately
change it there, and everything else still comes from the add-on's Configuration tab.

- Taking a setting over **never changes it** — it is seeded from whatever is already in effect.
- **Use add-on config** hands it back.
- Options are read once at startup, so a change takes effect on the next restart.

**Setup options stay in YAML on purpose** — `proxy_port`, `mgmt_port`, `ha_base`, `allow_ws_url`,
`log_level`. How the process binds and finds Home Assistant has to stay fixable from Home Assistant
when the console is the thing that is broken.

There is **no bulk import**, and that is intentional. A wholesale switch would mean editing the
Configuration tab afterwards and watching it do nothing, with no indication why.

---

## Things that changed behaviour, not just names

Worth reading even if you rename nothing.

### The console's own port serves less than it did

`/access.json`, `/entities.json`, `/devices.json`, `/config.json` and `/history.json` now require
Ingress — open the panel from the Home Assistant sidebar. `/stats.json` is still served on the
plain port but with identities removed: counts, savings and allowlist sizes stay, the per-client
list and discovered device names do not.

**If you poll `stats.json` from a `rest:` sensor it keeps working**, as long as you depend on
aggregates (`allowlist.ready`, `allowlist.union`, `savings`) and not on `clients.list`.

The reason is `/access.json`: Home Assistant puts credentials in request **paths** as well as query
strings, so a request log holds webhook ids and signed camera-stream tokens. Query strings were
always stripped; paths were not.

### Font stylesheets are no longer always dropped

If `trim_resources` is on, a CSS resource used to be dropped for every dashboard, because it names
no custom element for the card matcher to match. It is now kept for a dashboard that asks for one
of the families it declares — in the dashboard config, in a `card_mod` block, or **in a theme it
uses**, which is where fonts usually live.

A `@import url(...)` inside a card's own `card_mod` CSS is **not** a Lovelace resource: the browser
fetches it while rendering the card, so this app never sees it and can neither keep nor drop it. If
you want that font local, download it and point the import at `/local/...`.

### Panels keep their dashboard across a restart

The hint that attributes a connection to a dashboard now survives a restart, so panels no longer
fall back to the union until something makes them reload. Nothing to configure.

---

## Checking it worked

The startup log counts your rules by matcher:

```
overrides: 4 rule(s) — 2 keyed to a user, 1 to a role, 2 to a device, 2 to a dashboard,
           0 to a client app, 1 to a device kind, 1 to an entry point, 0 to a sign-in method
```

If a rule is missing from that count it was **dropped for having no matcher**, which is also
logged. A rule that matches nothing is not an override — that is what the global `always_forward` /
`never_forward` lists already are.

The **Clients** tab then shows what each connection was actually attributed to, and how — cookie,
IP or user-agent — which is the fastest way to see whether a rule is reaching the panel you meant.
