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

// The only import this module has, and only for the one-shot OS read below. Everything else
// here is a pure counter on purpose — no I/O, no clock beyond Date.now(), nothing to mock.
import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const MAX_CATS = 64;          // guards the category map against an unbounded key space

export const startedAt = Date.now();

// The OS this process is running on, resolved ONCE at boot.
//
// Read from the filesystem rather than accepted as a parameter, for the same reason
// `process.version` is: a value the caller supplies is a value that can be wrong. The base
// image is a floating tag (`node:26-alpine`), so the Alpine release genuinely moves without
// anything in this repo changing — and on a Home Assistant OS host there is no way to inspect
// the running container from outside it (no Supervisor token over SSH, docker socket denied).
//
// Alpine first because that is what ships. `/etc/os-release` is the fallback so a Debian-based
// or plain-container user gets something useful too, and null rather than a guess when neither
// exists — running from a dev checkout on macOS, say, where there is no container at all.
const OS_RELEASE = (() => {
  try {
    const alpine = fs.readFileSync('/etc/alpine-release', 'utf8').trim();
    if (alpine) return `Alpine ${alpine}`;
  } catch { /* not Alpine */ }
  try {
    const m = fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (m) return m[1].trim();
  } catch { /* no os-release either */ }
  return null;
})();

// category -> { count, before, after }. Categories: states, registry:<kind>, services,
// resources. "before" is HA's answer, "after" is what the browser got.
const trims = new Map();
// Event stream, throughput only — see the note above about why this is not a saving.
const events = { count: 0, bytes: 0 };
// Registry answers served from the local cache without asking HA at all.
// Hits alone cannot produce a rate. The miss count is the denominator, and the ratio is the
// interesting number: it falls when the allowlist keeps changing, because a recompute retires the
// cache — so a sagging hit rate is the signature of churn rather than of a caching problem.
const cache = { hits: 0, misses: 0, bytes: 0 };
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
// The JOINT distribution: one counter per (origin, route, host) combination actually seen,
// rather than three independent tallies. Three marginals cannot answer "which entry point did the
// internet traffic come through" — each sums to the same total separately, and the pairing that
// carries the answer is exactly what separate counting discards. They also cannot be drawn as a
// flow diagram at all, because a Sankey's links ARE the pairings. The marginals below are derived
// from this, so the table and the diagram can never disagree.
const byFlow = new Map();       // "origin\0route\0host" -> count
// route -> the addresses that delivered it, so a route can be named rather than described.
const hopsByRoute = new Map();
const FLOW_SEP = '\u0000';      // a byte no hostname or route label can contain

// Past the cap a new key is folded into an overflow bucket rather than dropped. Dropping kept the
// map bounded but broke the promise made just above: `connTotal` went on counting while the flows
// stopped, so the marginals no longer summed to the total and the diagram and the table disagreed
// with no way to tell which was right. And the key is not ours — `host` is the request's Host
// header, counted at websocket open, BEFORE Home Assistant has authenticated anyone — so sixty-four
// upgrades with junk Host values froze the routing view until the next restart.
const OTHER = '(other)';
const bump = (map, key, overflowKey = OTHER) => {
  if (!key) return;
  const k = !map.has(key) && map.size >= MAX_CATS ? overflowKey : key;
  map.set(k, (map.get(k) || 0) + 1);
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

// `count` exists because one frame can carry many events. HA batches, so a single websocket
// frame routinely holds dozens of entity diffs: the COUNT has to advance per event (that is
// what "events seen" means) while the BYTES are attributed once, from the frame that actually
// went out. Measuring each message separately would mean re-serialising every one of them just
// to weigh it — on the hottest path in the proxy — and would still miss the frame's own array
// overhead. Same reasoning as the batched-frame trim accounting.
export function recordEvent(bytes, count = 1) { events.count += count; events.bytes += bytes; }

// The most recent frontend/get_translations reply, broken down by key prefix. Kept as ONE
// snapshot rather than accumulated: the question is "what is in a translations payload", which
// every reply answers identically, and summing them would just multiply by page loads.
let translations = null;
export function recordTranslations(t) { translations = { ...t, at: new Date().toISOString() }; }

// One snapshot per message kind, for payloads being considered for trimming. Observational and
// temporary by nature: once a trim exists for a payload, its real before/after lands in `savings`
// and the shape stops being the interesting thing about it.
const shapes = new Map();
export function recordShape(kind, info) { shapes.set(kind, { ...info, at: new Date().toISOString() }); }

export function recordTraffic(kind, bytes) {
  // `result:<type>` carries a string the CLIENT chose, so it is capped before it becomes a key.
  let key = String(kind).slice(0, 80);
  let e = traffic.get(key);
  if (!e) {
    // Folded, not dropped. This table exists to make sure nothing flows unexplained, and an admin
    // session alone can pass 64 kinds — after which a new stream, however large, simply never
    // appeared. "(other)" with a byte count is a row someone can notice and chase.
    if (traffic.size >= MAX_CATS) { key = OTHER; e = traffic.get(key); }
    if (!e) { e = { count: 0, bytes: 0 }; traffic.set(key, e); }
  }
  e.count += 1; e.bytes += bytes;
}

export function recordCacheHit(bytes) { cache.hits += 1; cache.bytes += bytes; }
export function recordCacheMiss() { cache.misses += 1; }

// Clients that could not keep up. `pauses` is how often a browser's send queue passed the high
// mark and its HA stream was held; `stalls` how often one made no progress at all and was
// closed. A pause is a slow link doing what a slow link does; a climbing stall count is a panel
// that is broken.
const backpressure = { pauses: 0, stalls: 0 };
export function recordBackpressure(kind) { if (kind === 'stall') backpressure.stalls += 1; else backpressure.pauses += 1; }

export function connOpen({ ip, dash, via, allowSize, ua, origin, route, host, hop, hops, device }) {
  const id = nextConnId++;
  connTotal += 1;
  // Overflow keeps origin and route — both small fixed vocabularies — and buckets only the host,
  // so every marginal still sums to `connTotal`.
  bump(byFlow, [origin || 'unknown', route || 'unknown', host || 'unknown'].join(FLOW_SEP),
    [origin || 'unknown', route || 'unknown', OTHER].join(FLOW_SEP));
  // Which machines actually delivered each kind of route. Kept so the panel can NAME a route
  // rather than calling it "proxy" — a label that is genuinely ambiguous here, since this add-on
  // is itself a proxy. The addresses are resolved to names at snapshot time, not now: the lookup
  // is asynchronous and the first connection always arrives before its own answer does.
  // Only for `proxy`, and deliberately so. It is the one route whose hop is a genuine
  // intermediary AND whose label is ambiguous. For `direct` the hop is the CLIENT, so naming the
  // route after it would put a wall panel's own hostname where the route belongs; for `ingress`
  // it is Supervisor, and "ingress" already says more than "hassio-supervisor" would; `cloudflare`
  // names itself. Widening this to every route was tried and produced exactly those labels.
  if (route === 'proxy' && hop && (hopsByRoute.has(route) || hopsByRoute.size < MAX_CATS)) {
    let set = hopsByRoute.get(route);
    if (!set) { set = new Set(); hopsByRoute.set(route, set); }
    if (set.size < 8) set.add(hop);
  }
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

// Sessions that have closed, kept for a day.
//
// The live list answers "what is connected right now", which is the wrong question when a panel
// has gone dark — the row you need to look at is precisely the one that disappeared. Keyed by
// the client's identity rather than by connection id, because a wall panel reconnects constantly
// and 300 rows for one device is not a list anyone reads: repeat connections fold into one row
// carrying the count and the last time it was seen.
const SESSION_WINDOW_MS = 24 * 3600 * 1000;
const SESSION_MAX = 500;
const recent = new Map();

// Address and dashboard only. The mDNS device name used to be part of this, and it is not stable:
// it is whichever announcement arrived first, and null for a client that connects before discovery
// has answered — so ONE panel split into several rows, which the snapshot then rendered with the
// same resolved name, as apparent duplicates the live-row exclusion could not match either.
const sessionKey = (c) => [c.ip || '?', c.dash || '?'].join('\u0000');

export function connClose(id) {
  const c = conns.get(id);
  conns.delete(id);
  if (!c) return;
  const key = sessionKey(c);
  const prior = recent.get(key);
  const closedAt = Date.now();
  if (prior) {
    // Re-inserted so Map order is least-recently-SEEN first. Eviction below takes the first key,
    // and without this that was the earliest FIRST-seen client — typically the always-on wall
    // panel from boot, the one row most worth keeping.
    recent.delete(key); recent.set(key, prior);
    prior.sessions += 1;
    prior.lastSeen = closedAt;
    prior.totalSec += Math.round((closedAt - c.since) / 1000);
    prior.msgs += c.msgs;
    // Keep the most recently observed values: a device that was renamed, moved dashboards or
    // resolved a user midway is better described by what it looks like NOW than at first sight.
    prior.user = c.user ?? prior.user;
    prior.device = c.device ?? prior.device;
    prior.allowSize = c.allowSize || prior.allowSize;
    prior.origin = c.origin ?? prior.origin;
    prior.route = c.route ?? prior.route;
    prior.host = c.host ?? prior.host;
    // Best of the timings rather than the last: the question a timing answers here is "can this
    // client be fast", and a reconnect storm's worth of degraded numbers hides that it can.
    if (Number.isFinite(c.msToEntityData)
      && (!Number.isFinite(prior.msToEntityData) || c.msToEntityData < prior.msToEntityData)) {
      prior.msToEntityData = c.msToEntityData;
    }
  } else {
    if (recent.size >= SESSION_MAX) recent.delete(recent.keys().next().value);
    recent.set(key, {
      ip: c.ip, dash: c.dash, device: c.device, user: c.user, allowSize: c.allowSize,
      origin: c.origin, route: c.route, host: c.host, via: c.via,
      msToEntityData: c.msToEntityData,
      firstSeen: c.since, lastSeen: closedAt,
      totalSec: Math.round((closedAt - c.since) / 1000), sessions: 1, msgs: c.msgs,
    });
  }
  pruneSessions(closedAt);
}

function pruneSessions(now = Date.now()) {
  const cutoff = now - SESSION_WINDOW_MS;
  for (const [k, v] of recent) if (v.lastSeen < cutoff) recent.delete(k);
}

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
  // Supplied by the proxy so this module stays a pure counter with no discovery dependency.
  const deviceFor = typeof extra.deviceFor === 'function' ? extra.deviceFor : null;
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
      device: deviceFor ? (deviceFor(c.ip) ?? c.device) : c.device,
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
    // The runtime this process is ACTUALLY executing on, read from the process rather than
    // passed in — so it cannot drift from reality the way a hand-maintained constant would.
    //
    // Worth a line because the alternative is inference. The image is built from a base named
    // in the Dockerfile, but on a Home Assistant OS host there is no way to check what the
    // running container holds: the Supervisor token is not available over SSH and the docker
    // socket is denied. After a base-image change, "did the rebuild actually take?" was
    // answerable only by trusting that it did. Now it is answerable by reading it.
    node: process.version,
    // How long the event loop was blocked — the number that says whether this app needs to be
    // more than one process, instead of anybody guessing. Everything this proxy does to a frame
    // happens on this loop, so a climbing p99 here IS "one client can stall the others",
    // measured rather than argued. See docs/CLUSTERING.md, which turns on this figure.
    //
    // `monitorEventLoopDelay` is a libuv histogram sampled in C, not a JS timer, so it costs
    // effectively nothing and cannot itself add the lag it reports.
    loopDelayMs: loopDelay(),
    // The OS underneath, for the same reason and with the same caveat as `node` above:
    // `node:26-alpine` is a FLOATING tag, so the Alpine release moves without anything in this
    // repo changing. Read once at boot (see OS_RELEASE) rather than per request — it cannot
    // change while the process lives.
    os: OS_RELEASE,
    // Untrimmed, and the largest thing left in the boot path. Reported so the size of the
    // opportunity — and the risk of taking it — can be judged from data rather than convention.
    translations,
    shapes: Object.fromEntries(shapes),
    uptimeSec: Math.round((now - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
    generatedAt: new Date(now).toISOString(),
    options: extra.options ?? {},
    // Which section each option belongs to. Passed through rather than derived here, so this
    // module stays a pure counter — but it has to be named explicitly, because this object is
    // built field by field and anything not listed is silently dropped on the way out.
    optionSections: extra.optionSections ?? {},
    allowlist: extra.allowlist ?? {},
    resources: extra.resources ?? {},
    mdns: extra.mdns ?? null,
    // Request/response payloads, where a real before/after exists.
    savings: { before, after, saved: before - after, savedPct: pct(before, after), byCategory },
    // Throughput only. Deliberately NOT folded into `savings` — see the file header.
    eventStream: {
      count: events.count,
      bytes: events.bytes,
      bytesPerMin: Math.round(events.bytes / Math.max((now - startedAt) / 60000, 1 / 60)),
    },
    backpressure: { ...backpressure },
    registryCache: {
      hits: cache.hits,
      misses: cache.misses,
      bytesServed: cache.bytes,
      // null, not 0, until something has actually been asked for: a 0% hit rate on zero
      // requests is a fiction, and publishing it would put a false trough in the statistics
      // every time the add-on restarts.
      hitRatePct: (cache.hits + cache.misses) === 0
        ? null
        : Math.round((cache.hits / (cache.hits + cache.misses)) * 1000) / 10,
    },
    // Biggest first: the point of this list is to make an unexplained stream obvious.
    byMessage: Object.fromEntries(
      [...traffic.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 15),
    ),
    clients: {
      open: conns.size,
      total: connTotal,
      list: clients,
      // Clients seen in the last 24 hours that are NOT connected now. Live ones are excluded
      // rather than merged: a device appearing in both lists with different numbers is the kind
      // of ambiguity this panel exists to remove, and the live list is already authoritative for
      // anything currently connected.
      recent: (() => {
        pruneSessions(now);
        const liveKeys = new Set([...conns.values()].map(sessionKey));
        return [...recent]
          .filter(([k]) => !liveKeys.has(k))
          .map(([, v]) => ({
            ip: v.ip, dashboard: v.dash, user: v.user, allowSize: v.allowSize,
            origin: v.origin, route: v.route, host: v.host, attributedVia: v.via,
            device: deviceFor ? (deviceFor(v.ip) ?? v.device) : v.device,
            msToEntityData: v.msToEntityData,
            sessions: v.sessions, messages: v.msgs, connectedSec: v.totalSec,
            firstSeen: v.firstSeen, lastSeen: v.lastSeen,
            lastSeenSec: Math.round((now - v.lastSeen) / 1000),
          }))
          .sort((a, b) => b.lastSeen - a.lastSeen);
      })(),
    },
    // Lifetime tallies of how connections arrived. Counted at open, so these keep counting
    // devices that have since disconnected — which is the whole point of having them next to
    // a list that only shows what is live.
    paths: {
      ...pathsSnapshot(),
      // A name for each route, where the machines that delivered it agree on one.
      //
      // Only when they AGREE: two different reverse proxies answering the same route have no
      // single name, and inventing one would put a label on the diagram that is true of some of
      // the traffic and false for the rest. The panel falls back to the generic wording, which is
      // never wrong.
      routeNames: (() => {
        const hopNameFor = typeof extra.hopNameFor === 'function' ? extra.hopNameFor : null;
        if (!hopNameFor) return {};
        const out = {};
        for (const [route, ips] of hopsByRoute) {
          const names = new Set();
          for (const ip of ips) {
            const n = hopNameFor(ip);
            if (n) names.add(n);
          }
          if (names.size === 1) out[route] = [...names][0];
        }
        return out;
      })(),
    },
  };
}

// Turns the joint counter into the shape the panel reads: the flows themselves, plus the three
// marginals SUMMED FROM THEM rather than counted alongside them. Deriving is not a tidiness
// preference — two counters for the same quantity are two things that can disagree, and the
// disagreement shows up as a diagram and a table that contradict each other with no way to tell
// which is right.
//
// `flows` is exported as an array of explicit {origin, route, host, n} objects rather than the
// packed map key, so no consumer has to know the separator.
export function pathsSnapshot(flows = byFlow) {
  const marginal = (idx) => {
    const m = new Map();
    for (const [key, n] of flows) {
      const part = key.split(FLOW_SEP)[idx];
      m.set(part, (m.get(part) || 0) + n);
    }
    return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
  };
  return {
    flows: [...flows]
      .sort((a, b) => b[1] - a[1])
      .map(([key, n]) => {
        const [origin, route, host] = key.split(FLOW_SEP);
        return { origin, route, host, n };
      }),
    byOrigin: marginal(0),
    byRoute: marginal(1),
    byHost: marginal(2),
  };
}

// ---- event-loop delay ----
//
// Resolution is 20ms rather than the default 10: this is a health signal read once per snapshot,
// not a profile, and a coarser bucket is cheaper. `.unref()` so it never holds the process open.
//
// The histogram is NOT reset between snapshots. Reset-per-read would make every reading depend on
// when the last one happened — a console open in a browser polling every few seconds would report
// a different p99 from a `rest:` sensor polling every minute, off the same process. Since boot is
// one well-defined window, and `max` since boot is exactly the "what is the worst this has ever
// been" question worth asking of a proxy.
const LOOP_RES_MS = 20;
const LOOP = monitorEventLoopDelay({ resolution: LOOP_RES_MS });
LOOP.enable();
LOOP.unref?.();
// The histogram records the WHOLE interval between ticks, so a perfectly idle loop reads back
// `resolution` — 20ms of "delay" that is not delay at all. Subtracting it is what makes an idle
// process report 0 and a blocked one report how long it was blocked, which is the only reading
// anyone can act on. Measured to confirm: idle 0.0ms, a deliberate 150ms block -> max 150.
const loopDelay = () => {
  const ms = (n) => Math.max(0, Math.round((n / 1e6 - LOOP_RES_MS) * 10) / 10);
  return { mean: ms(LOOP.mean || 0), p50: ms(LOOP.percentile(50)), p99: ms(LOOP.percentile(99)),
    max: ms(LOOP.max || 0), since: 'boot' };
};

// Test seam: the counters are module-level, so a test that wants a clean slate says so.
export function reset() {
  trims.clear();
  events.count = 0; events.bytes = 0;
  cache.hits = 0; cache.misses = 0; cache.bytes = 0;
  backpressure.pauses = 0; backpressure.stalls = 0;
  traffic.clear();
  conns.clear();
  byFlow.clear();
  hopsByRoute.clear();
  recent.clear();
  nextConnId = 1; connTotal = 0;
}
