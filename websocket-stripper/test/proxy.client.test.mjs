// Rules pinned to a physical client rather than to a dashboard.
//
// The case this exists for: a browser-based voice satellite. `assist_satellite.office_panel` and
// its twenty siblings belong to the ONE panel that is that satellite. Scoping them to a dashboard
// is wrong in both directions — the panel loses them the moment it navigates somewhere else, and
// every other client opening that dashboard pays for entities it can never use.
//
// So the assertions below are about the pin holding independently of the page: the rule must
// apply when the dashboard is attributed, when it is not attributed at all, and it must NOT leak
// to a different client that opens the very same dashboard.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

describe('client-pinned rules', () => {
  let mock, proxy, port, out = '';

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: {
        ...process.env,
        HA_BASE: mock.base,
        HA_TOKEN: 'test-token',
        DASH_PATHS: 'test-dash',
        PORT: String(port),
        STATS_PORT: String(await getFreePort()),
        STRIP_ENTITIES: '1',
        PER_DASHBOARD: '1',
        // 127.0.0.1 is what a loopback test client presents as, so it stands in for the wall
        // panel's address. The device is named the way a person would write it in the UI.
        CLIENT_OVERRIDES: JSON.stringify([
          { client: '127.0.0.1', devices: ['Office Panel'], always_forward: ['/^input_boolean\\.pinned_/'] },
          { client: '10.9.9.0/24', devices: [], always_forward: ['sensor.other_vlan_only'] },
        ]),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => { out += b.toString(); });
    proxy.stderr.on('data', (b) => { out += b.toString(); });
    const deadline = Date.now() + 10000;
    while (!/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(`proxy never built an allowlist\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  after(() => { proxy?.kill(); mock?.close(); });

  it('expands a named device to every entity that device owns', async () => {
    // The whole device, not a hand-listed subset: a voice satellite integration adds entities
    // between releases, and a rule needing a re-edit to keep working silently stops working.
    assert.match(out, /client rule 127\.0\.0\.1: device "Office Panel" -> \d+ entities/);
  });

  it('forwards the pinned device entities to that client', async () => {
    const seq = mock.subscribeEntitiesSeq();
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities', id: 1 });
    // The mock records the entity_ids array itself, not the wrapping message.
    const ids = new Set((await mock.waitForSubscribeEntities(seq)) ?? []);
    assert.ok(ids.has('assist_satellite.office_panel'),
      `the satellite entity must reach its own panel; got ${[...ids].slice(0, 20).join(', ')}`);
    assert.ok(ids.has('switch.office_panel_mute'),
      'sibling entities of the same device come too, not just the headline one');
    c.close();
  });

  it('applies always_forward patterns alongside devices', async () => {
    const seq = mock.subscribeEntitiesSeq();
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities', id: 2 });
    const ids = (await mock.waitForSubscribeEntities(seq)) ?? [];
    assert.ok(ids.includes('input_boolean.pinned_thing'),
      'a pattern in the same block is applied too');
    c.close();
  });

  it('does not apply a rule whose CIDR does not contain this client', async () => {
    const seq = mock.subscribeEntitiesSeq();
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities', id: 3 });
    const ids = (await mock.waitForSubscribeEntities(seq)) ?? [];
    assert.ok(!ids.includes('sensor.other_vlan_only'),
      'a 10.9.9.0/24 rule must not fire for a 127.0.0.1 client');
    c.close();
  });

  it('logs the widening so the pin is visible rather than mysterious', async () => {
    assert.match(out, /\+client rules \(\d+ -> \d+\)/);
  });
});

// A client that names itself gets its own device's entities, with no configuration at all.
//
// A browser-based voice satellite announces which satellite it is on the very websocket this
// add-on proxies. That beats every alternative identity signal: mDNS cannot work (a web page has
// no API to advertise it), an IP needs a DHCP reservation to be stable, and both still require
// someone to write the mapping down. The panel simply says who it is.
describe('clients that identify themselves', () => {
  let mock, proxy, port, out = '';

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: {
        ...process.env,
        HA_BASE: mock.base, HA_TOKEN: 'test-token', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(await getFreePort()),
        STRIP_ENTITIES: '1', PER_DASHBOARD: '1',
        CLIENT_OVERRIDES: '[]',          // nothing configured: this must work on its own
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => { out += b.toString(); });
    proxy.stderr.on('data', (b) => { out += b.toString(); });
    const deadline = Date.now() + 10000;
    while (!/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(`proxy never built an allowlist\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  after(() => { proxy?.kill(); mock?.close(); });

  it('learns a satellite from the client announcing it, and serves it on reconnect', async () => {
    // First connection: the panel announces itself. Its allowlist was already sent, so this
    // connection does not benefit — the add-on learns and drops it so the frontend reconnects.
    const c1 = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c1.authed;
    c1.send({ type: 'subscribe_entities', id: 30 });
    await new Promise((r) => setTimeout(r, 150));
    c1.send({ type: 'voice_satellite/subscribe_events', id: 31, entity_id: 'assist_satellite.office_panel' });
    await new Promise((r) => setTimeout(r, 700));

    assert.match(out, /identified itself as assist_satellite\.office_panel/);

    // Second connection from the same client: now it arrives already knowing.
    const seq = mock.subscribeEntitiesSeq();
    const c2 = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c2.authed;
    c2.send({ type: 'subscribe_entities', id: 32 });
    const ids = new Set((await mock.waitForSubscribeEntities(seq)) ?? []);
    assert.ok(ids.has('assist_satellite.office_panel'),
      `the satellite it named must be forwarded; got ${[...ids].slice(0, 15).join(', ')}`);
    assert.ok(ids.has('switch.office_panel_mute'),
      'and its siblings on the same device, since the card resolves those itself');
    c2.close();
    try { c1.close(); } catch {}
  });

  it('ignores an entity_id that is not a satellite', async () => {
    // The trigger is narrow on purpose: only assist_satellite.* on a voice_satellite/* command.
    // Anything broader would let a client widen its own allowlist by naming an entity.
    const before = out.length;
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'voice_satellite/subscribe_events', id: 40, entity_id: 'light.living_room' });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!/identified itself as light\./.test(out.slice(before)),
      'a non-satellite entity_id must not be treated as an identity claim');
    c.close();
  });
});
