// Publishing the metrics over ESPHome's native API.
//
// The protocol itself is `esphome-device`'s problem and is tested there against `aioesphomeapi`,
// the client Home Assistant actually uses. What matters HERE is the mapping: that the entities
// this add-on declares carry the metadata that decides whether Home Assistant stores them
// usefully, that their ids cannot drift with a display name, that values come from the same
// catalogue, and that the switch reports what really took effect.
//
// Built on the library's own FakeDevice (0.2.0+), not a hand-rolled stand-in. It uses the real
// entity classes, so `declared` records what would actually go over the wire — state_class as the
// protocol's enum, the unit, the decimals — rather than echoing back the options we passed. A
// hand-written fake can agree with our code while both disagree with the library; this cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDevice } from 'esphome-device/testing';
import { StateClass } from 'esphome-device';
import { createPublisher, NODE } from '../esphome_api.mjs';
import { SENSORS, BINARY_SENSORS } from '../metrics.mjs';

const READY = {
  allowlist: { ready: true, union: 470, byDashboard: { lovelace: 1 }, instanceEntities: 9751 },
  clients: { open: 3, total: 120, list: [] },
  savings: { before: 2_000_000, after: 500_000, savedPct: 75 },
  registryCache: { hits: 9616, misses: 126 },
  eventStream: { bytesPerMin: 4096 },
  loopDelayMs: { p99: 6.8, max: 46 },
  pauses: [],
};

// Start a publisher on a FakeDevice and hand back both. The subclass only captures the instance
// the publisher constructs, so the test can inspect it.
async function start({ snapshot = () => READY, extras = () => ({ rebuilds: 7, certDaysLeft: 61, trimming: true }),
  onCommand = () => {}, noiseKey = 'aGVsbG8gdGhlcmUgdGhpcyBpcyAzMiBieXRlcyEh' } = {}) {
  let dev;
  class Captured extends FakeDevice { constructor(o) { super(o); dev = this; } }
  const pub = createPublisher({ version: '2026.09.25.9', DeviceClass: Captured, intervalMs: 1e9 });
  await pub.start({ snapshot, extras, onCommand, port: 6053, noiseKey });
  return { pub, dev };
}
const state = (dev, id) => dev.entities.get(id).state;

test('declares every catalogued entity, and nothing else', async () => {
  const { dev } = await start();
  const of = (kind) => dev.declared.filter((d) => d.kind === kind);
  assert.equal(of('sensor').length, SENSORS.length);
  assert.equal(of('binary_sensor').length, BINARY_SENSORS.length);
  assert.equal(of('switch').length, 1);
  assert.equal(dev.declared.length, SENSORS.length + BINARY_SENSORS.length + 1);
});

test('every sensor reaches Home Assistant with the state class that makes long-term statistics', async () => {
  const { dev } = await start();
  const want = { measurement: StateClass.MEASUREMENT, total_increasing: StateClass.TOTAL_INCREASING };
  for (const s of SENSORS) {
    const d = dev.declared.find((x) => x.objectId === s.id);
    assert.ok(d, `${s.id} was not declared`);
    // The protocol's enum, as HA receives it — not the string we passed in. NONE here would mean
    // the recorder keeps raw history only, which is the one thing these sensors exist to avoid.
    assert.equal(d.state_class, want[s.sc], `${s.id} reaches HA with state_class ${d.state_class}`);
    assert.equal(d.unit_of_measurement, s.unit, `${s.id} unit`);
    assert.equal(d.icon, s.icon, `${s.id} icon`);
    // Values cross as float32, so 74.3 arrives as 74.30000305175781 unless the display is told
    // where to stop.
    assert.equal(d.accuracy_decimals, s.dp ?? 0, `${s.id} decimals`);
  }
});

test('ids are the catalogue\'s, so renaming a sensor cannot orphan its history', async () => {
  // Left out, the library derives an object id from the display NAME — and for several of these
  // the derived id differs: "Cold start (median)" would become cold_start_median, not
  // cold_start_ms. A rename would then create a new entity in Home Assistant and abandon the old
  // one's statistics, silently and permanently.
  const { dev } = await start();
  for (const s of SENSORS) assert.ok(dev.entities.has(s.id), `${s.id} is not declared under its catalogue id`);
  for (const b of BINARY_SENSORS) assert.ok(dev.entities.has(b.id), `${b.id} is not declared under its catalogue id`);
  assert.ok(dev.entities.has('trim_pause'));
});

test('publishes the catalogue\'s values', async () => {
  const { dev } = await start();
  assert.equal(state(dev, 'clients_connected'), 3);
  assert.equal(state(dev, 'entities_union'), 470);
  assert.equal(state(dev, 'trim_ratio'), 75);
  assert.equal(state(dev, 'rebuilds_total'), 7);
  assert.equal(state(dev, 'loop_delay_p99_ms'), 6.8);
  assert.equal(state(dev, 'trimming'), true);
});

test('a reading with no answer yet is unknown, not zero', async () => {
  // A missing measurement published as 0 becomes a real data point the recorder keeps forever.
  const { dev } = await start({ snapshot: () => ({ ...READY, loopDelayMs: { p99: null, max: null } }), extras: () => ({}) });
  assert.ok(Number.isNaN(state(dev, 'loop_delay_p99_ms')));
});

test('nothing is published before the allowlist is ready', async () => {
  // Every value would be zero, and a zero here is a real point in long-term statistics that a
  // restart would leave as a dip in every graph.
  const { dev } = await start({ snapshot: () => ({ allowlist: { ready: false } }), extras: () => ({}) });
  assert.equal(dev.entities.get('clients_connected').sets.length, 0);
});

test('push() publishes at once — the first values after a restart do not wait for the tick', async () => {
  let ready = false;
  const { pub, dev } = await start({ snapshot: () => (ready ? READY : { allowlist: { ready: false } }) });
  assert.equal(dev.entities.get('clients_connected').sets.length, 0);
  ready = true;
  pub.push();
  assert.equal(state(dev, 'clients_connected'), 3, 'the allowlist became ready and the values went out');
});

test('the switch reports what actually took effect, not what was asked', async () => {
  // Returning the requested value would make a refused or expired pause look applied; the toggle
  // in Home Assistant has to settle on the truth.
  let paused = false;
  const { dev } = await start({
    snapshot: () => ({ ...READY, pauses: paused ? [{ user: 'role:admin', role: 'admin', msLeft: 60000 }] : [] }),
    extras: () => ({ trimming: true }),
    onCommand: (on) => { paused = !on; },
  });
  assert.equal(await dev.command('trim_pause', false), false, 'turning it off reports trimming paused');
  assert.equal(paused, true);
  assert.equal(await dev.command('trim_pause', true), true, 'and back on reports it resumed');
  assert.equal(paused, false);
});

test('a command that changes nothing still reports the real state', async () => {
  const { dev } = await start({
    snapshot: () => ({ ...READY, pauses: [{ user: 'role:admin', role: 'admin', msLeft: 60000 }] }),
    extras: () => ({ trimming: true }),
    onCommand: () => {},          // a no-op: the pause stays on
  });
  assert.equal(await dev.command('trim_pause', true), false, 'the toggle springs back, because nothing changed');
});

test('the node name is fixed, because Home Assistant identifies the device by it', async () => {
  // The MAC HA uses as the device's unique id is derived from this name. Changing it makes a new
  // device with new entities and no history.
  assert.equal(NODE, 'strimmer');
  const { dev } = await start();
  assert.equal(dev.name, 'strimmer');
  assert.equal(dev.friendlyName, 'Strimmer');
  assert.equal(dev.deviceInfo().mac_address, 'CA:E5:60:FC:F0:F7',
    'the MAC Home Assistant already knows this device by — a different one is a different device');
});

test('stop() closes the device', async () => {
  const { pub, dev } = await start();
  assert.equal(dev.started, true);
  await pub.stop();
  assert.equal(dev.started, false);
});

// Which address Home Assistant is told to connect to. It stores whatever it discovers, so an
// address that can vanish — Tailscale's — makes the device unavailable whenever that interface
// goes, even though HA and the add-on share a machine. The interface list here is the real one
// from the Home Assistant OS host this was found on.
import { pickAdvertiseAddress } from '../esphome_api.mjs';
const HOST = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  enp6s18: [{ address: '10.2.3.6', family: 'IPv4', internal: false }],
  enp6s19: [{ address: '10.2.4.6', family: 'IPv4', internal: false }],
  hassio: [{ address: '172.30.32.1', family: 'IPv4', internal: false }],
  docker0: [{ address: '172.30.232.1', family: 'IPv4', internal: false }],
  tailscale0: [{ address: '100.86.127.109', family: 'IPv4', internal: false }],
};

test('advertises the LAN address, never Tailscale\'s', () => {
  assert.equal(pickAdvertiseAddress(HOST), '10.2.3.6');
});

test('prefers a LAN address over a Docker bridge, and a bridge over nothing', () => {
  const bridgesOnly = { hassio: HOST.hassio, tailscale0: HOST.tailscale0 };
  assert.equal(pickAdvertiseAddress(bridgesOnly), '172.30.32.1');
  const withHome = { docker0: HOST.docker0, wlan0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }] };
  assert.equal(pickAdvertiseAddress(withHome), '192.168.1.20');
});

test('gives no answer rather than a bad one', () => {
  // Carrier-grade NAT (Tailscale), link-local and loopback are never advertised; with nothing
  // else left, the library's own default applies, which is no worse than before.
  assert.equal(pickAdvertiseAddress({ lo: HOST.lo, tailscale0: HOST.tailscale0,
    eth0: [{ address: '169.254.10.1', family: 'IPv4', internal: false }] }), null);
});

test('passes the chosen address to the device', async () => {
  let dev;
  class Captured extends FakeDevice { constructor(o) { super(o); dev = this; } }
  const pub = createPublisher({ version: 'x', DeviceClass: Captured, intervalMs: 1e9 });
  await pub.start({ snapshot: () => READY, extras: () => ({}), port: 6053, mdns: true, interfaces: HOST });
  assert.deepEqual(dev.opts.mdns, { address: '10.2.3.6' });
  await pub.stop();
});
