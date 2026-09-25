// Publishing the metrics over ESPHome's native API.
//
// The protocol itself is `esphome-device`'s problem and is tested there against `aioesphomeapi`,
// the client Home Assistant actually uses. What matters HERE is the mapping: that the entities
// this add-on declares carry the metadata that decides whether Home Assistant stores them
// usefully, that their ids cannot drift with a display name, that values come from the same
// builder MQTT uses, and that the switch reports what really took effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublisher, NODE } from '../esphome_api.mjs';
import { SENSORS, BINARY_SENSORS } from '../metrics.mjs';

// A stand-in for the library, so these tests are about the mapping and not about TCP. It records
// what was declared and what was set.
function fakeDeviceClass() {
  class Fake {
    constructor(opts) { this.opts = opts; this.declared = []; this.started = false; this.port = opts.port; }
    #entity(kind, opts, handler) {
      this.declared.push({ kind, ...opts });
      const ent = { opts, state: opts.state, handler, sets: [] };
      ent.set = (v) => { ent.sets.push(v); const changed = !Object.is(ent.state, v); ent.state = v; return changed; };
      (this.entities ??= new Map()).set(`${kind}:${opts.id}`, ent);
      return ent;
    }
    sensor(o) { return this.#entity('sensor', o); }
    binarySensor(o) { return this.#entity('binary_sensor', o); }
    switch(o, h) { return this.#entity('switch', o, h); }
    async start() { this.started = true; }
    async stop() { this.started = false; }
  }
  return Fake;
}

const READY = {
  allowlist: { ready: true, union: 470, byDashboard: { lovelace: 1 }, instanceEntities: 9751 },
  clients: { open: 3, total: 120, list: [] },
  savings: { before: 2_000_000, after: 500_000, savedPct: 75 },
  registryCache: { hits: 9616, misses: 126 },
  eventStream: { bytesPerMin: 4096 },
  loopDelayMs: { p99: 6.8, max: 46 },
  pauses: [],
};

async function startFake(overrides = {}) {
  const Fake = fakeDeviceClass();
  const pub = createPublisher({ version: '2026.09.25.1', DeviceClass: Fake, intervalMs: 1e9 });
  let dev;
  const orig = Fake.prototype.start;
  Fake.prototype.start = function start(...a) { dev = this; return orig.apply(this, a); };
  await pub.start({
    snapshot: () => READY,
    extras: () => ({ rebuilds: 7, certDaysLeft: 61, trimming: true }),
    onCommand: () => {},
    port: 6053,
    noiseKey: 'aGVsbG8gdGhlcmUgdGhpcyBpcyAzMiBieXRlcyEh',
    ...overrides,
  });
  return { pub, dev };
}

test('declares every catalogued entity, and nothing else', async () => {
  const { dev } = await startFake();
  const sensors = dev.declared.filter((d) => d.kind === 'sensor');
  const binary = dev.declared.filter((d) => d.kind === 'binary_sensor');
  const switches = dev.declared.filter((d) => d.kind === 'switch');
  assert.equal(sensors.length, SENSORS.length);
  assert.equal(binary.length, BINARY_SENSORS.length);
  assert.equal(switches.length, 1);
  // One catalogue feeds both transports; a sensor added to it must appear here without anyone
  // remembering to add it twice.
  assert.deepEqual(sensors.map((s) => s.id).sort(), SENSORS.map((s) => s.id).sort());
});

test('every sensor carries the state class that makes long-term statistics', async () => {
  const { dev } = await startFake();
  for (const s of dev.declared.filter((d) => d.kind === 'sensor')) {
    assert.ok(['measurement', 'total_increasing'].includes(s.stateClass),
      `${s.id} would be stored as raw history only`);
    assert.ok(s.unit && s.icon && s.name, `${s.id} is missing display metadata`);
    assert.equal(typeof s.accuracyDecimals, 'number',
      `${s.id} needs decimals: values cross as float32, so 74.3 arrives as 74.30000305175781`);
  }
});

test('ids are declared explicitly, so renaming a sensor cannot orphan its history', async () => {
  // The library derives an object id from the display NAME when none is given. A tidy-up of
  // wording would then create a new entity in Home Assistant and abandon the old one's
  // statistics — the failure this pins is silent and permanent.
  const { dev } = await startFake();
  for (const d of dev.declared) assert.ok(d.id, `${d.name} was declared without an id`);
  const ratio = dev.declared.find((d) => d.id === 'trim_ratio');
  assert.equal(ratio.accuracyDecimals, 1);
  assert.equal(dev.declared.find((d) => d.id === 'payload_before_mb').accuracyDecimals, 2);
  assert.equal(dev.declared.find((d) => d.id === 'clients_connected').accuracyDecimals, 0);
});

test('publishes the same numbers MQTT would', async () => {
  const { dev } = await startFake();
  const get = (id) => dev.entities.get(`sensor:${id}`).state;
  assert.equal(get('clients_connected'), 3);
  assert.equal(get('entities_union'), 470);
  assert.equal(get('trim_ratio'), 75);
  assert.equal(get('rebuilds_total'), 7);
  assert.equal(get('loop_delay_p99_ms'), 6.8);
  assert.equal(dev.entities.get('binary_sensor:trimming').state, true);
});

test('a reading with no answer yet is unknown, not zero', async () => {
  // A missing measurement published as 0 becomes a real data point the recorder keeps forever.
  const Fake = fakeDeviceClass();
  const pub = createPublisher({ version: 'x', DeviceClass: Fake, intervalMs: 1e9 });
  let dev;
  const orig = Fake.prototype.start;
  Fake.prototype.start = function start(...a) { dev = this; return orig.apply(this, a); };
  await pub.start({
    snapshot: () => ({ ...READY, loopDelayMs: { p99: null, max: null } }),
    extras: () => ({}),
    port: 0,
  });
  assert.ok(Number.isNaN(dev.entities.get('sensor:loop_delay_p99_ms').state));
});

test('nothing is published before the allowlist is ready', async () => {
  const Fake = fakeDeviceClass();
  const pub = createPublisher({ version: 'x', DeviceClass: Fake, intervalMs: 1e9 });
  let dev;
  const orig = Fake.prototype.start;
  Fake.prototype.start = function start(...a) { dev = this; return orig.apply(this, a); };
  await pub.start({ snapshot: () => ({ allowlist: { ready: false } }), extras: () => ({}), port: 0 });
  // Every value would be zero, and a zero here is a real point in long-term statistics that a
  // restart would leave as a dip in every graph.
  assert.equal(dev.entities.get('sensor:clients_connected').sets.length, 0);
});

test('the switch reports what actually took effect, not what was asked', async () => {
  // Returning the requested value would make a refused or expired pause look applied; the toggle
  // in Home Assistant has to settle on the truth.
  let paused = false;
  const snapshot = () => ({ ...READY, pauses: paused ? [{ user: 'role:admin', role: 'admin', msLeft: 60000 }] : [] });
  const Fake = fakeDeviceClass();
  const pub = createPublisher({ version: 'x', DeviceClass: Fake, intervalMs: 1e9 });
  let dev;
  const orig = Fake.prototype.start;
  Fake.prototype.start = function start(...a) { dev = this; return orig.apply(this, a); };
  await pub.start({
    snapshot, extras: () => ({ trimming: true }), port: 0,
    onCommand: (on) => { paused = !on; },
  });
  const sw = dev.entities.get('switch:trim_pause');
  assert.equal(await sw.handler(false), false, 'turning it off reports trimming paused');
  assert.equal(paused, true);
  assert.equal(await sw.handler(true), true, 'and back on reports it resumed');
  assert.equal(paused, false);
});

test('a command that changes nothing still reports the real state', async () => {
  const Fake = fakeDeviceClass();
  const pub = createPublisher({ version: 'x', DeviceClass: Fake, intervalMs: 1e9 });
  let dev;
  const orig = Fake.prototype.start;
  Fake.prototype.start = function start(...a) { dev = this; return orig.apply(this, a); };
  await pub.start({
    snapshot: () => ({ ...READY, pauses: [{ user: 'role:admin', role: 'admin', msLeft: 60000 }] }),
    extras: () => ({ trimming: true }), port: 0,
    onCommand: () => {},          // a no-op: the pause stays on
  });
  const sw = dev.entities.get('switch:trim_pause');
  assert.equal(await sw.handler(true), false, 'the toggle springs back, because nothing changed');
});

test('the node name is fixed, because Home Assistant identifies the device by it', async () => {
  // The MAC HA uses as the device's unique id is derived from this name. Changing it makes a new
  // device with new entities and no history.
  assert.equal(NODE, 'strimmer');
  const { dev } = await startFake();
  assert.equal(dev.opts.name, 'strimmer');
  assert.equal(dev.opts.friendlyName, 'Strimmer');
});

test('stop() closes the device and stops sampling', async () => {
  const { pub, dev } = await startFake();
  assert.equal(dev.started, true);
  await pub.stop();
  assert.equal(dev.started, false);
});
