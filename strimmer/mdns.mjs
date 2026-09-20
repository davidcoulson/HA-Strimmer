// mdns.mjs — what KIND of thing is this client?
//
// The add-on already classifies how a connection arrived (LAN vs internet, which entry point —
// see route.mjs). This answers the other half: what the device at that address actually is.
// Multicast DNS is how most of them already say so, unprompted:
//
//   _kiosk-satellite._tcp   a Kiosk Satellite panel (TXT carries its name and version)
//   _esphomelib._tcp        an ESPHome device
//   _ha-paneld._tcp         a ha-paneld panel
//   _googlecast._tcp        a Cast display
//
// Two things this is for, and one it is deliberately NOT for.
//
// FOR: reporting. A stats panel that says "10.2.4.129" is worse than one that says
// "10.2.4.129 — Office Test Panel, Kiosk Satellite 2026.9.46", and the second costs a few
// multicast packets a minute.
//
// FOR: resolving a `.local` name in a client_overrides rule. The OS resolver inside an Alpine
// container has no mDNS, so `node:dns` cannot answer those; this can.
//
// NOT FOR: deciding which entities a client gets. An mDNS instance name is a label a device
// chose for itself — matching it against Home Assistant device names would be fuzzy string
// matching, and a wrong match silently serves the wrong entities. Identity for that purpose comes
// from the client naming its own entity_id, or from an explicit rule.
//
// Everything here is best-effort. Multicast may be filtered, the socket may fail to bind, the
// network may not carry it. Any of those degrade to "we learned nothing", never to a failure to
// serve — discovery runs entirely beside the request path and is never awaited by it.

import mdnsFactory from 'multicast-dns';

// Service types worth browsing by default. Chosen because each identifies something that
// plausibly connects to Home Assistant and renders a dashboard; a generic sweep of
// `_services._dns-sd._udp` would return printers and speakers too, at more traffic for no gain.
export const DEFAULT_SERVICES = [
  '_kiosk-satellite._tcp.local',
  '_esphomelib._tcp.local',
  '_ha-paneld._tcp.local',
  '_googlecast._tcp.local',
];

// A friendlier label than the raw service type, for anything the panel shows a person.
const SERVICE_LABELS = {
  '_kiosk-satellite._tcp.local': 'Kiosk Satellite',
  '_esphomelib._tcp.local': 'ESPHome',
  '_ha-paneld._tcp.local': 'ha-paneld',
  '_googlecast._tcp.local': 'Cast',
};

export const labelFor = (service) => SERVICE_LABELS[service] ?? service.replace(/^_|\._tcp\.local$/g, '');

// Which announcement to believe when a device makes several.
//
// A panel commonly advertises itself more than once — as ha-paneld AND as Kiosk Satellite AND as
// ESPHome — with a different version on each. Measured on a live instance: three of twenty-four
// discovered addresses did this. Taking whichever record arrived first made the label depend on
// multicast timing, so the same panel could show as ESPHome one boot and Kiosk Satellite the next.
//
// The order is most-specific-first. ha-paneld and Kiosk Satellite are the software actually
// running the panel; ESPHome is the firmware underneath, true of the device but the least useful
// answer to "what is this". Anything unrecognised sorts last rather than being discarded — an
// unknown label beats no label.
//
// This decides what is DISPLAYED and nothing else. A rule matching on mdns_kind tests every
// record for an address, so a panel is matchable as ESPHome whatever it is shown as.
export const KIND_PRIORITY = ['ha-paneld', 'Kiosk Satellite', 'ESPHome', 'Cast'];

export function preferredRow(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const rank = (r) => {
    const i = KIND_PRIORITY.indexOf(r?.kind);
    return i === -1 ? KIND_PRIORITY.length : i;
  };
  // Stable: equal ranks keep discovery order, so a device announcing two unknown kinds does not
  // flip between them.
  return rows.map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])[0][0];
}

// TXT records arrive as an array of Buffers holding `key=value`. Decoded defensively: a device
// can put anything in there, including bytes that are not valid UTF-8.
export function parseTxt(txt) {
  const out = {};
  if (!Array.isArray(txt)) return out;
  for (const entry of txt) {
    let s;
    try { s = Buffer.isBuffer(entry) ? entry.toString('utf8') : String(entry); } catch { continue; }
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const k = s.slice(0, eq).trim();
    if (!k || k.length > 40) continue;
    out[k] = s.slice(eq + 1).slice(0, 120);
  }
  return out;
}

// DNS names compare case-insensitively and may or may not carry the root dot. An SRV target of
// `Panel.local.` and an A record for `panel.local` are the same host; joined as raw strings they
// were two, and the device silently never got an address — or a label.
export const hostKey = (name) => String(name ?? '').replace(/\.$/, '').toLowerCase();

// Bounds. The tables used to take every A record from every response on the segment, keep it for
// the life of the process, and rebuild the whole index on each one — measured, 20,000 spoofed
// records cost 10.6s of event loop. Far above any real network; they exist so "unbounded" is not
// something a chatty or hostile neighbour can turn into memory and CPU.
export const HOSTS_MAX = 2000;
export const INSTANCES_MAX = 1000;
// Anything not re-heard within this many query intervals is forgotten — see expire().
export const STALE_AFTER_INTERVALS = 3;

const evictOldest = (map, max) => {
  if (map.size <= max) return;
  const byAge = [...map].sort((a, b) => (a[1].seenAt ?? 0) - (b[1].seenAt ?? 0));
  for (const [k] of byAge.slice(0, map.size - max)) map.delete(k);
};

// Fold one mDNS response into { instances, hosts }.
//
// Kept as a pure function over the answer list so the interesting part — "did we understand this
// packet" — is testable without a network, a socket, or a real device on the segment.
//
// Returns true only when something the INDEX depends on changed. It used to return true for any
// A record at all, identical or not, so practically every packet on the LAN rebuilt both maps.
// A record that merely confirms what is known refreshes `seenAt` and nothing else.
export function ingest(packet, services, state, now = Date.now()) {
  const answers = [...(packet?.answers || []), ...(packet?.additionals || [])];
  const wanted = new Set(services);
  let changed = false;
  // TTL 0 is a GOODBYE: the device is telling the segment that the record is gone. Recording it
  // as a fresh sighting — which is what ignoring the TTL did — kept a departed panel's name
  // pointing at its old address, and when DHCP reissued that address a `client` rule naming the
  // panel widened a stranger.
  const goodbye = (a) => a.ttl === 0;

  // PTR: service type -> instance name. SRV: instance -> host + port. TXT: instance -> metadata.
  // A: host -> address. A device usually sends all four together, but not always, so each record
  // is folded in independently and an instance becomes useful once it has an address.
  for (const a of answers) {
    if (!a || typeof a.name !== 'string') continue;
    if (a.type === 'PTR' && wanted.has(a.name) && typeof a.data === 'string') {
      if (goodbye(a)) { if (state.instances.delete(a.data)) changed = true; continue; }
      const known = state.instances.get(a.data);
      const inst = known || { instance: a.data, service: a.name };
      if (!known || inst.service !== a.name) changed = true;
      inst.service = a.name;
      inst.seenAt = now;
      state.instances.set(a.data, inst);
    } else if (a.type === 'SRV' && a.data?.target) {
      const inst = state.instances.get(a.name);
      if (!inst) continue;
      const host = hostKey(a.data.target), port = a.data.port ?? null;
      if (inst.host !== host || inst.port !== port) changed = true;
      inst.host = host; inst.port = port; inst.seenAt = now;
    } else if (a.type === 'TXT') {
      const inst = state.instances.get(a.name);
      if (!inst) continue;
      const txt = parseTxt(a.data);
      if (JSON.stringify(txt) !== JSON.stringify(inst.txt ?? null)) changed = true;
      inst.txt = txt; inst.seenAt = now;
    } else if (a.type === 'A' && typeof a.data === 'string') {
      const key = hostKey(a.name);
      // Multicast DNS names live under `.local` by definition. Anything else in an mDNS response
      // is not something this table has a use for, and is the cheapest flood to refuse.
      if (!key.endsWith('.local')) continue;
      if (goodbye(a)) { if (state.hosts.delete(key)) changed = true; continue; }
      const known = state.hosts.get(key);
      if (!known || known.ip !== a.data) changed = true;
      state.hosts.set(key, { ip: a.data, seenAt: now });
    }
  }
  evictOldest(state.hosts, HOSTS_MAX);
  evictOldest(state.instances, INSTANCES_MAX);
  return changed;
}

// Forget what has not been heard from. Every query re-asks for each service AND for each host
// already held (see query()), so anything still on the network answers and refreshes its
// `seenAt`; what stays silent for several rounds has left. Returns whether anything was dropped.
export function expire(state, maxAgeMs, now = Date.now()) {
  let dropped = false;
  for (const map of [state.hosts, state.instances]) {
    for (const [k, v] of map) {
      if (now - (v.seenAt ?? 0) > maxAgeMs) { map.delete(k); dropped = true; }
    }
  }
  return dropped;
}

// Flatten instances + host addresses into address -> device, which is the only shape the rest of
// the add-on asks for. An instance with no resolvable address is simply absent.
export function index(state) {
  const byIp = new Map();
  const byHost = new Map();
  for (const inst of state.instances.values()) {
    const ip = inst.host ? (state.hosts.get(hostKey(inst.host))?.ip ?? null) : null;
    if (inst.host && ip) byHost.set(hostKey(inst.host), ip);
    if (!ip) continue;
    const row = {
      ip,
      service: inst.service,
      kind: labelFor(inst.service),
      // A device's own name, when it gives one. `friendly_name` is ha-paneld's key, `name` is
      // Kiosk Satellite's; falling back to the instance label keeps the column populated.
      name: inst.txt?.name || inst.txt?.friendly_name || inst.instance.split('.')[0],
      version: inst.txt?.version || null,
      port: inst.port ?? null,
    };
    // One address can run several services (an ESPHome device that also casts). Keep them all;
    // the panel shows the first and the JSON carries the list.
    const existing = byIp.get(ip);
    if (existing) { if (!existing.some((r) => r.service === row.service)) existing.push(row); }
    else byIp.set(ip, [row]);
  }
  // Plain `<host>.local` A records with no service attached still resolve a name, which is what a
  // client_overrides hostname needs.
  for (const [host, rec] of state.hosts) {
    if (!byHost.has(host)) byHost.set(host, rec.ip);
  }
  return { byIp, byHost };
}

export function createDiscovery({ services = DEFAULT_SERVICES, intervalMs = 300000, log = () => {} } = {}) {
  const state = { instances: new Map(), hosts: new Map() };
  let view = { byIp: new Map(), byHost: new Map() };
  let mdns = null;
  let timer = null;
  let started = false;
  let failed = null;

  const reindex = () => { view = index(state); };

  const query = () => {
    if (!mdns) return;
    // Age out first, so a host that stopped answering is not asked about forever.
    if (expire(state, intervalMs * STALE_AFTER_INTERVALS)) reindex();
    try {
      mdns.query({ questions: services.map((name) => ({ name, type: 'PTR' })) });
      // Re-ask for the hosts already held. A PTR query refreshes devices that advertise one of
      // our services; a bare `<name>.local` — which is all a `client` rule hostname needs — is
      // only re-announced if somebody asks for it, and would otherwise age out while still up.
      const hosts = [...state.hosts.keys()].slice(0, 100);
      if (hosts.length) mdns.query({ questions: hosts.map((name) => ({ name, type: 'A' })) });
    } catch (e) { /* a transient send failure is not worth a line every interval */ }
  };

  return {
    start() {
      if (started) return;
      started = true;
      try {
        mdns = mdnsFactory();
        mdns.on('error', (e) => {
          // Bind failures and send errors both land here. Log once — a filtered network would
          // otherwise produce a line per packet — and carry on with an empty view.
          if (!failed) { failed = e.message; log(`  mDNS unavailable (${e.message}) — device types will be unknown`); }
        });
        mdns.on('response', (packet) => { if (ingest(packet, services, state)) reindex(); });
        query();
        timer = setInterval(query, intervalMs);
        timer.unref?.();          // never hold the process open for a discovery refresh
      } catch (e) {
        failed = e.message;
        log(`  mDNS unavailable (${e.message}) — device types will be unknown`);
      }
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      try { mdns?.destroy(); } catch {}
      mdns = null; started = false;
    },
    // What is the device at this address? Null when we have never heard from it — which is the
    // normal case for a phone, a laptop, or anything that does not advertise.
    lookup(ip) { return ip ? (view.byIp.get(ip) ?? null) : null; },
    // Resolve `panel.local` to an address. The OS resolver in the container cannot do this.
    resolve(host) {
      if (typeof host !== 'string') return null;
      return view.byHost.get(hostKey(host)) ?? null;
    },
    // For the stats panel: everything discovered, newest shape first.
    snapshot() {
      return {
        available: !failed,
        error: failed,
        services,
        devices: [...view.byIp.entries()].flatMap(([ip, rows]) => rows.map((r) => ({ ...r, ip }))),
      };
    },
  };
}
