// The same metrics as mqtt_sensors.mjs, published over ESPHome's native API instead of a broker.
//
// Why a second transport rather than a replacement. MQTT works and needs Mosquitto; the native
// API needs nothing but a port — Home Assistant's own `esphome` integration connects to us and
// the entities appear with history, statistics and a working switch. On an instance where
// everything else already speaks ESPHome (wall panels, sensors, Kiosk Satellite) that is one
// fewer moving part between this add-on and the entities it publishes. Neither is the default:
// both are options, and both can run at once, which is also how they get compared.
//
// THE CATALOGUE IS SHARED. Entities are built from `SENSORS` / `BINARY_SENSORS` in
// mqtt_sensors.mjs and values from its `buildPayload`, so the two transports cannot disagree
// about what exists or what a number says. A sensor added there appears here for free.
//
// `esphome-device` does the protocol: Noise, framing, the entity messages, mDNS. It is a plain
// ESM package with no native bindings, which is the rule for anything this image takes.

import { Device } from 'esphome-device';
import { SENSORS, BINARY_SENSORS, buildPayload } from './mqtt_sensors.mjs';

// The node name. Entity ids are `<node>_<object id>`, and the MAC Home Assistant identifies the
// device by is derived from it — so this string is the thing that must never change casually:
// a different name is a different device, with new entities and no history.
export const NODE = 'strimmer';

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
    async start({ snapshot, extras, onCommand, port, noiseKey, allowPlaintext, mdns }) {
      snapshotFn = snapshot;
      extrasFn = extras;
      dev = new DeviceClass({
        name: NODE,
        friendlyName: 'Strimmer',
        port,
        noiseKey: noiseKey || undefined,
        allowPlaintext: noiseKey ? Boolean(allowPlaintext) : undefined,
        mdns,
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
        + `${noiseKey ? ' (encrypted)' : ' (PLAINTEXT — set esphome_key)'}`);
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
