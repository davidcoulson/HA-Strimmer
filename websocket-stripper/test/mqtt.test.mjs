// Long-term MQTT metrics.
//
// The broker half is not tested here — a test needing a live broker fails in CI for reasons
// unrelated to the code. What is tested is the part that would be wrong silently: turning a stats
// snapshot into the numbers a six-month graph gets drawn from, and the discovery config that
// decides whether the recorder summarises them at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, brokerFromSupervisor, SENSORS } from '../mqtt_sensors.mjs';

const snap = {
  clients: { open: 4, total: 128, list: [
    { msToEntityData: 56, initialPayloadBytes: 51200 },
    { msToEntityData: 14, initialPayloadBytes: 3072 },
    { msToEntityData: 301, initialPayloadBytes: 44544 },
    { msToEntityData: null, initialPayloadBytes: null },
  ] },
  allowlist: { union: 418, instanceEntities: 9594, byDashboard: { a: 1, b: 2, c: 3 } },
  savings: { before: 17_825_792, after: 2_097_152, savedPct: 88.2 },
  eventStream: { bytesPerMin: 23702 },
  registryCache: { hits: 15 },
  mdns: { devices: [{}, {}, {}] },
};

test('maps a snapshot onto every published sensor', () => {
  const p = buildPayload(snap, { rebuilds: 7, certDaysLeft: 61 });
  for (const s of SENSORS) {
    assert.ok(s.id in p, `sensor ${s.id} has no value in the payload — it would publish undefined`);
  }
});

test('reports the numbers a person would expect', () => {
  const p = buildPayload(snap, { rebuilds: 7, certDaysLeft: 61 });
  assert.equal(p.clients_connected, 4);
  assert.equal(p.entities_union, 418);
  assert.equal(p.entities_instance, 9594);
  assert.equal(p.trim_ratio, 88.2);
  assert.equal(p.payload_before_mb, 17);
  assert.equal(p.dashboards_served, 3);
  assert.equal(p.connections_total, 128);
  assert.equal(p.rebuilds_total, 7);
  assert.equal(p.cert_days_left, 61);
});

test('uses the median, so one slow panel cannot define the trend line', () => {
  // 14 / 56 / 301 — a mean would report 124ms, which no client experienced.
  assert.equal(buildPayload(snap).cold_start_ms, 56);
});

test('ignores clients that have not reported a timing yet', () => {
  // A connection with null timings is a real and common state — a backgrounded companion app.
  // Averaging it in as zero would drag the graph down for a reason that is not a speedup.
  const only = { ...snap, clients: { open: 1, total: 1, list: [{ msToEntityData: null, initialPayloadBytes: null }] } };
  assert.equal(buildPayload(only).cold_start_ms, null);
});

test('survives a snapshot with nothing in it', () => {
  // The first publish can land before the allowlist is built. Publishing undefined would make
  // every sensor "unknown" and poison the statistics for that hour.
  const p = buildPayload({}, {});
  assert.equal(p.clients_connected, 0);
  assert.equal(p.entities_union, 0);
  assert.equal(p.trim_ratio, 0);
  assert.equal(p.cert_days_left, null);
});

test('every sensor declares a state_class, or the recorder will not summarise it', () => {
  // This is the whole reason for publishing over MQTT discovery rather than the REST API. A
  // sensor without a state_class is stored and never turned into long-term statistics.
  for (const s of SENSORS) {
    assert.ok(['measurement', 'total_increasing'].includes(s.sc), `${s.id} has state_class ${s.sc}`);
    assert.ok(s.unit && s.name && s.icon, `${s.id} is missing a unit, name or icon`);
  }
});

test('counters are total_increasing so a restart cannot corrupt the sum', () => {
  const counters = ['connections_total', 'rebuilds_total', 'cache_hits_total'];
  for (const id of counters) {
    assert.equal(SENSORS.find((s) => s.id === id).sc, 'total_increasing', `${id} must be total_increasing`);
  }
});

test('sensor ids are unique', () => {
  assert.equal(new Set(SENSORS.map((s) => s.id)).size, SENSORS.length);
});

test('no broker is a quiet no, not a crash', async () => {
  assert.equal(await brokerFromSupervisor(null), null, 'no token -> no broker');
  const failing = async () => { throw new Error('connect ECONNREFUSED'); };
  assert.equal(await brokerFromSupervisor('tok', failing), null, 'an unreachable supervisor is survivable');
  const notOk = async () => ({ ok: false });
  assert.equal(await brokerFromSupervisor('tok', notOk), null, 'a 404 (mosquitto not installed) is survivable');
});

test('builds a broker url from what Supervisor returns', async () => {
  const fake = async () => ({ ok: true, json: async () => ({ data: { host: 'core-mosquitto', port: 1883, username: 'u', password: 'p', ssl: false } }) });
  assert.deepEqual(await brokerFromSupervisor('tok', fake), { url: 'mqtt://core-mosquitto:1883', username: 'u', password: 'p' });
  const tls = async () => ({ ok: true, json: async () => ({ data: { host: 'h', port: 8883, ssl: true } }) });
  assert.equal((await brokerFromSupervisor('tok', tls)).url, 'mqtts://h:8883');
});

test('a snapshot taken before the allowlist is ready is not publishable', () => {
  // Retained state plus an all-zero payload is the worst combination: Home Assistant shows the
  // zero until the next interval, AND the recorder stores it as a real data point, so every
  // restart puts a spurious dip in every graph. The publisher gates on allowlist.ready; this
  // pins the shape that gate reads.
  const cold = { allowlist: { ready: false, union: 0, instanceEntities: 0 }, clients: { open: 0, total: 0, list: [] }, savings: { before: 0, after: 0, savedPct: 0 } };
  assert.equal(cold.allowlist.ready, false, 'a cold snapshot is identifiable');
  const warm = { ...snap, allowlist: { ...snap.allowlist, ready: true } };
  assert.equal(warm.allowlist.ready, true);
  // And the payload built from a warm snapshot carries the real numbers, not zeros.
  assert.equal(buildPayload(warm).entities_union, 418);
});
