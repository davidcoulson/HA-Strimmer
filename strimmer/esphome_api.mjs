// The metrics, published over ESPHome's native API.
//
// This is now the ONLY transport. MQTT discovery did the same job until 2026.09.25.3 and needed
// Mosquitto to do it; the native API needs nothing but a port — Home Assistant's own `esphome`
// integration connects to us and the entities appear with history, statistics and a working
// switch. Running both was how they were compared, and it also showed the cost of keeping both:
// two copies of every entity in Home Assistant, the second suffixed `_2`.
//
// Entities are built from `SENSORS` / `BINARY_SENSORS` in metrics.mjs and their values from its
// `buildPayload`. A metric added to that catalogue appears here for free; nothing about a metric
// is declared in this file.
//
// `esphome-device` does the protocol: Noise, framing, the entity messages, mDNS. It is a plain
// ESM package with no native bindings, which is the rule for anything this image takes.

import os from 'node:os';
import { Device } from 'esphome-device';
import { SENSORS, BINARY_SENSORS, buildPayload } from './metrics.mjs';

// The node name. Entity ids are `<node>_<object id>`, and the MAC Home Assistant identifies the
// device by is derived from it — so this string is the thing that must never change casually:
// a different name is a different device, with new entities and no history.
export const NODE = 'strimmer';

// Which address to advertise over mDNS — Home Assistant stores whatever it discovers and connects
// to it from then on.
//
// Left to itself the library advertises EVERY non-loopback IPv4 the machine has, and on a Home
// Assistant OS host with host networking that means the Supervisor and Docker bridges and, if the
// Tailscale add-on is running, the tailnet address too. Home Assistant picked 100.86.127.109 —
// Tailscale — so its connection to a device on the SAME machine ran through the tailnet interface,
// and would have gone unavailable whenever Tailscale stopped. A LAN address cannot disappear that
// way. Preference: 10/8 and 192.168/16 first, then 172.16/12 (the bridges, stable but internal),
// never 100.64/10 (carrier-grade NAT, which is where Tailscale lives) or link-local. Interface order
// breaks ties, so the answer is stable across restarts. Null means "no good answer; let the library
// decide", which is no worse than before.
export function pickAdvertiseAddress(ifaces = os.networkInterfaces()) {
  const rank = (ip) => {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || (a === 192 && b === 168)) return 0;
    if (a === 172 && b >= 16 && b <= 31) return 1;
    return null;        // 100.64/10, 169.254/16, public addresses: never advertised
  };
  let best = null;
  for (const addrs of Object.values(ifaces)) {
    for (const x of addrs || []) {
      if (x.family !== 'IPv4' && x.family !== 4) continue;
      if (x.internal) continue;
      const r = rank(x.address);
      if (r === null) continue;
      if (!best || r < best.r) best = { r, ip: x.address };
    }
  }
  return best ? best.ip : null;
}

export function createPublisher({ version, log = () => {}, intervalMs = 60000, DeviceClass = Device } = {}) {
  let dev = null;
  let timer = null;
  let entities = null;
  let snapshotFn = null;
  let extrasFn = null;

  // The values both transports publish, from the one builder. Returns null when the allowlist is
  // not ready yet — the same guard MQTT uses, and for the same reason: every number would be
  // zero, and a zero recorded here becomes a real point in long-term statistics.
  const values = () => {
    const snap = snapshotFn?.();
    if (!snap?.allowlist?.ready) return null;
    return buildPayload(snap, extrasFn?.() ?? {});
  };

  // Push whatever changed. `.set()` is a no-op when the value is equal, and the library sends
  // only changes, so this is cheap to call often and safe to call on a timer.
  function publish() {
    const v = values();
    if (!v || !entities) return;
    for (const [id, ent] of entities.sensors) {
      const n = v[id];
      // NaN, not 0, for "no answer yet". A missing reading published as zero is a lie the
      // recorder keeps forever; NaN reaches Home Assistant as `unknown`, which is the truth.
      ent.set(typeof n === 'number' && Number.isFinite(n) ? n : NaN);
    }
    for (const [id, ent] of entities.binary) ent.set(v[id] === 'on');
    entities.pause?.set(v.admin_trimming === 'on');
  }

  return {
    async start({ snapshot, extras, onCommand, port, noiseKey, allowPlaintext, mdns, interfaces }) {
      snapshotFn = snapshot;
      extrasFn = extras;
      const advertise = mdns === false ? null : pickAdvertiseAddress(interfaces);
      dev = new DeviceClass({
        name: NODE,
        friendlyName: 'Strimmer',
        port,
        noiseKey: noiseKey || undefined,
        allowPlaintext: noiseKey ? Boolean(allowPlaintext) : undefined,
        // An explicit address unless the caller turned advertising off or chose one itself.
        mdns: mdns === false ? false
          : (mdns && typeof mdns === 'object') ? mdns
          : (advertise ? { address: advertise } : true),
        project: { name: 'davidcoulson.strimmer', version },
        model: 'Add-on',
        manufacturer: 'Strimmer',
        // Its own logger, at the volume of the rest of this app: connect, disconnect, and
        // silence. The library's default is `console`, which would bypass the log level.
        log: { info: (m) => log(`  ESPHome: ${m}`), warn: (m) => log(`  ESPHome: ${m}`) },
      });

      // `id` is passed explicitly for every entity. Left out, the library derives the object id
      // from the display NAME — so renaming "Trim ratio" would orphan the old entity and start a
      // new one with no history. The catalogue's id is the stable thing; the name is not.
      const sensors = new Map();
      for (const s of SENSORS) {
        sensors.set(s.id, dev.sensor({
          id: s.id,
          name: s.name,
          unit: s.unit,
          icon: s.icon,
          stateClass: s.sc,
          // Values cross as float32, so the display needs telling where to stop. Counts are
          // integers; ratios and megabytes are not.
          accuracyDecimals: s.dp ?? 0,
        }));
      }
      const binary = new Map();
      for (const b of BINARY_SENSORS) {
        binary.set(b.id, dev.binarySensor({ id: b.id, name: b.name, deviceClass: b.dc, icon: b.icon }));
      }

      // The one control. Its handler returns what ACTUALLY took effect rather than what was
      // asked for: the toggle in Home Assistant then settles on the truth instead of springing
      // back a moment later, and a refused or clamped command shows as refused.
      const pause = onCommand
        ? dev.switch({ id: 'trim_pause', name: 'Trimming (admins)', icon: 'mdi:content-cut', state: true }, async (on) => {
          await onCommand(on);
          const v = values();
          return v ? v.admin_trimming === 'on' : on;
        })
        : null;

      entities = { sensors, binary, pause };
      await dev.start();
      log(`  ESPHome API: ${sensors.size} sensors, ${binary.size} binary sensor`
        + `${pause ? ' and 1 switch' : ''} on port ${dev.port}`
        + `${noiseKey ? ' (encrypted)' : ' (PLAINTEXT — set esphome_key)'}`
        + `${mdns === false ? '' : advertise ? `, advertised at ${advertise}` : ', advertised on every address'}`);
      publish();
      timer = setInterval(publish, intervalMs);
      timer.unref?.();
      return true;
    },

    // Called when something changed that a reader should see at once — a pause starting or
    // ending — rather than waiting out the sampling interval.
    push() { try { publish(); } catch {} },

    async stop() {
      if (timer) { clearInterval(timer); timer = null; }
      try { await dev?.stop(); } catch {}
      dev = null; entities = null;
    },

    get port() { return dev?.port ?? null; },
  };
}
