// mDNS device discovery.
//
// The network half is deliberately not tested here — a test that needs a real device announcing
// on the segment is a test that fails in CI for reasons unrelated to the code. What IS tested is
// the part that gets things wrong: folding a packet into state, and turning that state into the
// address -> device view the rest of the add-on asks for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingest, index, parseTxt, labelFor, DEFAULT_SERVICES } from '../mdns.mjs';

const SERVICES = DEFAULT_SERVICES;
const fresh = () => ({ instances: new Map(), hosts: new Map() });

// A real Kiosk Satellite announcement, in the four records a device actually sends.
const ksPacket = (id, name, ip, host) => ({
  answers: [
    { name: '_kiosk-satellite._tcp.local', type: 'PTR', data: `ks-${id}._kiosk-satellite._tcp.local` },
    { name: `ks-${id}._kiosk-satellite._tcp.local`, type: 'SRV', data: { target: `${host}.local`, port: 2324 } },
    { name: `ks-${id}._kiosk-satellite._tcp.local`, type: 'TXT', data: [
      Buffer.from(`id=${id}`), Buffer.from(`name=${name}`), Buffer.from('version=2026.9.46'),
    ] },
    { name: `${host}.local`, type: 'A', data: ip },
  ],
});

test('folds a complete announcement into an addressable device', () => {
  const s = fresh();
  assert.equal(ingest(ksPacket('f942b3707fdd098f', 'Office Test Panel', '10.2.4.129', 'ks-office-test-panel'), SERVICES, s), true);
  const { byIp } = index(s);
  const rows = byIp.get('10.2.4.129');
  assert.ok(rows, 'the device is indexed by its address');
  assert.equal(rows[0].kind, 'Kiosk Satellite');
  assert.equal(rows[0].name, 'Office Test Panel');
  assert.equal(rows[0].version, '2026.9.46');
  assert.equal(rows[0].port, 2324);
});

test('resolves a .local hostname, which the container OS resolver cannot', () => {
  const s = fresh();
  ingest(ksPacket('6403aea7069a5940', 'Basement Stairs Test', '10.2.4.109', 'ks-basement'), SERVICES, s);
  const { byHost } = index(s);
  assert.equal(byHost.get('ks-basement.local'), '10.2.4.109');
});

test('an instance with no address yet is simply absent, not half-present', () => {
  // Records arrive in any order and sometimes not at all. A PTR on its own must not produce a
  // device row with an undefined address that later code would have to guard against.
  const s = fresh();
  ingest({ answers: [{ name: '_esphomelib._tcp.local', type: 'PTR', data: 'thing._esphomelib._tcp.local' }] }, SERVICES, s);
  assert.equal(index(s).byIp.size, 0);
});

test('records arriving across separate packets still assemble', () => {
  const s = fresh();
  ingest({ answers: [{ name: '_esphomelib._tcp.local', type: 'PTR', data: 'node._esphomelib._tcp.local' }] }, SERVICES, s);
  ingest({ answers: [{ name: 'node._esphomelib._tcp.local', type: 'SRV', data: { target: 'node.local', port: 6053 } }] }, SERVICES, s);
  ingest({ answers: [{ name: 'node.local', type: 'A', data: '10.2.4.50' }] }, SERVICES, s);
  const rows = index(s).byIp.get('10.2.4.50');
  assert.ok(rows && rows[0].kind === 'ESPHome');
});

test('one address running two services keeps both', () => {
  const s = fresh();
  ingest(ksPacket('aaa', 'Panel', '10.2.4.77', 'panel'), SERVICES, s);
  ingest({ answers: [
    { name: '_googlecast._tcp.local', type: 'PTR', data: 'cast._googlecast._tcp.local' },
    { name: 'cast._googlecast._tcp.local', type: 'SRV', data: { target: 'panel.local', port: 8009 } },
  ] }, SERVICES, s);
  const rows = index(s).byIp.get('10.2.4.77');
  assert.equal(rows.length, 2, 'both services on the same address are kept');
});

test('a service type we did not ask for is ignored', () => {
  const s = fresh();
  ingest({ answers: [
    { name: '_printer._tcp.local', type: 'PTR', data: 'hp._printer._tcp.local' },
    { name: 'hp._printer._tcp.local', type: 'SRV', data: { target: 'hp.local', port: 631 } },
    { name: 'hp.local', type: 'A', data: '10.2.4.9' },
  ] }, SERVICES, s);
  // The A record still resolves a name — that is harmless and useful — but no DEVICE is claimed.
  assert.equal(index(s).byIp.size, 0, 'an unrequested service must not become a device row');
  assert.equal(index(s).byHost.get('hp.local'), '10.2.4.9');
});

test('TXT decoding survives whatever a device puts in it', () => {
  assert.deepEqual(parseTxt([Buffer.from('a=1'), Buffer.from('b=two')]), { a: '1', b: 'two' });
  assert.deepEqual(parseTxt([Buffer.from('novalue')]), {}, 'an entry with no = is skipped');
  assert.deepEqual(parseTxt([Buffer.from('=novalue')]), {}, 'an entry with no key is skipped');
  assert.deepEqual(parseTxt(undefined), {}, 'a missing TXT is not a crash');
  assert.equal(parseTxt([Buffer.from(`v=${'x'.repeat(500)}`)]).v.length, 120, 'values are bounded');
});

test('an unknown service still gets a readable label', () => {
  assert.equal(labelFor('_kiosk-satellite._tcp.local'), 'Kiosk Satellite');
  assert.equal(labelFor('_weird._tcp.local'), 'weird');
});
