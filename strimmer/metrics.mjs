// The metrics this add-on publishes as real Home Assistant entities, and the values behind them.
//
// Transport-free on purpose: this module is the CATALOGUE — what exists, what each reading means
// and how it should be displayed — and `esphome_api.mjs` is the one thing that puts it on a wire.
// It was `mqtt_sensors.mjs` until 2026.09.25.3, when MQTT was removed: the ESPHome native API
// carries the same entities with no broker in between, so a second transport bought two copies of
// everything in Home Assistant and a Mosquitto dependency for nothing.
//
// Why these are entities at all, rather than a `rest:` sensor pointed at /stats.json: only real
// registered entities get long-term statistics. The console answers "what is happening now"; these
// answer "what has been happening since June", which is a different question — a slowly climbing
// entity count means a dashboard picked up a broad filter, and a rebuild counter that never stops
// rising is a fault invisible in any single snapshot.

// `dp` is how many decimals a reader should see. MQTT does not need it — a JSON number carries its
// own precision — but the ESPHome native API sends float32, so 74.3 arrives as 74.30000305175781
// and the transport has to be told where to cut it. It lives here rather than in that module so
// there is one catalogue, not two lists that drift.
//
// device_class + state_class are what make the recorder build long-term statistics. `measurement`
// keeps min/max/mean per hour; `total_increasing` keeps a sum that survives counter resets.
// Anything without a state_class is stored but never summarised, which for most of these would
// waste the point of publishing them at all.
const SENSORS = [
  // --- what is connected right now -------------------------------------------------------
  { id: 'clients_connected',  name: 'Clients connected',      unit: 'clients',  icon: 'mdi:monitor-multiple', sc: 'measurement' },
  { id: 'dashboards_served',  name: 'Dashboards served',      unit: 'dashboards', icon: 'mdi:view-dashboard', sc: 'measurement' },
  { id: 'mdns_devices',       name: 'Devices discovered',     unit: 'devices',  icon: 'mdi:lan', sc: 'measurement' },

  // --- what the trimming is doing --------------------------------------------------------
  { id: 'entities_union',     name: 'Entities forwarded',     unit: 'entities', icon: 'mdi:filter-check', sc: 'measurement' },
  { id: 'entities_instance',  name: 'Entities in instance',   unit: 'entities', icon: 'mdi:database', sc: 'measurement' },
  { id: 'trim_ratio',         name: 'Trim ratio',             unit: '%',        icon: 'mdi:percent', sc: 'measurement', dp: 1 },
  { id: 'payload_before_mb',  name: 'Payload before trim',    unit: 'MB',       icon: 'mdi:download', sc: 'measurement', dp: 2 },
  { id: 'payload_after_mb',   name: 'Payload after trim',     unit: 'MB',       icon: 'mdi:download-outline', sc: 'measurement', dp: 2 },

  // --- how it is behaving ----------------------------------------------------------------
  { id: 'event_rate_kb_min',  name: 'Event stream rate',      unit: 'kB/min',   icon: 'mdi:pulse', sc: 'measurement' },
  { id: 'cold_start_ms',      name: 'Cold start (median)',    unit: 'ms',       icon: 'mdi:timer-outline', sc: 'measurement' },
  { id: 'initial_payload_kb', name: 'Initial payload (median)', unit: 'kB',     icon: 'mdi:package-variant', sc: 'measurement' },

  // --- counters. total_increasing so a restart does not corrupt the long-term sum ---------
  { id: 'connections_total',  name: 'Connections served',     unit: 'connections', icon: 'mdi:counter', sc: 'total_increasing' },
  { id: 'rebuilds_total',     name: 'Allowlist rebuilds',     unit: 'rebuilds', icon: 'mdi:refresh', sc: 'total_increasing' },
  { id: 'cache_hits_total',   name: 'Registry cache hits',    unit: 'hits',     icon: 'mdi:lightning-bolt', sc: 'total_increasing' },

  // A rate rather than a count, because the count only ever rises and says nothing on its own.
  // This one falls when the allowlist keeps changing — a recompute retires the cache — so it is
  // the long-term signature of churn.
  { id: 'cache_hit_rate',     name: 'Registry cache hit rate', unit: '%',       icon: 'mdi:speedometer', sc: 'measurement', dp: 1 },

  // Worst event-loop stall since boot. Everything this proxy does to a frame happens on that one
  // loop, so this is the honest answer to "can one client hold up the others" — and the figure
  // docs/CLUSTERING.md turns on: single-digit milliseconds means a second process would buy
  // nothing. It belongs in long-term statistics rather than only the console, because the stall
  // worth catching is the one that happened at 3am a fortnight ago.
  { id: 'loop_delay_p99_ms',  name: 'Event loop delay (p99)', unit: 'ms',       icon: 'mdi:timer-sand', sc: 'measurement', dp: 1 },
  { id: 'loop_delay_max_ms',  name: 'Event loop delay (max)', unit: 'ms',       icon: 'mdi:timer-alert-outline', sc: 'measurement', dp: 1 },

  // How much longer the trim is paused for, 0 when it is not. See BINARY_SENSORS below for the
  // yes/no half of this. `measurement` like everything else here rather than an exemption from
  // that rule: the hourly mean of a countdown is a sawtooth, but a non-zero one is a true record
  // that trimming was off during that hour, which is exactly the thing worth finding a month
  // later when a panel was slow and nobody remembers why.
  { id: 'trim_paused_min',    name: 'Trim paused for',        unit: 'min',      icon: 'mdi:pause-circle-outline', sc: 'measurement' },

  // --- the one that is about the deployment rather than the traffic ----------------------
  { id: 'cert_days_left',     name: 'Certificate days left',  unit: 'd',        icon: 'mdi:certificate', sc: 'measurement' },
];


// Median, not mean: one wall panel that took nine seconds to wake should not define the number a
// six-month graph is drawn from.
function median(xs) {
  const s = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.floor(s.length / 2)];
}

const round = (n, p = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : null);

// Turn a stats snapshot into the flat payload the sensors read. Kept pure and exported so the
// interesting part — does a snapshot map onto sane numbers — is testable without a broker.
export function buildPayload(snap, extra = {}) {
  const clients = snap?.clients?.list ?? [];
  const before = snap?.savings?.before ?? 0;
  const after = snap?.savings?.after ?? 0;
  return {
    clients_connected: snap?.clients?.open ?? 0,
    dashboards_served: Object.keys(snap?.allowlist?.byDashboard ?? {}).length,
    mdns_devices: snap?.mdns?.devices?.length ?? 0,

    entities_union: snap?.allowlist?.union ?? 0,
    entities_instance: snap?.allowlist?.instanceEntities ?? 0,
    trim_ratio: snap?.savings?.savedPct ?? 0,
    payload_before_mb: round(before / 1048576, 2),
    payload_after_mb: round(after / 1048576, 2),

    event_rate_kb_min: round((snap?.eventStream?.bytesPerMin ?? 0) / 1024),
    cold_start_ms: median(clients.map((c) => c.msToEntityData)),
    initial_payload_kb: round((median(clients.map((c) => c.initialPayloadBytes)) ?? 0) / 1024),

    connections_total: snap?.clients?.total ?? 0,
    rebuilds_total: extra.rebuilds ?? 0,
    cache_hits_total: snap?.registryCache?.hits ?? 0,
    cache_hit_rate: snap?.registryCache?.hitRatePct ?? null,
    loop_delay_p99_ms: snap?.loopDelayMs?.p99 ?? null,
    loop_delay_max_ms: snap?.loopDelayMs?.max ?? null,

    // Is the trim actually doing anything right now? Off when the option is off, and off while
    // any user's pause is running — the state a sidebar badge or a conditional card asks for.
    trimming: extra.trimming === false || (snap?.pauses?.length ?? 0) > 0 ? 'off' : 'on',
    // The switch's own state: on unless ADMIN trimming is paused. Separate from `trimming` above,
    // which answers the broader "is anything trimmed right now" — a pause for one person must not
    // make the switch read as off, or flipping it on would appear to do nothing.
    admin_trimming: extra.trimming === false || (snap?.pauses ?? []).some((p) => p.role === 'admin') ? 'off' : 'on',
    // Minutes until the longest-running pause ends, 0 when nothing is paused, so a template can
    // count down without parsing a timestamp.
    trim_paused_min: (snap?.pauses?.length ?? 0)
      ? Math.max(0, Math.ceil(Math.max(...snap.pauses.map((p) => p.msLeft ?? 0)) / 60000))
      : 0,

    cert_days_left: extra.certDaysLeft ?? null,
  };
}

// Days until the certificate a client actually receives expires.
//
// Deliberately measured by connecting, not by reading a file. Whatever issues and renews the
// certificate — Nginx Proxy Manager here, something else elsewhere — the question worth answering
// is what a browser is being handed today. A renewal that succeeded into the wrong directory
// looks perfect on disk and still takes the dashboards down.
export function certDaysLeft(host, { port = 443, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!host) return resolve(null);
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const sock = tls.connect({
        host, port, servername: host,
        // Expiry is readable from a cert we do not trust, and refusing to report on a
        // self-signed or misissued cert would silence exactly the case worth alerting on.
        rejectUnauthorized: false,
        timeout: timeoutMs,
      }, () => {
        const cert = sock.getPeerCertificate();
        sock.end();
        const until = cert?.valid_to ? Date.parse(cert.valid_to) : NaN;
        finish(Number.isFinite(until) ? Math.floor((until - Date.now()) / 86400000) : null);
      });
      sock.on('error', () => { try { sock.destroy(); } catch {} finish(null); });
      sock.on('timeout', () => { try { sock.destroy(); } catch {} finish(null); });
    } catch { finish(null); }
  });
}

// One yes/no question — IS this thing trimming right now — published separately from the
// numbers because that is the shape the question has. A sensor reading "active"/"paused" would
// need string comparison everywhere it is used; a binary_sensor can be read by a sidebar badge,
// a conditional card or an automation with no template at all.
//
// `device_class: running` renders as Running/Not running in the UI and, more usefully, gives the
// entity the standard on/off semantics anything else can rely on. The countdown beside it is a
// plain number so a template can say "48 min left" without parsing a timestamp.
const BINARY_SENSORS = [
  { id: 'trimming', name: 'Trimming', dc: 'running', icon: 'mdi:content-cut' },
];

export { SENSORS, BINARY_SENSORS };
