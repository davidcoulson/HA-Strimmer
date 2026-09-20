# Client status API

How a panel asks Strimmer what it is doing, and what that is worth on this
connection.

> Available from **2026.09.15.21**. **Requires a Home Assistant access token from 2026.09.15.25.** Additive schema.
>
> A standalone, styled version of this page is at [`client-api.html`](client-api.html) — open it
> in a browser if you would rather read it that way, or send it to someone who is not working in
> this repo.

Strimmer is a reverse proxy in front of Home Assistant that trims the entity websocket and
several HTTP payloads down to what each dashboard actually uses. This endpoint exists so a panel —
ha-paneld, Kiosk Satellite, anything else sitting in front of HA — can render an admin or
diagnostics screen: *is the trimmer in front of me, what is it cutting, and what is it saving me.*

```
GET http://<your-ha-host>:9123/strimmer/client.json
```

Port 9123 is Strimmer's default proxy port — the same host and port the panel already loads
dashboards from. **Use whatever base URL the panel is configured with; do not hardcode 9123.**

> **The old path still answers.** This endpoint was `/stripper/client.json` before the project was
> renamed, and that path remains a permanent alias — a panel written against it keeps working and
> gets the same reply. New clients should use `/strimmer/client.json`.

## Stability

This endpoint is meant to be built against. What that commitment is, precisely:

**Will not change without being called out in the release notes:**

- what a field means — a name is never reused for something else
- the detection semantics below: `200`, `401`, `403`, `404`
- authentication by Home Assistant bearer token
- the path, `/strimmer/client.json` — and `/stripper/client.json`, which keeps answering
  permanently rather than being retired at some later version

**Will change, and your client must tolerate it:**

- **new fields**, anywhere in the payload. The schema is additive — do not validate strictly, and
  do not fail on a key you have not seen.
- **new keys in `trimming`** as options are added. Render it by iterating the object, not by
  reading a fixed list of names.
- **new `4xx`/`5xx` codes**. Treat an unrecognised non-2xx as *"the trimmer is there and did not
  answer"*, not as *"the trimmer is gone"* — that distinction is the whole point of the table
  below, and getting it wrong turns a transient refusal into a false "offline".

**Versioning.** `strimmer.version` (the payload key predates the rename — see below) is the add-on's
own date-based version (`2026.09.15.32`), which sorts lexically. There is no separate API version:
the payload tells you which build answered, and that is the thing to log when something looks wrong.

### Breaking changes so far

Both landed on 2026-09-15, and both are behind you if you are building against a current release:

| Version | Change | What broke |
|---------|--------|------------|
| `2026.09.15.25` | Authentication required | A client sending no `Authorization` header started getting `401`. |
| `2026.09.15.26` | Access list added | A remote caller can now get `403` where it previously got an answer. Local callers are unaffected — the default is `lan`. |

Nothing else has changed shape since the endpoint shipped in `2026.09.15.21`. **Treat the
authentication requirement as the last breaking change**; anything further of that kind would be
called out as such rather than slipped into a point release.

## Detection: reaching it is the proof

A panel cannot tell from a dashboard page alone whether Strimmer served it or whether it is
talking straight to Home Assistant. It does not need a header to find out.

This path is served **by the proxy itself and never forwarded**. So:

| Result | Meaning |
| --- | --- |
| `200` | Strimmer is running **and is in the path** for this panel. Both halves of the question, answered by arriving. |
| `401` | Strimmer IS in the path, but your token is missing or Home Assistant did not accept it. Still a positive detection — treat it as "present, not authorised". |
| `403` | Strimmer IS in the path, but it does not answer callers from where you are. Also a positive detection. The `error` field says why — typically the request arrived from the internet or through Cloudflare, and the instance is set to answer local callers only. |
| `404` | You are talking to Home Assistant directly. HA has no such route. |
| connection error | Neither is reachable — a network problem, not a Strimmer problem. Say so differently. |

## Who may ask

Separately from the token, the instance decides which callers it answers at all — `lan` (default),
`any`, or `off`. A refusal here is a `403` and happens **before** the token is checked, so a remote
caller cannot make the add-on validate a token on its behalf.

Practically: a panel on the same network is unaffected. A panel reaching Home Assistant from
outside, or through Cloudflare, will get `403` unless the operator sets `client_api_access: any` or
lists its address in `client_api_allow`. If you ship an admin screen, say "this Home Assistant does
not answer status requests from here" rather than treating it as an outage.

## Authentication

Send the panel's own Home Assistant access token:

```
Authorization: Bearer <the panel's HA access token>
```

There is no separate secret to provision. The token is validated against Home Assistant and the
result is cached for ten minutes, so an admin screen refreshing does not cost a round trip each
time.

This port is reachable by anything on the network and has no other authentication in front of it.
Even though the reply is small — booleans and the caller's own figures — there is no good reason
for a device that cannot log into Home Assistant to learn which dashboard a panel is on, how many
entities it is served, or how much traffic it moves.

A browser calling this cross-origin will **preflight** because of the `Authorization` header; the
endpoint answers `OPTIONS` with `Access-Control-Allow-Headers: authorization`.

**Why not a header on the dashboard load?** It was considered and rejected. Adding bytes to the
response every panel fetches on every boot, to carry a snapshot taken *before the websocket even
exists*, is a poor trade for a screen that is read occasionally. The pull costs nothing until
someone opens the admin screen — and it returns live numbers rather than boot-time ones.

## The response

A real reply, from a panel with two open connections:

```json
{
  "strimmer": {
    "running": true,
    "version": "2026.09.15.21",
    "uptime_sec": 26
  },
  "stripper": {
    "running": true,
    "version": "2026.09.15.21",
    "uptime_sec": 26
  },
  "trimming": {
    "entities": true,
    "by_dashboard": true,
    "registries": true,
    "resources": true,
    "extra_modules": true,
    "services": true,
    "repairs": true,
    "themes": false,
    "translations": true,
    "compress_websocket": true
  },
  "client": {
    "ip": "10.2.3.42",
    "connections": 2,
    "dashboard": "office-tablet",
    "attributed_via": "cookie",
    "entities_served": 88,
    "first_payload": {
      "entities": 88,
      "bytes": 27726,
      "ms_to_data": 391,
      "drain_ms": 1
    },
    "traffic": {
      "from_ha_bytes": 637568,
      "to_browser_bytes": 183599,
      "not_sent_bytes": 453969,
      "not_sent_pct": 71,
      "update_bytes_per_min": null
    },
    "connected_sec": 21
  }
}
```

### `strimmer` (and `stripper`)

Two keys, one object, byte-identical. `strimmer` is the name to read; `stripper` is what the key
was called before the rename and is emitted beside it permanently, because the stability
commitment above rules out breaking a client that already reads it. New code should use
`strimmer`; nothing has to change to keep working.

| Field | Type | Meaning |
| --- | --- | --- |
| `running` | bool | Always `true` when you get a reply. Present so the payload reads correctly when cached or logged. |
| `version` | string | Build in front of this panel, e.g. `2026.09.15.21`. Date-based, sorts lexically. |
| `uptime_sec` | int | Seconds since Strimmer started. A small number here explains a panel that just reconnected. |

### `trimming`

What is being cut, as booleans. Every key is a boolean — no lists, no rules, no names. Suitable
for a row of indicator chips.

| Key | What it cuts |
| --- | --- |
| `entities` | The entity websocket itself — the core feature. If this is `false` Strimmer is a plain pass-through. |
| `by_dashboard` | Serves each connection only the dashboard it is viewing, rather than the union of every configured dashboard. |
| `registries` | Entity, device and area registries. |
| `resources` | Lovelace resources (custom cards). |
| `extra_modules` | JavaScript integrations inject into every page via `add_extra_js_url`. |
| `services` | The `get_services` list. |
| `repairs` | The admin Repairs backlog. |
| `themes` | Themes other than the ones a dashboard names. |
| `translations` | Frontend translations for integrations this connection cannot see. |
| `compress_websocket` | Not a trim — whether permessage-deflate is negotiated with the browser. |

### `client`

The caller's own numbers. **The subject is always whoever asked.**

| Field | Type | Meaning |
| --- | --- | --- |
| `ip` | string | The address Strimmer sees you as. Useful for diagnosing a panel behind an unexpected NAT or proxy hop. |
| `connections` | int | Open websockets from this address. `0` is a real answer — see below. `2` briefly during a reload. |
| `dashboard` | string \| null | The dashboard `url_path` this connection was attributed to. `null` means it could not be attributed and is being served the union. |
| `attributed_via` | string \| null | How that was decided — `cookie`, `ip`, `user-agent`. Diagnostic: a panel landing on the union usually shows `null` here. |
| `entities_served` | int \| null | Size of the allowlist this connection is being served. The headline number for a panel admin screen. |
| `first_payload` | object \| null | The initial entity delivery: `entities`, `bytes`, `ms_to_data` (time from connect to first entity data) and `drain_ms`. Good for a boot-performance readout. |
| `traffic` | object \| null | Byte totals across this address's open connections — see below. `null` when there are none. |
| `connected_sec` | int \| null | Age of the newest connection. |

### `client.traffic`

| Field | Meaning |
| --- | --- |
| `from_ha_bytes` | Received from Home Assistant for this client. |
| `to_browser_bytes` | Actually forwarded to it. |
| `not_sent_bytes` | The difference: what this connection was spared. Never negative. |
| `not_sent_pct` | Same as a percentage, or `null` before any bytes have moved. Do not compute your own from a zero denominator. |
| `update_bytes_per_min` | Live update throughput. `null` until a connection is a full minute old — a rate extrapolated from four seconds is that connection's opening burst multiplied by fifteen, not a measurement. Render `null` as "—", not as zero. |

> **`not_sent` is not the same as Strimmer's headline "saved" figure.** It is the difference
> between two measured totals on *your* connections. The panel's own savings statistic is computed
> differently, over trimmed request/response payloads where a real before-and-after exists. Do not
> present the two as the same number.

## `connections: 0` is meaningful

You reached the proxy over HTTP, so it *is* in your path — but it has no open websocket from your
address. That is a different state from "not behind the trimmer", and worth showing differently.
It usually means the panel has not opened its websocket yet, or is connecting from a different
address than it fetches from.

In that state `dashboard`, `entities_served`, `traffic` and `first_payload` are all `null`.
`strimmer` (and its `stripper` twin) and `trimming` are still fully populated.

## What this endpoint will never tell you

The proxy port is reachable by anything on the network and has **no authentication in front of
it**. Every field is therefore something that network may read. Deliberately absent, and covered
by tests (`test/client_info.test.mjs`) that fail if any of it appears:

- Override rules of any kind, and the config keys that hold them.
- Allowlist contents — no entity ids, ever.
- Home Assistant user identities. A panel is not told which user it is logged in as.
- Any other client's address, hostname, dashboard or statistics.
- Dashboard lists, always/never lists, mDNS names, certificate hosts.

There is also **no way to name a different subject** — no `?ip=`, no header override. If there
were, any device on the network could enumerate every panel from an unauthenticated port.

> **Do not build anything security-sensitive on this.** It is unauthenticated diagnostics. Treat it
> as advisory: render it, do not gate behaviour on it. And do not relay it off the local network.

## Using it

Fetch on demand, when the admin screen opens. It is cheap but not free — it takes a stats snapshot
per call.

```js
async function strimmerStatus(haBaseUrl, haAccessToken) {
  try {
    const res = await fetch(new URL('/strimmer/client.json', haBaseUrl), {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${haAccessToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (res.status === 404) return { state: 'not-in-path' };
    // The trimmer IS in front of you; the token is the problem.
    if (res.status === 401) return { state: 'unauthorised' };
    // Present, but not answering callers from here. Read `error` for the reason.
    if (res.status === 403) return { state: 'blocked', reason: (await res.json()).error };
    if (!res.ok) return { state: 'error', status: res.status };
    return { state: 'ok', data: await res.json() };
  } catch {
    return { state: 'unreachable' };
  }
}
```

### Rules of engagement

- **Do not poll on a timer from a dashboard.** This is an admin screen. Fetch on open, and on an
  explicit refresh.
- If you must refresh automatically while the screen is visible, **30 seconds is plenty**, and stop
  when the screen is hidden.
- **Set a short timeout.** A panel's diagnostics screen should not hang because the proxy is busy.
- **Ignore unknown fields.** The schema is additive: new keys will appear, and existing ones will
  not change meaning. Do not validate strictly.
- **Handle `null` everywhere in `client`.** Every field there can be `null`, and `null` means "not
  known", never zero.
- CORS is open (`Access-Control-Allow-Origin: *`) so a panel admin page served from its own origin
  can read it.

### A reasonable admin panel

- **Status line.** "Trimmed by Strimmer 2026.09.15.21" — or "Not behind the trimmer" on a
  404. That one line is most of the value.
- **What it is cutting.** The `trimming` booleans as chips. Showing only the `true` ones and a count
  of the rest keeps the row short.
- **This panel.** `entities_served` and `dashboard` — "88 entities, office-tablet". This is the
  number people actually want.
- **What it saved.** `not_sent_pct` with the byte totals underneath.
- **Boot.** `first_payload.ms_to_data` and `bytes`, if the panel already reports boot timings.

---

Questions and schema additions welcome via an issue on
[davidcoulson/HA-Strimmer](https://github.com/davidcoulson/HA-Strimmer).
