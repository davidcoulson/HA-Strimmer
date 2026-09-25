// mqtt_sensors.mjs — a handful of long-lived metrics, published for the recorder.
//
// The stats panel answers "what is happening right now". This answers "what has been happening
// for the last six months", which is a different question and needs a different mechanism: Home
// Assistant's long-term statistics, which only apply to real registered entities.
//
// Hence MQTT discovery rather than `POST /api/states`. States pushed over the REST API are not
// registered entities — they vanish on restart, never get a `unique_id`, and the recorder will
// not build statistics for them. Discovery entities are real, survive restarts, and can be
// renamed and assigned to areas like anything else.
//
// The set is deliberately small. Fifteen metrics that reward a trend line beat fifty that nobody
// opens, and every one here was chosen because a CHANGE in it means something:
//
//   - a jump in `entities_union` means a dashboard picked up a broad auto-entities filter
//   - `allowlist_rebuilds` climbing steadily is the rebuild storm this add-on already had once
//   - `trim_ratio` falling means the instance grew faster than the dashboards did
//   - `cert_days_left` is the one thing here that will page you at 3am if nobody watches it
//
// Everything is best-effort. No broker, bad credentials, or a broker that goes away must never
// affect proxying — publishing runs on a timer beside the request path and every failure is
// swallowed after one log line.

import mqtt from 'mqtt';
import tls from 'node:tls';

const DISCOVERY_PREFIX = 'homeassistant';
const NODE = 'strimmer';

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

const topicFor = (id) => `${DISCOVERY_PREFIX}/sensor/${NODE}/${id}/config`;
// Binary sensors live under their own component path in the discovery tree, which is why this is
// a second function rather than an argument.
const binaryTopicFor = (id) => `${DISCOVERY_PREFIX}/binary_sensor/${NODE}/${id}/config`;
// The one control this add-on exposes to Home Assistant, rather than another reading.
const switchTopicFor = (id) => `${DISCOVERY_PREFIX}/switch/${NODE}/${id}/config`;
const cmdTopic = `${DISCOVERY_PREFIX}/switch/${NODE}/set`;
const stateTopic = `${DISCOVERY_PREFIX}/sensor/${NODE}/state`;
const availTopic = `${DISCOVERY_PREFIX}/sensor/${NODE}/availability`;

// Ask Supervisor for the broker. An add-on never needs MQTT credentials in its own config when
// the Mosquitto add-on is installed — Supervisor hands them over, which is one fewer secret for
// a user to paste somewhere and one fewer thing to get wrong.
export async function brokerFromSupervisor(token, fetchImpl = fetch) {
  if (!token) return null;
  try {
    const res = await fetchImpl('http://supervisor/services/mqtt', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const { data } = await res.json();
    if (!data?.host) return null;
    return {
      url: `${data.ssl ? 'mqtts' : 'mqtt'}://${data.host}:${data.port ?? 1883}`,
      username: data.username || undefined,
      password: data.password || undefined,
    };
  } catch { return null; }
}

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

export function createPublisher({ version, log = () => {}, intervalMs = 60000 } = {}) {
  let client = null;
  let timer = null;
  let announced = false;
  let warned = false;

  const device = {
    identifiers: [NODE],
    name: 'Strimmer',
    manufacturer: 'Strimmer',
    model: 'Add-on',
    sw_version: version,
  };

  // Retained, so the entities come back by themselves after a Home Assistant restart without
  // waiting for the add-on's next publish.
  const announce = () => {
    for (const s of SENSORS) {
      const cfg = {
        name: s.name,
        unique_id: `${NODE}_${s.id}`,
        state_topic: stateTopic,
        availability_topic: availTopic,
        value_template: `{{ value_json.${s.id} }}`,
        unit_of_measurement: s.unit,
        icon: s.icon,
        state_class: s.sc,
        device,
      };
      try { client.publish(topicFor(s.id), JSON.stringify(cfg), { retain: true, qos: 0 }); } catch {}
    }
    for (const b of BINARY_SENSORS) {
      const cfg = {
        name: b.name,
        unique_id: `${NODE}_${b.id}`,
        state_topic: stateTopic,
        availability_topic: availTopic,
        value_template: `{{ value_json.${b.id} }}`,
        payload_on: 'on',
        payload_off: 'off',
        device_class: b.dc,
        icon: b.icon,
        device,
      };
      try { client.publish(binaryTopicFor(b.id), JSON.stringify(cfg), { retain: true, qos: 0 }); } catch {}
    }
    // A switch, so trimming can be turned off from the Home Assistant app — which is where you
    // already are when a dashboard is missing the entity you need to look at, and which works
    // over Cloudflare from anywhere.
    //
    // It pauses for ADMIN USERS, not everyone and not one person. MQTT carries a payload and not
    // an identity, so a switch cannot know who flipped it; the honest scope for an anonymous
    // control is a role. Administrators is the one that matches the purpose — they are who
    // troubleshoots — and it leaves every kiosk and wall panel trimmed and undisturbed.
    try {
      client.publish(switchTopicFor('trim_pause'), JSON.stringify({
        name: 'Trimming (admins)',
        unique_id: `${NODE}_trim_pause`,
        state_topic: stateTopic,
        command_topic: cmdTopic,
        availability_topic: availTopic,
        value_template: '{{ value_json.admin_trimming }}',
        state_on: 'on',
        state_off: 'off',
        payload_on: 'ON',
        payload_off: 'OFF',
        icon: 'mdi:content-cut',
        device,
      }), { retain: true, qos: 0 });
    } catch {}
    announced = true;
    log(`  MQTT: announced ${SENSORS.length} sensors, ${BINARY_SENSORS.length} binary sensor and 1 switch`);
  };

  return {
    async start({ token, snapshot, extras, onCommand }) {
      const broker = await brokerFromSupervisor(token);
      if (!broker) { log('  MQTT: no broker from Supervisor — long-term sensors disabled'); return false; }

      client = mqtt.connect(broker.url, {
        username: broker.username,
        password: broker.password,
        // LWT: if this add-on dies the entities go unavailable rather than freezing on their
        // last value, which would otherwise look like a healthy instance that stopped changing.
        will: { topic: availTopic, payload: 'offline', retain: true, qos: 0 },
        reconnectPeriod: 15000,
        connectTimeout: 10000,
      });

      client.on('connect', () => {
        log(`  MQTT: connected to ${broker.url}`);
        try { client.publish(availTopic, 'online', { retain: true }); } catch {}
        if (!announced) announce();
        // Re-subscribed on every connect, not once at start: a reconnect gives a fresh session
        // and the broker keeps no subscription for us, so a switch that worked before a broker
        // restart would quietly stop working after one.
        if (onCommand) {
          client.subscribe(cmdTopic, { qos: 0 }, (e) => {
            if (e) log(`  MQTT: could not subscribe to the switch topic (${e.message})`);
          });
        }
        // Publish immediately now that the socket is actually up. Doing this only from start()
        // raced the connection and was skipped every time.
        publish();
      });
      // The only inbound path. Deliberately narrow: one topic, two payloads, and anything else is
      // ignored rather than interpreted. Anyone who can publish to this broker can already
      // command every MQTT device in the house, and what this grants is the trim going off for
      // administrators for an hour — a performance change, not an access one, and one that
      // expires by itself.
      client.on('message', (topic, buf) => {
        if (topic !== cmdTopic || !onCommand) return;
        const want = String(buf).trim().toUpperCase();
        if (want !== 'ON' && want !== 'OFF') { log(`  MQTT: ignoring switch payload ${JSON.stringify(String(buf).slice(0, 20))}`); return; }
        try { onCommand(want === 'ON'); } catch (e) { log(`  MQTT: switch command failed (${e.message})`); }
        // Answer immediately rather than waiting for the interval, so the toggle in the app does
        // not spring back for up to a minute before settling where it was put.
        publish();
      });
      client.on('error', (e) => {
        // One line, then silence: a broker that is down produces an error per reconnect attempt.
        if (!warned) { warned = true; log(`  MQTT: ${e.message} — will keep retrying quietly`); }
      });

      let published = 0;
      function publish() {
        if (!client?.connected) return;
        try {
          const snap = snapshot();
          // Never publish before the allowlist exists. Every number here would be zero, and
          // because the state is retained that zero becomes the value Home Assistant shows —
          // and, worse, a real data point in long-term statistics. A restart would put a
          // spurious dip in every graph. Waiting costs at most one interval.
          if (!snap?.allowlist?.ready) return;
          const payload = buildPayload(snap, extras?.() ?? {});
          // Retained: Home Assistant gets the last value the moment it subscribes, rather than
          // showing `unknown` until the next interval. A non-retained state published before HA
          // had processed discovery was simply dropped.
          client.publish(stateTopic, JSON.stringify(payload), { qos: 0, retain: true });
          if (!published++) log(`  MQTT: publishing ${Object.keys(payload).length} metrics every ${intervalMs / 1000}s`);
        } catch (e) {
          // Once. A broken snapshot would otherwise produce a line a minute forever.
          if (published === 0) { published = 1; log(`  MQTT: publish failed (${e.message})`); }
        }
      }
      timer = setInterval(publish, intervalMs);
      timer.unref?.();
      return true;
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      try { client?.publish(availTopic, 'offline', { retain: true }); client?.end(true); } catch {}
      client = null;
    },
    sensorCount: SENSORS.length,
  };
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
