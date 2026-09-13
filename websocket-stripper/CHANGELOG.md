# Changelog

## 2026.09.13.14 — 2026-09-13

**Fixed: the traffic panel double-counted every batched frame, and sized it wrong.**

Home Assistant packs messages into a JSON array. `m.type` is `undefined` on an array, so a
batched frame was labelled once in the array branch and then fell through **every** branch of the
labelling chain into the catch-all `(no type field)` bucket — producing two rows for one frame.

The live panel proved it arithmetically:

```
batched event:entity-diff+result   n=15
batched event:entity-diff          n=140
batched result                     n=10
                                   ---
                                   165
(no type field)                    n=165     <- exact match
```

`(no type field)` was never unexplained traffic. It was the same 165 frames counted again,
carrying **2.78MB** that was not a distinct payload. That bucket exists to surface genuinely
typeless objects — the thing you actually want to know about — and it was drowned in phantoms.

**Second defect in the same place:** the array branch recorded `inBytes` while every other path
records `outBytes`. Batched frames were therefore reported at their **pre-trim** size, so the
largest row in the table was measuring something different from every row beside it. On the live
instance that read as **17.30MB across 15 messages** — 1.15MB per frame, against a measured
cold-start entity payload of about 50KB.

Both are fixed: a batched frame is now recorded exactly once, in `done()`, at the size that
actually went to the browser. The regression test was verified to fail without the fix.

Nothing about what the add-on *sends* changes — this is purely what it reports about itself. But
a panel that exists to explain where the bytes go should not invent 2.78MB and misreport its
biggest row by an order of magnitude.


## 2026.09.13.13 — 2026-09-13

Version bump only, to force Supervisor to re-read `config.yaml`.

Supervisor caches an add-on's **options schema** separately from its code. A `rebuild` picks up
new code but leaves the cached schema in place, so a newly added option is silently dropped from
any write — `ignored_fields` in the response, no error. A version transition is what makes it
re-read the schema, so `exclude_device_categories` (added in `.12`) needs this to be settable.

No functional change.


## 2026.09.13.12 — 2026-09-13

**New: `exclude_device_categories`, and every device expansion now reports its own split.**

Expanding a device pulls in everything it owns, and a device owns far more than a card renders.
A Litter-Robot 4 measured here carries **21 entities** — the vacuum, waste drawer, litter level
and pet weight, but also panel brightness, globe brightness, a reset button, a firmware update,
last-seen, status code and power status. A card rendering a fill percentage needs a handful.

Home Assistant already labels the difference. `config` marks controls that configure the device;
`diagnostic` marks readings about its health. `exclude_device_categories` drops either or both
whenever a device is expanded — by a card configured with a device, or by a `client_overrides`
rule.

**It is empty by default, and that is deliberate.** Whether a given card renders `status_code` is
not knowable from outside the card, and a wrongly dropped entity blanks part of it with no error
anywhere — the same silent failure mode this add-on has had to fix three times already.

So instead of guessing, every device expansion now **logs its own breakdown**:

```
card names device "Robot 1": +21 entities (12 primary, 6 config, 3 diagnostic)
client rule 10.2.4.109: device "Basement Stairs Panel" -> 21 entities (14 primary, 7 config, 0 diagnostic)
```

Read the real numbers for your own devices, then decide. A saving you can see before you take it
is worth more than a default that quietly breaks a card.

Also considered and rejected: inferring the entities from the card's own JavaScript bundle. The
add-on already reads bundles for `trim_resources`, but that works because a *card type name* is a
literal string. Which entities a card renders is resolved at runtime from a device id, by
`unique_id` suffix or translation key, and may be built dynamically — so a miss is silent and
invisible. Entity categories come from Home Assistant and require no inference at all.


## 2026.09.13.11 — 2026-09-13

**New: `client_overrides` — entity rules pinned to a physical device, not to a dashboard.**

Some entities belong to the machine in front of you rather than to whatever page it is showing.
A **browser-based voice satellite** is the clearest case: `assist_satellite.office_panel` and its
twenty siblings are only ever useful to the one panel that *is* that satellite. Scoping them to a
dashboard is wrong in both directions — the panel loses them the moment it navigates somewhere
else, and every other client opening that dashboard pays for entities it can never use.

```yaml
client_overrides:
  - client: 10.2.4.109          # an IP, a CIDR, or a hostname
    devices: ["Office Panel"]   # the whole device, by registry name or id
    always_forward: []          # patterns, same syntax as everywhere else
    never_forward: []
```

`devices` names whole **devices** rather than listing entity ids, deliberately: a voice satellite
integration adds entities between releases, and a rule that must be re-edited to keep working is
a rule that silently stops working. The measured device here owns 21 entities across six domains.

`client` accepts an IP, an IPv4 CIDR (`10.2.4.0/24`) for a whole VLAN of panels, or a hostname.
Hostnames are resolved when the allowlist is built — not per connection, which would put a DNS
round trip in front of every websocket upgrade — so a moved DHCP lease is picked up on the next
rebuild. A lookup that fails logs and leaves that one rule inactive rather than failing the
build. Note that mDNS/`.local` names generally do **not** resolve from inside the container; use
a real DNS record, which a UniFi client reservation can supply.

Rules apply on top of whichever dashboard set was chosen, **and whether or not the dashboard
could be attributed at all** — that is the point of pinning to a device. `never_forward` still
wins last, consistent with every other override block. The widening is logged
(`+client rules (149 -> 170)`) so a pin is visible rather than mysterious.


## 2026.09.13.10 — 2026-09-13

**Fixed: a card configured with a *device* instead of entities had all of them stripped.**

Some custom cards are configured by pointing at a device and look up that device's entities
themselves, in the browser. `custom:ha-bambulab-print_status-card` is configured as
`printer: 43f1e9fddd670256ced58c9fe7971e41` — a device id. Nothing anywhere in that card config
is an `entity_id`, so the structural walk found none.

Measured on the instance this was found on: the dashboard carrying it resolved to **2 entities**
(its two lights), and the printer's **57 entities were all stripped**. The card then renders with
nothing in it — which reads as a broken card, not as a trimming problem, and that is what makes
this worth fixing rather than documenting.

Device ids were already understood as an auto-entities *filter key* (`device:`). They were not
understood as a value sitting on an ordinary card.

The fix matches on the **value**, not the key. The key name cannot be predicted — `printer`
here, something else on the next card — so any string that is a **registered device id** expands
to that device's entities, wherever it appears in the card tree, including inside lists and
nested stacks. Shape alone is never enough: a 32-hex string that is not in the device registry
adds nothing, which makes a false positive essentially impossible.

This deliberately admits the device's whole entity set rather than guessing which subset the
card renders, because the card's internals are not knowable from here and the failure modes are
not symmetric — a few entities too many costs bandwidth, while one missing silently empties a
card on a wall panel with no error anywhere.

## 2026.09.13.09 — 2026-09-13

**Fixed: the connection-timing panel was reporting a payload size it had not measured.**

`initialPayloadBytes` sized the whole websocket *frame* the initial entity block arrived in.
Home Assistant batches messages into a JSON array, so that number silently absorbed whatever
else was bundled alongside — sometimes `lovelace/config` and the registries, sometimes nothing
at all.

Caught by reading the live panel rather than the code: two clients on the **same dashboard**
with the **same 149-entity allowlist** reported **246 KB** and **1.5 KB**, a 164× spread. A
third reported a 447-byte "full entity payload" for a 104-entity dashboard, which is not
physically possible. The measurement now sizes the `a` block itself and ignores the batch.

**`initialEntityCount` is new, and is reported beside the bytes on purpose.** A byte count on
its own cannot be checked by the person reading it. "447 B / 3 entities" next to a 104-entity
allowlist is visibly a partial first block; "447 B" alone just looks like a very fast dashboard.

**The panel also stops overstating what these numbers mean.** It previously called *Ready in*
"most of what a person experiences as the dashboard coming up" and *On the wire* "the dominant
term on a phone over cellular". Neither survives measurement:

- *Ready in* is dominated by how long the **frontend** takes to get around to subscribing — auth
  handshake, JavaScript parse — not by moving the payload. A LAN wall panel took **671 ms for
  1.5 KB** while a phone on 5G took **207 ms for 215 KB**.
- *On the wire* measures handoff to the kernel socket buffer, not receipt by the device. A
  215 KB payload "drained" in **6 ms** over cellular — far quicker than that link can physically
  carry it. The buffer simply swallowed it.

Both are now labelled as diagnostics, in the panel and in the code, with the caution that
neither should be quoted as a speed. They are still worth having: they are the only view of a
native companion-app socket, which no browser tooling can see at all. They are just not a
benchmark, and the panel no longer implies they are.

## 2026.09.13.08 — 2026-09-13

**Fixed: an infinite redirect loop behind your own HTTPS reverse proxy.**

If you put Caddy, nginx or Traefik in front of the add-on to terminate TLS, pages never
loaded and the URL degenerated into `.../:8123./:8123./:8123./...`. Two separate defects, both
caused by `http-proxy`'s `autoRewrite`:

1. It rewrites a redirect's **host** but never its **scheme**. `changeOrigin` makes Home
   Assistant see the request as arriving at its own address, so its absolute redirects name
   that address. `autoRewrite` corrected the host and left the scheme alone — so the browser
   was sent from `https://your.host/…` to `http://your.host/…`, the edge proxy bounced it
   straight back to HTTPS, HA reissued the same redirect, and round it went.
2. Absolute URLs **inside query parameters** were never touched, so the auth flow's
   `redirect_uri` still pointed at HA's internal LAN address — unreachable from outside.
   That is the half that broke logging in remotely.

`autoRewrite` is now off, and the rewrite is done properly in a `proxyRes` handler: scheme
and host together, plus `redirect_uri` and `hass_url`. Relative redirects stay relative,
genuinely third-party redirects are left alone, and a **custom-scheme `redirect_uri` — which
is how the iOS and Android companion apps complete authentication — is explicitly preserved**
rather than mangled into an https URL the app cannot follow.

The scheme and host are read from the **first** entry of `x-forwarded-proto`/`-host`, because
`xfwd` appends our own hop (Caddy's `https` arrives as `https,http`).

Credit where it is due: this was root-caused and fixed by the upstream maintainer
(GabrielGoldsteinAnidea) on a branch that was never merged, so this fork carried the bug
despite being well ahead of upstream otherwise. Cherry-picked here with authorship intact;
the only change was the version number, upstream having called it `0.2.4-rc1`.

Reported in upstream issues #9 (genik70, dimatx) and #8 (companion app).

## 2026.09.13.07 — 2026-09-13

**Every connection now reports how long it took to become useful.** Three numbers per client,
in `stats.json` and on the panel:

- `initialPayloadBytes` — the first full entity dump, i.e. the payload a dashboard cannot
  render without, and the part this add-on shrinks.
- `msToEntityData` — websocket upgrade to that payload written out. Most of what a person
  experiences as the dashboard coming up.
- `initialDrainMs` — how much of that was the link itself. Near zero on a LAN; the dominant
  term on a phone over cellular.

This exists so "is it actually faster" has an answer that is not an opinion, and so it can be
answered for clients that cannot be instrumented from outside at all — the iOS and Android
companion apps open a native websocket and never load a page, so no browser tooling can see
them. The add-on already sits in the middle of that socket, so it measures it directly.

Recorded once per connection, on the cold-start payload only: a later re-subscribe is a
different event, and averaging them together would destroy the number this exists to report.

First measurement from a live instance, same dashboard and the same ~44KB payload over two
different paths: **28ms on the LAN, 134ms arriving over the internet through Cloudflare.** The
payload is identical, so the difference is entirely the link — which is the whole argument for
trimming it before it goes out.

One honest limitation, also stated on the panel: "on the wire" means handed to the network
stack, not acknowledged by the device. It tracks link speed and backpressure well, and it is
not a round-trip measurement.

## 2026.09.13.06 — 2026-09-13

**Fixed: a per-user rule was applied to an allowlist that was never sent.**

The proxy holds a connection's messages until the user is resolved, so that per-user rules can
widen the allowlist before the frontend subscribes. But `subscribe_entities` was rewritten
with the allowlist at the moment it was *queued* and then flushed verbatim — so whenever the
user lookup was slower than the frontend's first subscribe, Home Assistant received the
**pre-rules** entity list and the rule was silently discarded. The gate preserved ordering and
lost content.

Nothing logged a problem: the add-on still reported `user rules applied`, because it had
applied them — to an allowlist nobody used. From outside, a rule simply worked on some
connections and not others, with no way to tell which. Entities granted by a per-user rule
would be present after one reconnect and missing after the next.

The held payload is now built when the message is sent rather than when it is queued. The
empty-allowlist refusal moved with it, so a `never_forward` rule that narrows the list while
the message is held is still caught.

**New: connections record how they reached the add-on.** Each client now reports an `origin`
(`lan` / `internet`), a `route` (`direct`, `proxy`, `cloudflare`, `ingress`), the hostname it
dialled, and the immediate peer address — with lifetime tallies under `paths` in `stats.json`
and a "How clients reach this" table on the panel. This answers "is anyone actually using the
remote path, and through which front door" without touching a reverse-proxy log.

It is **reporting only**. Every signal except the peer address is a request header, so none of
it is trustworthy enough to make access decisions with; making it trustworthy would need a
configured list of trusted hops, which does not exist here. See the header of `route.mjs`.

Also fixed a latent attribution bug found on the way: a reverse proxy that sets only
`X-Real-IP` and no `X-Forwarded-For` had all of its clients attributed to the proxy's own
address — one bucket, every device — which silently degraded per-dashboard attribution to
whichever client loaded last.

## 2026.09.13.02 — 2026-09-13

**Per-user `always_forward` / `never_forward`,** via a new `user_overrides` option — the one
thing per-dashboard rules cannot express: two people opening the *same* dashboard who should
not be served the same entities.

Identity comes from the browser's own access token, which is already the first thing it sends,
resolved against HA's `auth/current_user`. The lookup runs on a separate short-lived
connection because Home Assistant enforces strictly increasing message ids per connection, so
injecting it into the browser's own socket could collide with an id the frontend uses later.
Results are cached by a hash of the token — never the token — for ten minutes.

Messages after `auth` are held in order until the lookup returns, because letting a later
message overtake an earlier one would break that same id rule. A failed or slow lookup applies
no rules rather than failing the connection, and with `user_overrides` empty no lookup is ever
made.

## 2026.09.13.01 — 2026-09-13

**Per-dashboard `always_forward` / `never_forward`,** via a new `dashboard_overrides` option.

`always_forward` is global, which is the right shape for something every dashboard needs — a
clock, an Assist pipeline — and the wrong shape for something one dashboard needs. Forcing
`update.*` in globally so an admin dashboard could show a pending-updates count added **252
entities to a wall panel showing four lights**, giving back most of the trimming.

Per-dashboard rules layer on top of the global ones. The global `never` list still wins last:
it is a statement about the whole instance, so a per-dashboard `always` must not override it.

## 2026.09.12.22 — 2026-09-12

**Fixed: every trim was bypassed for batched frames.** Home Assistant packs several messages
into a single JSON array, and all the trimming was written against the top-level object — so a
batched frame skipped `get_states`, all four registries, `get_services`, resources and the
egress event filter alike.

Measured: **13.5MB of untrimmed registry on every connection** to a panel trimmed to 104
entities, while `trim_registries` was on and logging success for the unbatched ones. The logs
said it was working because, for the messages it could see, it was.

The trims now run per message. Batched frames are rebuilt from the surviving, trimmed messages.

## 2026.09.12.21 — 2026-09-12

Removes the investigation-time logging added while tracking the `subscribe_events` leak: it
dumped entity ids and payload samples, which is right for a hunt and wrong to ship. The
throttled "batched state_changed trimmed N -> M" line stays, since that one reports the fix
doing its job.

## 2026.09.12.20 — 2026-09-12

**Fixed: `subscribe_events("state_changed")` bypassed the allowlist completely.**

The egress filter only ever covered `subscribe_entities`. A card using the older
`subscribe_events` path received **every entity on the instance** — the entire firehose, through
the add-on built to stop it. Measured at ~700MB/h to a single wall panel trimmed to 104
entities, in the verbose legacy format that carries full `old_state` *and* `new_state` with
every attribute.

It hid because **Home Assistant batches messages into a JSON array**. Every `m.type` check sees
`undefined` on an array, so batched frames fell through every branch untouched — and landed in
a stats bucket labelled "(unparsed)", which asserted something untrue and sent two
investigations in the wrong direction.

Array frames are now filtered element by element, single frames from the same subscription get
the same treatment, and a frame whose entire contents were disallowed is dropped rather than
forwarded empty.

## 2026.09.12.19 — 2026-09-12

Diagnostic, corrected. The previous one instrumented the JSON-parse failure path, but these
frames parse fine — they are valid JSON with no `type` field, which fell into a catch-all
bucket labelled "(unparsed)" that was actively misleading. Now labelled "(no type field)" and
dumped once with its keys and a sample.

## 2026.09.12.18 — 2026-09-12

Diagnostic: log one sample of any frame that is neither binary nor parseable JSON, throttled,
with its ws binary flag and leading bytes. Such frames are 89% of what a wall panel receives
here and two hypotheses about their origin have already been wrong.

## 2026.09.12.17 — 2026-09-12

**Fixed: binary websocket frames were being corrupted.** Every frame from Home Assistant was
run through `raw.toString()` and forwarded as a string. That is correct for the JSON control
protocol and wrong for binary frames — it UTF-8-decodes arbitrary bytes, which is lossy, and
then re-sends them as a TEXT frame rather than a binary one.

Home Assistant uses binary frames for media. On the instance this was found on, they were
**90% of everything a wall panel received** — 12MB in 68 seconds — passing through mangled.

Binary frames now pass through byte-for-byte in both directions, and are labelled in the
panel rather than falling into an "unparsed" bucket.

## 2026.09.12.16 — 2026-09-12

**The panel now labels every message, not just the ones it trims.** A wall panel trimmed to 104
entities was receiving ~98MB/h, and nothing in the panel could say what it was: the trim
categories only cover payloads this add-on knows how to shrink, so everything else landed in a
total with no breakdown. Results are attributed to the command that asked for them, events to
their event_type.

## 2026.09.12.15 — 2026-09-12

**The history now samples at startup, not only on the interval.** The first bucket used to land
five minutes after boot and the first chart five minutes after that, so a freshly restarted
add-on showed an empty card for ten minutes — a panel that looks broken while working, which is
the precise thing this panel exists to eliminate.

## 2026.09.12.14 — 2026-09-12

**A 24-hour history behind the panel, with charts.** The counters were cumulative since
process start, which answered "what has it done since I last restarted it" and nothing else —
and a restart silently erased the evidence. The panel now shows data not sent, clients
connected, and update traffic over the last day.

Sampled every five minutes into 288 buckets and persisted to `/data`, so a restart costs one
bucket rather than the whole day. Stored as per-bucket **deltas**: a cumulative series goes
backwards across a restart, and a naive difference would emit a large negative bucket. A
counter that decreased is treated as the first sample of a new process, where the reading is
its own delta.

Charts are inline SVG — three sparklines do not justify a dependency, and the page has to stay
self-contained for Ingress. New endpoint: `/history.json`.

The window total reports the span it actually covers, so a panel that has been up for twenty
minutes says so instead of implying a full day.

## 2026.09.12.13 — 2026-09-12

**Default listen port moves from 8099 to 9123** (upstream PR #17). 8099 is the Zigbee2MQTT
add-on's frontend port, so the old default collided with one of the most widely installed
add-ons and the proxy exited on start with `EADDRINUSE` — the worst possible first run. 9123
is self-describing: Home Assistant is 8123, and this sits in front of it.

Only the *default* changes. An install with an explicit `port` option is unaffected.

## 2026.09.12.12 — 2026-09-12

Three corrections to the new panel, all found by deploying it and reading its own output.

**Update traffic counted far more than updates.** A message was filed as event traffic when
it matched none of the four trimmed categories, which swept in `lovelace/config` and every
other untrimmed reply. It now requires `type === "event"`.

**A per-minute rate from a four-second-old connection is not a measurement.** Dividing an
opening burst by a fraction of a minute produced rates in the megabytes. The rate is null
until a connection has a full minute behind it, and the panel renders that as "—".

**The instance size was always zero.** It was learned from a browser's `get_states`, but the
modern frontend subscribes instead of polling and may never send one. Taken from the control
connection's own fetch instead, which asks for every state by definition.

## 2026.09.12.11 — 2026-09-12

**A statistics panel in the Home Assistant sidebar, and a JSON API behind it.** Until now the
only evidence the add-on was doing anything was the log — which you read once something
already looks wrong. The panel shows clients connected and which dashboard each was
attributed to, measured before/after for every trimmed payload, per-dashboard entity and
resource figures, registry cache hits, and live update throughput. Served over Ingress on its
own port (8100), so it needs no configuration and no extra exposed port; the same data is at
`http://<host>:8100/stats.json` for a `rest` sensor or a scrape.

It reports only what it can honestly measure. The trimmed payloads have a real before/after —
the proxy holds HA's full answer and its own trimmed answer in the same function, so "saved"
is a subtraction. The event stream does not: HA filters it server-side from the entity list
the add-on injects, so the untrimmed volume never exists anywhere and cannot be measured. It
is reported as throughput and never folded into the savings total.

**Fixed: a dashboard edit left stale trimmed registries in the cache.** The response cache
added in `.10` is keyed by allowlist version, but only the reconnect path bumped it — a
`lovelace_updated` recompute did not. So after any dashboard edit, connections kept being
answered from registries trimmed to the *previous* allowlist. The growth case was the
damaging one: `applyAllow` recycles every open kiosk precisely so it picks up new entities,
and those reconnections came back to registry rows that omitted them, leaving names and areas
quietly unresolved on exactly the entities just added.

## 2026.09.12.10 — 2026-09-12

**Trimmed registry answers are now cached across connections.** The registries are
per-*instance*: for a given allowlist every client gets byte-identical rows. Each connection
that asked was making Home Assistant serialise the whole thing again — 16k rows and ~10MB of
entity registry here — and this proxy parse it again. A single kiosk load opens several
websockets, so that multiplied into real CPU on the HA host for no new information. A cached
answer is now served locally and never forwarded. Keyed by allowlist version, so a rebuild
retires every entry.

**`trim_services` (default off)** cuts `get_services` to the domains a connection can see.
It is sent on every page load and carries every service of every integration: **193KB across
115 domains**, where only **45 domains** had any entity at all. `homeassistant` is always
kept — its services are domain-agnostic, so dropping it breaks more than it saves. Off by
default for the same reason as `trim_resources`: fine for a kiosk, visibly lossy in the
admin UI.


## 2026.09.12.09 — 2026-09-12

**Per-browser dashboard attribution via a cookie, so NAT stops collapsing clients together.**

The IP hint is shared by every device behind one address. A phone and a laptop on the same
WAN address overwrite each other's attribution, and the loser is served another dashboard's
allowlist until it reloads. That is not an edge case when access goes through a tunnel, where
every remote client arrives from one address.

A dashboard page response now stamps `ws_dash=<url_path>` on the browser, and the websocket
upgrade reads it back. Precedence is **cookie, then IP hint, then the union** — so nothing
regresses for a client that sends no cookie, and the log now names which signal was used
(`serving basement-stairs-panel via cookie`) so a wrong allowlist is diagnosable rather than
mysterious.

The cookie holds the dashboard path itself, not an opaque id, which keeps attribution
**stateless**: there is no server-side map to lose, so the add-on can restart mid-session
without any client losing its scope. A tampered value can only name a dashboard already in
the configured list — a set that client could reach anyway — and an unrecognised one falls
through to the next signal.

Note this solves a different problem from user-based scoping: a user identifies an *account*,
so two devices signed in as the same person still collide. A cookie identifies a *browser*.


## 2026.09.12.07 — 2026-09-12

**The Configuration tab now explains itself.** Added `translations/en.yaml`, so every option
renders with a proper name and description in Home Assistant instead of a bare key like
`resources_always_forward`. The warnings that matter are in the UI now — that
`trim_resources` can fail silently, that `compress_websocket` should be left on, and that
an entity read by panel-side JavaScript needs `always_forward` while one only written does
not. Two tests keep the file in step with the schema in both directions.

**Documentation corrected.** The README and DOCS both still claimed registries and
custom-card resources "pass through untouched", which stopped being true when registry
trimming landed. Both now describe what is actually trimmed, and the README's example config
shows the current options rather than only the original four.


## 2026.09.12.06 — 2026-09-12

An icon namespace is matched **both** as `ns:` (how a user writes it) and as a registration
key, `customIconsets["ns"]` (how the pack that serves it writes it — a provider never writes
the colon form at all). Matching only the colon form dropped `custom-icons.js`, the provider
of `cil:`, from every dashboard.

Fragment distinctiveness is **measured**, not a stop-word list: document frequency across the
resources actually read, with anything in more than a quarter of them disqualified. The first
attempt used a hand-written list, and `grid`, `layout`, `entity` and `progress` slipped
through it and matched nearly every bundle — taking one panel from 2,998KB to 11,876KB, four
times worse than the bug being fixed.

**Icon namespaces are matched with their colon, and card types can match by fragments.**
Two bugs in the resource matcher, found by breaking down what one dashboard was actually
keeping.

*False positives.* A namespace was matched as a bare substring, so the 3-character `cbi`
kept **4,818KB** of bundles that merely contained those letters — inside base64 blobs,
minified identifiers, and one `cbid:`. `cbi:` appeared in none of them. An icon reference
always carries its colon, so that is what is matched now.

*False negatives, hidden by those false positives.* `ha-bambulab-cards.js` is 3.2MB and a
dashboard renders `ha-bambulab-print_status-card` — a string that appears **nowhere** in the
bundle, which builds its element names at runtime. It was being kept only by the accidental
`cbi` hit. Tightening the icon match alone would therefore have broken those cards.

So a card type now matches on its literal name *or*, failing that, on every one of its
distinctive fragments (`bambulab` **and** `print_status`), requiring at least two so a single
generic word can never carry a match on its own.


## 2026.09.12.05 — 2026-09-12

**Resource matching now reads the icons of the entities a dashboard shows, not just its
config text.** An entity's icon normally lives in the entity registry, so a config-only scan
never sees it and drops the icon pack that renders it. Measured here: 20 entities carry
`phu:` icons set in the registry, and the string `phu` appears in no dashboard's YAML.

Without this, keeping those icons working meant pinning the pack in
`resources_always_forward` for every dashboard — 4,571KB on a panel that shows none of
those 20 entities, 60% of its entire resource payload. With it, the pack is kept for the
dashboards that show `phu:` entities and dropped for the ones that don't, automatically.


## 2026.09.12.04 — 2026-09-12

**Resources dropped by *every* dashboard are now called out separately in the log**, with
guidance. That set is the signature of the one failure the documented tuning loop cannot
catch: "load the dashboard and see what looks wrong" finds a card that won't render or an
icon that goes blank, but not a resource that registers no element and is named by no
dashboard, yet runs on load and subscribes to state — an idle timer, a camera pop-up, a
heartbeat. Drop one of those and the dashboard is pixel-identical; only the behaviour stops.

`DOCS.md` names that as a third class needing `resources_always_forward`, alongside frontend
patchers and icon packs, and marks which are loud and which is silent.

Raised by @ajguerre1 reviewing the upstream PR, from production: they lost a doorbell pop-up
on 28 panels for three days to the same failure one level down, where entity scoping stripped
the helpers a resident module read. Home Assistant's half kept working and the chime still
played, so the house sounded normal while the screens did nothing.

The per-dashboard drop detail moved out of the per-dashboard loop into this one block —
previously it printed every dropped URL once per dashboard, which on a six-dashboard instance
was most of the startup log.

**`per_dashboard` is retained here**, unlike on the upstream PR branch where it was withdrawn
in favour of upstream #13. This fork is what the add-on is built from, and #13 is not merged,
so removing it would serve every connection the union instead of its own dashboard.


## 2026.09.12.02 — 2026-09-12

**Per-dashboard Lovelace resource trimming (`trim_resources`, default off).** Resources are
instance-wide in HA: every kiosk downloads, parses and compiles every custom card in the
install. Measured here: **45 resources, 21MB of JavaScript, for a wall panel that renders four
custom card types**. Trimming took that panel to 8 resources / 2.5MB.

Resources are matched by testing each dashboard's custom card types (and non-builtin icon
prefixes) as substrings of the resource body. Scanning for `customElements.define()` is the
obvious approach and the wrong one — large bundles build element names at runtime, so
`mushroom.js` (639KB) exposes almost nothing that way and would be dropped from a dashboard
that needs it.

Off by default, because unlike a dropped entity a dropped resource is *visible*. Every drop is
logged with its size, and `resources_always_forward` rescues frontend patchers and icon packs,
which register no card and so cannot be detected by content. On the panel this was built
against, `kiosk-mode` and the icon packs needed it; with those four restored the dashboard was
pixel-identical to before, with 33 of 45 resources still dropped.

**Honest note on the payoff:** removing 13-18MB of the 21MB did *not* reliably speed the panel
up — 29.1s mean against 31.5s, inside the run-to-run spread. The CPU profile that motivated
this (73% of main-thread busy time unattributed to script, style or layout) does not appear to
have been module parsing after all. The feature is worth having for bandwidth, memory and
sanity on a large install; do not expect it to transform load time.


## 2026.09.11.03 — 2026-09-11

Both of these came out of a byte census of one real kiosk load (2,457.9KB over 72 frames).

**`config/entity_registry/list_for_display` is now trimmed — it is the largest payload the
frontend fetches.** It was passing through whole: 1,437.9KB, 58% of the entire websocket
load, more than everything else combined. The trim missed it because `list_for_display`, in
spite of the name, does not answer with a list — it answers with an object,
`{entity_categories, entities}`, whose rows use two-letter keys (`ei` for entity_id, `di`
device, `ai` area). The result guard tested `Array.isArray(m.result)` and skipped it in
silence. Now 9,533 rows -> 100 on the panel this was found on.

**Websocket compression restored (`compress_websocket`, default on).** HA's own websocket
negotiates `permessage-deflate`; the `ws` library does **not** enable it server-side by
default. So putting this proxy in front of HA silently *removed* compression from the browser
leg — kiosks went from deflated frames to plaintext JSON over wifi. Verified by comparing the
negotiated `Sec-WebSocket-Extensions` on HA directly (`permessage-deflate`) against the proxy
(nothing). Deflate runs on libuv's threadpool rather than the main loop, and is capped with
`concurrencyLimit`; turn it off on very weak hardware.

Measured on the NSPanel Pro these were found on: 33.2/31.7/33.9s before, 31.2/30.7/32.7s
after. The payload fell by roughly an order of magnitude but wall-clock barely moved, which
is itself the useful result — what remains of that ~31s is not websocket bytes.

## 2026.09.11.02 — 2026-09-11

**Fix: reconnect storm when a client enumerates dashboards.** `2026.09.11.01` treated a
`lovelace/config` request as the client announcing which dashboard it was about to render,
correcting the stored hint and recycling the socket to follow it. That is wrong: requesting a
dashboard's config does not mean displaying it. Kiosk Satellite enumerates *every* dashboard's
views at startup, so a panel showing one dashboard requests the config of all five. The hint
flipped to whichever was enumerated last, the socket recycled, the reconnect enumerated again —
four `/api/websocket` connections in four seconds, and the panel then served the wrong
dashboard's allowlist. One measured load never completed inside 70s.

The page GET is now the only signal used to attribute a connection, because it is the only one
that actually means "this client is displaying this dashboard".

The cost is that a client-side navigation to a *different* dashboard keeps the allowlist it
connected with until the page reloads, so entities unique to the new dashboard render as
unavailable. Set `per_dashboard: false` to serve every connection the union if that matters
more than the trimming does.

## 2026.09.11.01 — 2026-09-11

Versioning moves to `yyyy.mm.dd.xx`.

**Per-dashboard allowlists (`per_dashboard`, default on).** Every connection used to get the
*union* of all configured dashboards. On the instance this was developed against that union
was 388 entities while the kiosk's own dashboard needed 60 — so a small wall panel paid for
five dashboards to display one. Each connection is now served only its own dashboard's
entities.

The dashboard has to be known *before* the socket opens, because `subscribe_entities` is the
message being rewritten and the frontend only asks for `lovelace/config` afterwards. What
does arrive first is the ordinary page GET (`/basement-stairs-panel/basement`) on the same
client IP, so that is what attributes the connection. A client that can't be attributed falls
back to the union, i.e. exactly the previous behaviour — this option can only ever serve a
connection *less*, never *less than it needs*.

The SPA can also navigate between dashboards without reopening the websocket. When a
connection asks for a `lovelace/config` belonging to a dashboard its allowlist doesn't cover,
the hint is corrected and the socket recycled; the frontend reconnects itself and
re-subscribes, the same mechanism an allowlist growth already used.

`always_forward` / `never_forward` are now applied **per dashboard** rather than only to the
union — `always_forward` exists for entities no card names (Assist pipeline and wake-word
entities behind a Voice Satellite card, say), and those are needed on whichever dashboard the
kiosk actually has open.

**Registry trimming (`trim_registries`, default on).** The entity registry is one row per
entity for the entire instance and, once states are trimmed, the largest thing left that
scales with instance size rather than with what the dashboard shows. It is now cut to the
entities the connection can see, with devices and areas kept wherever a surviving entity
still reaches them so names and area assignments still resolve. Unrecognised registry shapes
pass through untouched rather than being guessed at.

## 0.2.3 — 2026-08-23

Filter resolution and reverse-proxy fixes, all from reported issues.

**auto-entities globs and regexes now work on every filter key** (#10). Only `*` globs were
ever understood, and a `/regex/` was escaped as literal text — so `/^sensor\.pv_.*_power$/`
compiled to `^/\^sensor\\\.pv_.*_power\$/$` and matched nothing, leaving those cards
"unavailable". The matcher is now a port of auto-entities' own (`src/match.ts`): a `/regex/`
is used as-is and deliberately **not** anchored, a glob is anchored, otherwise exact
equality. Crucially it now applies to **every** key — `domain`, `area`, `label`, `device`,
`integration`, `name` — not just `entity_id`, matching upstream.

**HA's selector object form is understood for `entity_id` and `domain`** (#4). The visual
editor stores values as `{ custom: "input_boolean.bypass_*", active_choice: "custom" }`.
That was handled for `area`/`label`/`device`/`integration` but not for `entity_id`/`domain`,
where it stringified to `"[object Object]"` and matched nothing.

**`filter: template:` cards resolve** (#4). Their entity list only exists after HA renders
the Jinja, so a structural walk could never see it. The proxy now renders those templates
over its existing control connection (`render_template`, taking the first result and
unsubscribing) and takes the real entity ids from the output. A template that errors or
times out contributes nothing and no longer affects the rest of the dashboard.

**Group members are pulled in transitively** (#4). A card naming only a group — or expanding
one client-side, like `enhanced-shutter-card`'s `show_group_members` — left every member
stripped, because the members appear nowhere in the dashboard config. Any allowlisted entity
now contributes its `entity_id` attribute members. The auto-entities `group:` and `name:`
filter keys are supported for the same reason.

**The X-Forwarded-For chain is preserved** (#9). The handler that normalizes IPv4-mapped IPv6
used `setHeader`, replacing the whole chain with our immediate peer. Since http-proxy
*appends* our hop to all three forwarded headers, anything running another reverse proxy in
front (Caddy, nginx, Traefik) sent HA `X-Forwarded-For` with 1 entry and `X-Forwarded-Proto`
with 2 — and HA's forwarded middleware raises `HTTPBadRequest` on
`len(forwarded_proto) not in (1, len(forwarded_for))`. Result: a hard **400 on every request**
through the add-on while `:8123` worked fine. Entries are now normalized in place, so the
counts stay in step and the real client IP survives the upstream hop (which also lets
`trusted_networks` see the browser rather than the proxy). The same normalization now applies
to websocket upgrades, which never fired the HTTP-only hook.

**Open dashboards pick up a grown allowlist by themselves** (#7). `subscribe_entities` is
sent once per connection and HA can't amend a live subscription, so a rebuild only ever
affected *new* connections — an already-open kiosk kept its original entity list until
someone reloaded the tab. When a rebuild **adds** entities, affected connections are now
dropped; the frontend treats that as an ordinary disconnect and reconnects against the
current allowlist. Removals deliberately don't churn open connections.

Tests: 44 → 75.

## 0.2.2 — 2026-07-29

**An empty allowlist is never forwarded as "no filter".** HA parses `subscribe_entities` as
`set(msg["entity_ids"]) or None`, so an *empty* `entity_ids` doesn't mean "subscribe to
nothing" — it means **no filter at all**. Any condition that produced an empty allowlist
therefore inverted this add-on's entire purpose: it relayed every entity on the instance.
Observed live on a ~3,600-entity instance, where it drove the process into the 2 GB heap
limit (`FATAL ERROR: Reached heap limit`) every 30–130 s in a Supervisor restart loop.

The condition that triggered it was a plain misconfiguration, made likely by this add-on's
own defaults:

- **`dashboards` no longer defaults to `fridge-status` / `home-status` / `dashboard-deck`.**
  Those are the author's own dashboards; on anyone else's instance every `lovelace/config`
  returns `config_not_found`, the union comes back empty, and the firehose follows. Since
  reinstalling an add-on resets options to their defaults, a fresh install landed straight in
  that state. The default is now `[]`.
- **`/api/websocket` is refused whenever the allowlist is empty**, not only before the first
  build, with the reason named in the log. A second guard in the relay drops the connection
  rather than ever sending an empty `entity_ids`.
- **A failed dashboard fetch now logs the dashboards that *do* exist**
  (`lovelace/dashboards/list`), so `config_not_found` answers its own question instead of
  repeating forever.
- **No dashboards configured no longer exits** — that only moved the restart loop into the
  Supervisor. The add-on stays up, refuses to strip, and says which option to set.

**Survive a Home Assistant restart.** Rebooting HA killed the add-on and left it in a
crash-restart loop that never recovered on its own. Three separate causes:

- **Unhandled socket error on an in-flight ws upgrade.** A raw upgrade socket arrives with
  no `'error'` listener, and `http-proxy` only attaches one after HA answers `101`. When HA
  goes down it resets every in-flight stream at once (camera / Assist sockets), and a reset
  in that window reached Node as an unhandled `'error'` event — `throw er` /
  `read ECONNRESET` — taking the whole process down. The upgrade handler now claims the
  socket's errors first, and network errnos anywhere else are caught process-wide instead of
  being fatal.
- **`process.exit(2)` when the first allowlist couldn't be built.** The add-on and HA core
  restart together, and core takes minutes to answer, so the restarted add-on exited within
  ~300 ms — over and over, until the Supervisor gave up. The control connection now retries
  with the same backoff it already used for later drops, and never exits for a transient
  failure. A bad token is reported loudly and retried rather than crash-looped.
- **The proxy now listens before HA is reachable**, so it is already serving the moment core
  comes up. Until the first allowlist exists, `/api/websocket` upgrades are refused with a
  `503` (the frontend retries on its own) rather than answered with an *empty* allowlist,
  which would have shown every card as "unavailable" until a manual kiosk reload.

A restarting HA also comes back in stages, which used to leave the allowlist wrong:

- **A rebuild after reconnect now merges instead of replacing.** Core answers `auth_ok` and
  `get_states` before lovelace serves configs and before the state machine has finished
  loading, so a rebuild in that window legitimately comes back short — and since no dashboard
  edit follows a restart, nothing would ever rebuild it. Cards would have stayed "unavailable"
  indefinitely. Over-including is harmless by design here; under-including breaks cards. An
  actual dashboard/registry edit still replaces, so removals still take effect.
- **`buildAllow()` bails when *every* dashboard config fails** — an HA that authenticates but
  isn't serving lovelace yet — so the caller retries instead of committing an empty allowlist.
  A *single* dashboard failing is still tolerated: that's a typo'd `url_path`, and it must not
  stop the others from being served.
- **A wedged HA is covered too**: the control connection has a handshake timeout, so a core
  that accepts the TCP connection but never completes the ws handshake still triggers a
  reconnect rather than hanging silently.

Two deliberate trade-offs, both of which swap a loud failure for a quiet one:

- A genuine misconfiguration now presents as "running" rather than "stopped". To keep it
  diagnosable, after six failed attempts the log names the `ha_base` / `allow_ws_url` options,
  DNS errnos are excluded from the process-level guard, and a malformed `allow_ws_url` still
  exits with a clear message.
- `auth_invalid` no longer exits (that just moved the restart loop into the Supervisor), but
  retries on a ≥60s floor — in dev/CLI mode the control connection authenticates against HA
  directly, and a faster loop would walk into `login_attempts_threshold` / `ip_ban`.

Also: repeated failures are collapsed in the log (one line, then a periodic count) instead of
flooding hundreds of identical `ECONNREFUSED` lines per second while HA is down.

## 0.2.1 — 2026-07-19

- Remove the inert `ports:` / `ports_description` mapping from `config.yaml`. Under
  `host_network` a Docker port map does nothing, so it only duplicated (and could drift
  from) the functional `port` option. The `port` option is now the single source of truth
  for the listen port. No behavior change — the add-on still binds `8099` by default.

## 0.2.0 — 2026-07-18

- **auto-entities `area` / `label` / `device` / `integration` filters now resolve** (#4).
  The proxy fetches the area/device/entity/label registries and expands these filters the
  way HA's frontend does, instead of silently forwarding nothing — so cards filtered by
  label/area no longer show entities as "unavailable" and you don't have to hand-list them
  in `always_forward`. Volatile filters (`state` / `attributes`) now over-include (an
  entity that doesn't match right now is still forwarded so the card can show it when it
  does). The allowlist also rebuilds on registry changes, not just dashboard edits.
- **Configurable `port` option** (#6) — move the add-on off `8099` when it collides with
  another add-on (e.g. Zigbee2MQTT). Needed because `host_network` makes the Network tab
  unable to remap the port.
- **Allowlist recompute now logs the added/removed entity diff** (#7), not just the total,
  so you can see exactly what a dashboard edit changed.
- **Defensive egress filter** (PR #1): `subscribe_entities` event payloads (`a`/`c`/`r`)
  are re-filtered to the allowlist on the way to the browser — a no-op today, but a
  guarantee the firehose can't leak if a future HA ignored the `entity_ids` subscription.
- Added a test suite (`npm test`, `node --test`): unit tests for the extractor + registry
  resolver, and integration tests that spawn the real proxy against a mock HA.

## 0.0.1 — 2026-06-19

Initial public release.

- Reverse proxy that serves the real Home Assistant frontend but trims the entity
  websocket (`subscribe_entities` / `get_states`) to each dashboard's allowlist, so
  kiosk / wall-panel dashboards load fast on large instances — with full fidelity.
- Runs with `host_network: true` so trusted-network (password-less) kiosk login works
  through the proxy; `X-Forwarded-For` is normalized to plain IPv4 (strips IPv4-mapped
  IPv6 `::ffff:` so it matches IPv4 `trusted_networks` subnets).
- Options: `dashboards`, `always_forward`, `never_forward`, `strip_entities`, plus
  `ha_base` / `allow_ws_url` to pin the HA / supervisor URLs to IPs if host networking
  breaks the internal DNS names.
