// mDNS device discovery.
//
// The network half is deliberately not tested here — a test that needs a real device announcing
// on the segment is a test that fails in CI for reasons unrelated to the code. What IS tested is
// the part that gets things wrong: folding a packet into state, and turning that state into the
// address -> device view the rest of the add-on asks for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingest, index, expire, parseTxt, labelFor, DEFAULT_SERVICES, preferredRow, KIND_PRIORITY, HOSTS_MAX, STALE_AFTER_MS } from '../mdns.mjs';

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

// Which announcement to believe when a device makes several.
//
// A panel commonly advertises itself more than once — ha-paneld AND Kiosk Satellite AND ESPHome —
// with a different version on each. Three of twenty-four discovered addresses on a live instance
// did this. Taking whichever record arrived first made the label depend on multicast timing, so
// the same panel could show as ESPHome one boot and Kiosk Satellite the next.

test('mDNS priority: prefers the software running the panel over the firmware underneath', () => {
  const rows = [
    { kind: 'ESPHome', name: 'Office Panel', version: '2026.8.0' },
    { kind: 'Kiosk Satellite', name: 'Office Panel', version: '2026.9.53' },
  ];
  assert.equal(preferredRow(rows).kind, 'Kiosk Satellite',
    'ESPHome is true of the device but the least useful answer to "what is this"');
});

test('mDNS priority: prefers ha-paneld above all of them', () => {
  const rows = [
    { kind: 'ESPHome', name: 'P' },
    { kind: 'Kiosk Satellite', name: 'P' },
    { kind: 'ha-paneld', name: 'P' },
  ];
  assert.equal(preferredRow(rows).kind, 'ha-paneld');
});

test('mDNS priority: does not depend on the order the answers arrived in', () => {
  // The whole point: the same set in any order gives the same label.
  const a = preferredRow([{ kind: 'Kiosk Satellite' }, { kind: 'ESPHome' }]);
  const b = preferredRow([{ kind: 'ESPHome' }, { kind: 'Kiosk Satellite' }]);
  assert.equal(a.kind, b.kind, 'multicast timing must not decide the label');
  assert.equal(a.kind, 'Kiosk Satellite');
});

test('mDNS priority: keeps an unrecognised kind rather than discarding it', () => {
  // An unknown label beats no label.
  assert.equal(preferredRow([{ kind: 'Something New' }]).kind, 'Something New');
  // ...but ranks below anything known.
  assert.equal(preferredRow([{ kind: 'Something New' }, { kind: 'ESPHome' }]).kind, 'ESPHome');
});

test('mDNS priority: is stable for two unknown kinds, so the label does not flip', () => {
  const rows = [{ kind: 'Alpha' }, { kind: 'Beta' }];
  assert.equal(preferredRow(rows).kind, 'Alpha');
  assert.equal(preferredRow(rows).kind, 'Alpha');
});

test('mDNS priority: answers nothing for nothing', () => {
  assert.equal(preferredRow([]), null);
  assert.equal(preferredRow(null), null);
  assert.equal(preferredRow(undefined), null);
});

test('mDNS priority: orders ha-paneld, Kiosk Satellite, ESPHome', () => {
  assert.deepEqual(KIND_PRIORITY.slice(0, 3), ['ha-paneld', 'Kiosk Satellite', 'ESPHome']);
});

// ---- the tables are bounded, and they forget ----
//
// They used to keep every A record on the segment for the life of the process. The cost that
// mattered was not memory: a panel that left kept its name pointing at its old address, and when
// DHCP reissued that address a `client` rule naming the panel widened a stranger.

test('a goodbye (TTL 0) removes the host instead of recording it as seen', () => {
  const s = fresh();
  ingest(ksPacket('aaa', 'Panel', '10.2.4.77', 'panel'), SERVICES, s);
  assert.equal(index(s).byHost.get('panel.local'), '10.2.4.77');
  assert.equal(ingest({ answers: [{ name: 'panel.local', type: 'A', data: '10.2.4.77', ttl: 0 }] }, SERVICES, s), true);
  assert.equal(index(s).byHost.get('panel.local'), undefined);
  assert.equal(index(s).byIp.size, 0, 'and the device row goes with its address');
});

test('whatever stops answering is forgotten', () => {
  const s = fresh();
  ingest(ksPacket('aaa', 'Old', '10.2.4.77', 'old'), SERVICES, s, 1000);
  ingest(ksPacket('bbb', 'Live', '10.2.4.78', 'live'), SERVICES, s, 1000);
  ingest(ksPacket('bbb', 'Live', '10.2.4.78', 'live'), SERVICES, s, 900000);   // re-heard
  assert.equal(expire(s, 600000, 1000000), true);
  const { byIp } = index(s);
  assert.deepEqual([...byIp.keys()], ['10.2.4.78']);
});

test('an SRV target and its A record join regardless of case or a trailing dot', () => {
  const s = fresh();
  ingest({ answers: [
    { name: '_esphomelib._tcp.local', type: 'PTR', data: 'node._esphomelib._tcp.local' },
    { name: 'node._esphomelib._tcp.local', type: 'SRV', data: { target: 'Node.local.', port: 6053 } },
    { name: 'node.local', type: 'A', data: '10.2.4.50' },
  ] }, SERVICES, s);
  assert.equal(index(s).byIp.get('10.2.4.50')?.[0]?.kind, 'ESPHome');
});

test('a packet that only confirms what is known does not ask for a reindex', () => {
  const s = fresh();
  const p = ksPacket('aaa', 'Panel', '10.2.4.77', 'panel');
  assert.equal(ingest(p, SERVICES, s), true);
  assert.equal(ingest(p, SERVICES, s), false, 'identical records must not rebuild the index');
  p.answers[3].data = '10.2.4.99';
  assert.equal(ingest(p, SERVICES, s), true, 'a moved address must');
});

test('the host table is capped, and only takes .local names', () => {
  const s = fresh();
  const answers = [];
  for (let i = 0; i < HOSTS_MAX + 500; i++) answers.push({ name: `h${i}.local`, type: 'A', data: '10.0.0.1' });
  answers.push({ name: 'example.com', type: 'A', data: '93.184.216.34' });
  ingest({ answers }, SERVICES, s);
  assert.equal(s.hosts.size, HOSTS_MAX);
  assert.equal(s.hosts.has('example.com'), false);
});

// The sawtooth. `sensor.strimmer_devices_discovered` cycled between 12 and ~120 roughly hourly:
// hosts are refreshed only by A records and instances only by PTR/SRV/TXT, so a device answering a
// service query without repeating its address kept a fresh instance, lost its host, and vanished
// from the view while demonstrably alive.
test('a device that keeps announcing its service does not expire for want of an A record', () => {
  const s = fresh();
  ingest(ksPacket('aaa', 'Panel', '10.2.4.77', 'panel'), SERVICES, s, 1000);
  assert.equal(index(s).byIp.size, 1);

  // Two hours later it has re-announced PTR/SRV/TXT — as a service query elicits — but no A.
  const later = 1000 + STALE_AFTER_MS + 60000;
  ingest({ answers: [
    { name: '_kiosk-satellite._tcp.local', type: 'PTR', data: 'ks-aaa._kiosk-satellite._tcp.local' },
    { name: 'ks-aaa._kiosk-satellite._tcp.local', type: 'SRV', data: { target: 'panel.local', port: 2324 } },
  ] }, SERVICES, s, later);

  expire(s, STALE_AFTER_MS, later);
  assert.equal(index(s).byIp.size, 1, 'hearing the service IS hearing the device — it must not vanish');
  assert.equal(index(s).byIp.get('10.2.4.77')[0].name, 'Panel');
});

test('a host nothing points at any more does still expire', () => {
  const s = fresh();
  // A bare `<name>.local`, the kind a client rule resolves through — no instance references it.
  ingest({ answers: [{ name: 'orphan.local', type: 'A', data: '10.2.4.9' }] }, SERVICES, s, 1000);
  assert.equal(index(s).byHost.get('orphan.local'), '10.2.4.9');
  const later = 1000 + STALE_AFTER_MS + 60000;
  assert.equal(expire(s, STALE_AFTER_MS, later), true);
  assert.equal(index(s).byHost.get('orphan.local'), undefined, 'the backstop must still work');
});

test('the expiry window is longer than a real announce cycle', () => {
  // The observed sawtooth had a ~55-60 minute period; the window was 15 minutes. Anything at or
  // under an hour reintroduces it, so this is a floor rather than a preference.
  assert.ok(STALE_AFTER_MS >= 2 * 3600 * 1000, `${STALE_AFTER_MS}ms is not past the observed cycle`);
});
