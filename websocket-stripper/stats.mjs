// Runtime statistics for the add-on's Ingress panel and its JSON API.
//
// Why this exists: until now the ONLY evidence the add-on was doing anything was the log,
// which you read when something already looks wrong. Everything below is counted at the
// points where the proxy already computes a before/after, so collecting it is close to free.
//
// An important honesty constraint runs through this file. Three of the four trims have a
// genuine, measurable before/after — the proxy holds HA's full answer and its own trimmed
// answer in the same function, so "saved" is a subtraction, not a model. The event stream
// does NOT: HA filters it server-side from the entity_ids we injected, so the untrimmed
// volume never exists anywhere and cannot be measured. It is therefore reported as
// throughput ("what this client is receiving"), never as a saving. Inventing a counterfactual
// there would make the headline number bigger and make the panel a liar.
//
// All byte counts are UNCOMPRESSED payload — what the browser must parse. With
// compress_websocket on, fewer bytes than this cross the wire.

const MAX_CATS = 64;          // guards the category map against an unbounded key space

export const startedAt = Date.now();

// category -> { count, before, after }. Categories: states, registry:<kind>, services,
// resources. "before" is HA's answer, "after" is what the browser got.
const trims = new Map();
// Event stream, throughput only — see the note above about why this is not a saving.
const events = { count: 0, bytes: 0 };
// Registry answers served from the local cache without asking HA at all.
const cache = { hits: 0, bytes: 0 };
// What is actually coming down the socket, keyed by message kind. The trim categories only
// cover payloads this add-on knows how to shrink; everything else was invisible, which is how
// a 98MB/h stream sat unexplained next to a panel claiming 0.5MB/h.
const traffic = new Map();
// Live connections, keyed by a monotonic id.
const conns = new Map();
let nextConnId = 1;
// Lifetime connection count, so the panel can show churn rather than just what's open now.
let connTotal = 0;
// Lifetime connections by network path, counted at open. Kept separately from `conns` because
// the interesting question is "how does traffic reach this instance over a day", and `conns`
// only ever holds what is connected right this second — a wall panel that reconnects hourly
// and a laptop that visited once look identical there.
const byRoute = new Map();      // direct | proxy | cloudflare | ingress -> count
const byOrigin = new Map();     // lan | internet -> count
const byHost = new Map();       // the hostname dialled -> count

const bump = (map, key) => {
  if (!key) return;
  if (!map.has(key) && map.size >= MAX_CATS) return;    // same unbounded-keys guard as above
  map.set(key, (map.get(key) || 0) + 1);
};

export function recordTrim(category, before, after) {
  let t = trims.get(category);
  if (!t) {
    if (trims.size >= MAX_CATS) return;
    t = { count: 0, before: 0, after: 0 };
    trims.set(category, t);
  }
  t.count += 1; t.before += before; t.after += after;
}

export function recordEvent(bytes) { events.count += 1; events.bytes += bytes; }

export function recordTraffic(kind, bytes) {
  let e = traffic.get(kind);
  if (!e) {
    if (traffic.size >= MAX_CATS) return;       // same guard as categories
    e = { count: 0, bytes: 0 };
    traffic.set(kind, e);
  }
  e.count += 1; e.bytes += bytes;
}

export function recordCacheHit(bytes) { cache.hits += 1; cache.bytes += bytes; }

export function connOpen({ ip, dash, via, allowSize, ua, origin, route, host, hop, hops, device }) {
  const id = nextConnId++;
  connTotal += 1;
  bump(byRoute, route);
  bump(byOrigin, origin);
  bump(byHost, host);
  conns.set(id, {
    id, ip: ip || null, dash: dash || null, via: via || null, allowSize: allowSize || 0,
    // How this connection reached the add-on. Observational only — see route.mjs on why none
    // of this may be used to decide access.
    origin: origin || null, route: route || null, host: host || null, hop: hop || null,
    hops: Array.isArray(hops) && hops.length ? hops.slice(0, 8) : null,
    // Reported verbatim rather than bucketed into "kiosk/phone/desktop": the useful
    // distinctions live in vendor tokens that vary by app and firmware, so guessing a class
    // here would bake in an assumption nobody can see or correct.
    ua: typeof ua === 'string' ? ua.slice(0, 200) : null,
    // What the network says this client IS, from mDNS. Observational, like `route` — it labels
    // the row and never decides what the connection is served.
    device: device && typeof device === 'object' ? {
      kind: String(device.kind ?? '').slice(0, 40) || null,
      name: String(device.name ?? '').slice(0, 60) || null,
      version: device.version ? String(device.version).slice(0, 30) : null,
    } : null,
    user: null,
    // How long this connection took to become useful, and how much of that was the link.
    // Null until the first full entity payload has actually gone out; see connTiming.
    msToEntityData: null, initialPayloadBytes: null, initialEntityCount: null, initialDrainMs: null,
    since: Date.now(), fromHA: 0, toBrowser: 0, eventBytes: 0, msgs: 0,
  });
  return id;
}

export function connClose(id) { conns.delete(id); }

// A connection's allowlist is not fixed at open: per-user rules resolve a moment later and can
// widen it. Reporting the size captured at open meant the panel under-reported exactly the
// connections a user rule had just changed — the panel stating something untrue about its own
// behaviour, which is the failure it exists to prevent.
export function connIdentity(id, { allowSize, user } = {}) {
  const c = conns.get(id);
  if (!c) return;
  if (Number.isFinite(allowSize)) c.allowSize = allowSize;
  if (user) c.user = String(user).slice(0, 80);
}

// How long this connection took to deliver the payload a dashboard cannot render without.
//
// This is the add-on's own answer to "is it actually snappier", measured for EVERY client
// including native apps that cannot be instrumented from outside. Three numbers:
//
//   msToEntityData      websocket upgrade -> the first entity payload written to the socket.
//   initialPayloadBytes how big the `a` block itself was — NOT the frame it arrived in, which
//                       is batched with unrelated replies and varied 164x between two clients
//                       on the same dashboard before this was fixed.
//   initialEntityCount  how many entities that block carried. Reported so the bytes can be
//                       sanity-checked: a byte count alone cannot tell a reader that a "cold
//                       start payload" actually held three entities out of a 104-entity
//                       allowlist, and a panel that cannot be checked is a panel that can lie.
//   initialDrainMs      how long that write took to be accepted by the network stack.
//
// Read these as diagnostics, not as a benchmark, and do not build a performance claim on them:
//
//   - msToEntityData is dominated by how long the FRONTEND takes to get around to subscribing
//     (auth handshake, JS parse), not by moving the payload. Measured live, a LAN wall panel
//     took 671ms for 1.5KB while a phone on 5G took 207ms for 215KB.
//   - initialDrainMs measures handoff to the kernel socket buffer, not receipt by the device.
//     A 215KB payload "drained" in 6ms over cellular, which is physically impossible as a
//     transfer time — the buffer simply swallowed it.
//
// Recorded once per connection — the FIRST payload only. A later re-subscribe is a different
// event, and averaging them together would quietly hide the cold-start number this exists to
// report.
export function connTiming(id, { msToEntityData, initialPayloadBytes, initialEntityCount, initialDrainMs } = {}) {
  const c = conns.get(id);
  if (!c || c.msToEntityData !== null) return;
  if (Number.isFinite(msToEntityData)) c.msToEntityData = msToEntityData;
  if (Number.isFinite(initialPayloadBytes)) c.initialPayloadBytes = initialPayloadBytes;
  if (Number.isFinite(initialEntityCount)) c.initialEntityCount = initialEntityCount;
  if (Number.isFinite(initialDrainMs)) c.initialDrainMs = initialDrainMs;
}

export function connTraffic(id, inBytes, outBytes, isEvent) {
  const c = conns.get(id);
  if (!c) return;
  c.msgs += 1;
  c.fromHA += inBytes;
  c.toBrowser += outBytes;
  if (isEvent) c.eventBytes += outBytes;
}

const pct = (before, after) => (before > 0 ? Math.round(((before - after) / before) * 1000) / 10 : 0);

// `extra` carries the things only the proxy knows: version, options, allowlist sizes,
// per-dashboard resource figures. Kept as a parameter rather than an import so this module
// stays a pure counter and the tests can drive it without booting the proxy.
export function snapshot(extra = {}) {
  const now = Date.now();
  const byCategory = {};
  let before = 0, after = 0;
  for (const [k, t] of trims) {
    byCategory[k] = { count: t.count, before: t.before, after: t.after, saved: t.before - t.after, savedPct: pct(t.before, t.after) };
    before += t.before; after += t.after;
  }
  const clients = [...conns.values()].map((c) => {
    // A per-minute rate taken from a connection that is four seconds old is not a
    // measurement, it is that connection's opening burst multiplied by fifteen. Report null
    // until a full minute exists to divide by, and let the panel render that as "—".
    const ageMs = now - c.since;
    const rate = ageMs >= 60000 ? Math.round(c.eventBytes / (ageMs / 60000)) : null;
    return {
      id: c.id, ip: c.ip, dashboard: c.dash, attributedVia: c.via, allowSize: c.allowSize, ua: c.ua,
      user: c.user,
      origin: c.origin, route: c.route, host: c.host, hop: c.hop, hops: c.hops,
      device: c.device,
      msToEntityData: c.msToEntityData,
      initialPayloadBytes: c.initialPayloadBytes,
      initialEntityCount: c.initialEntityCount,
      initialDrainMs: c.initialDrainMs,
      connectedSec: Math.round((now - c.since) / 1000), messages: c.msgs,
      fromHA: c.fromHA, toBrowser: c.toBrowser,
      eventBytes: c.eventBytes,
      eventBytesPerMin: rate,
    };
  }).sort((a, b) => a.id - b.id);

  return {
    version: extra.version ?? null,
    uptimeSec: Math.round((now - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
    generatedAt: new Date(now).toISOString(),
    options: extra.options ?? {},
    allowlist: extra.allowlist ?? {},
    resources: extra.resources ?? {},
    // Request/response payloads, where a real before/after exists.
    savings: { before, after, saved: before - after, savedPct: pct(before, after), byCategory },
    // Throughput only. Deliberately NOT folded into `savings` — see the file header.
    eventStream: {
      count: events.count,
      bytes: events.bytes,
      bytesPerMin: Math.round(events.bytes / Math.max((now - startedAt) / 60000, 1 / 60)),
    },
    registryCache: { hits: cache.hits, bytesServed: cache.bytes },
    // Biggest first: the point of this list is to make an unexplained stream obvious.
    byMessage: Object.fromEntries(
      [...traffic.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 15),
    ),
    clients: { open: conns.size, total: connTotal, list: clients },
    // Lifetime tallies of how connections arrived. Counted at open, so these keep counting
    // devices that have since disconnected — which is the whole point of having them next to
    // a list that only shows what is live.
    paths: {
      byRoute: Object.fromEntries([...byRoute].sort((a, b) => b[1] - a[1])),
      byOrigin: Object.fromEntries([...byOrigin].sort((a, b) => b[1] - a[1])),
      byHost: Object.fromEntries([...byHost].sort((a, b) => b[1] - a[1])),
    },
  };
}

// Test seam: the counters are module-level, so a test that wants a clean slate says so.
export function reset() {
  trims.clear();
  events.count = 0; events.bytes = 0;
  cache.hits = 0; cache.bytes = 0;
  traffic.clear();
  conns.clear();
  byRoute.clear(); byOrigin.clear(); byHost.clear();
  nextConnId = 1; connTotal = 0;
}
