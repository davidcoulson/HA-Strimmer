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

// Fold one mDNS response into { instances, hosts }.
//
// Kept as a pure function over the answer list so the interesting part — "did we understand this
// packet" — is testable without a network, a socket, or a real device on the segment.
export function ingest(packet, services, state) {
  const answers = [...(packet?.answers || []), ...(packet?.additionals || [])];
  const wanted = new Set(services);
  let changed = false;

  // PTR: service type -> instance name. SRV: instance -> host + port. TXT: instance -> metadata.
  // A: host -> address. A device usually sends all four together, but not always, so each record
  // is folded in independently and an instance becomes useful once it has an address.
  for (const a of answers) {
    if (!a || typeof a.name !== 'string') continue;
    if (a.type === 'PTR' && wanted.has(a.name) && typeof a.data === 'string') {
      const inst = state.instances.get(a.data) || { instance: a.data, service: a.name };
      inst.service = a.name;
      state.instances.set(a.data, inst);
      changed = true;
    } else if (a.type === 'SRV' && a.data?.target) {
      const inst = state.instances.get(a.name);
      if (inst) { inst.host = a.data.target; inst.port = a.data.port ?? null; changed = true; }
    } else if (a.type === 'TXT') {
      const inst = state.instances.get(a.name);
      if (inst) { inst.txt = parseTxt(a.data); changed = true; }
    } else if (a.type === 'A' && typeof a.data === 'string') {
      state.hosts.set(a.name, a.data);
      changed = true;
    }
  }
  return changed;
}

// Flatten instances + host addresses into address -> device, which is the only shape the rest of
// the add-on asks for. An instance with no resolvable address is simply absent.
export function index(state) {
  const byIp = new Map();
  const byHost = new Map();
  for (const inst of state.instances.values()) {
    const ip = inst.host ? state.hosts.get(inst.host) : null;
    if (inst.host && ip) byHost.set(inst.host.replace(/\.$/, '').toLowerCase(), ip);
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
  for (const [host, ip] of state.hosts) {
    const k = host.replace(/\.$/, '').toLowerCase();
    if (!byHost.has(k)) byHost.set(k, ip);
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
    try {
      mdns.query({ questions: services.map((name) => ({ name, type: 'PTR' })) });
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
      return view.byHost.get(host.replace(/\.$/, '').toLowerCase()) ?? null;
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
