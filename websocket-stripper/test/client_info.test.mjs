// What a panel may learn about itself from the proxy port.
//
// This endpoint is on the PROXY port, which every panel on the network can reach and which has no
// authentication in front of it. So the interesting tests are not "does it return numbers" — they
// are about the boundary: it must describe the caller and nothing else, and it must never carry
// configuration that names people, rules, or other machines. A field added carelessly here is
// published to every device on the network, silently.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

// The endpoint authenticates with the caller's own Home Assistant token now — a panel already
// has one, and this port is reachable by anything on the network.
const get = (port, p, token = 'david-token') => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p,
    headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  }).on('error', reject);
});

describe('the client info endpoint', () => {
  let mock, proxy, port, statsPort, out = '';

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    statsPort = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: {
        ...process.env,
        HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(statsPort),
        STRIP_ENTITIES: '1', TRIM_THEMES: '1',
        // Configuration that must NOT be echoed back to the network.
        USER_OVERRIDES: JSON.stringify([
          { user: 'David Coulson', always_forward: ['/^update\\./'] },
        ]),
        CLIENT_OVERRIDES: JSON.stringify([
          { client: '10.99.0.1', devices: ['Secret Panel'] },
        ]),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => out += b);
    proxy.stderr.on('data', (b) => out += b);
    const deadline = Date.now() + 10000;
    while (!/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(`no boot\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  after(async () => { proxy?.kill(); await mock?.close(); });

  it('answers on the proxy port, which is what makes reaching it meaningful', async () => {
    const res = await get(port, '/stripper/client.json');
    assert.equal(res.status, 200, 'a panel behind the proxy must get an answer');
    assert.match(res.headers['content-type'], /application\/json/);
    const d = JSON.parse(res.body);
    assert.equal(d.stripper.running, true);
    assert.ok(d.stripper.version, 'the panel can show which build is in front of it');
    // The path is served by the proxy itself, never forwarded — that is the whole signal. If it
    // were proxied through, Home Assistant would answer and the 200 would mean nothing.
    assert.ok(!/404/.test(String(res.status)));
  });

  it('reports what is being trimmed, as booleans and nothing more', async () => {
    const d = JSON.parse((await get(port, '/stripper/client.json')).body);
    assert.equal(d.trimming.entities, true);
    assert.equal(d.trimming.themes, true, 'reflects the running configuration, not a default');
    assert.equal(d.trimming.repairs, false);
    for (const [k, v] of Object.entries(d.trimming)) {
      assert.equal(typeof v, 'boolean', `trimming.${k} must be a boolean, got ${typeof v}`);
    }
  });

  // The important one. Everything below is what this port must never publish.
  it('never publishes rules, identities or other machines', async () => {
    const raw = (await get(port, '/stripper/client.json')).body;

    for (const secret of ['David Coulson', 'Secret Panel', '10.99.0.1', '/^update\\./']) {
      assert.ok(!raw.includes(secret),
        `the reply leaks ${JSON.stringify(secret)} — this port is readable by the whole network`);
    }
    const d = JSON.parse(raw);
    for (const forbidden of ['overrides', 'user_overrides', 'client_overrides', 'always_forward',
      'never_forward', 'dashboards', 'allowlist', 'clients', 'user']) {
      assert.ok(!(forbidden in d), `top-level "${forbidden}" must not be published`);
      assert.ok(!(forbidden in d.trimming), `"${forbidden}" must not appear under trimming`);
    }
    assert.ok(!('user' in d.client), 'a panel must not be told which Home Assistant user it is');
  });

  it('describes the caller and offers no way to ask about anyone else', async () => {
    // A query string must not select a different subject. If it ever did, every panel could
    // enumerate every other panel on the network from an unauthenticated port.
    const other = await get(port, '/stripper/client.json?ip=10.99.0.1');
    assert.equal(other.status, 200);
    const d = JSON.parse(other.body);
    assert.notEqual(d.client.ip, '10.99.0.1', 'the subject must be the caller, not a parameter');
    assert.match(String(d.client.ip), /127\.0\.0\.1|::1/, 'the subject is whoever asked');
  });

  it('reports zero connections honestly rather than pretending', async () => {
    const d = JSON.parse((await get(port, '/stripper/client.json')).body);
    assert.equal(d.client.connections, 0, 'no websocket is open from this test yet');
    assert.equal(d.client.traffic, null, 'no traffic figures invented for a client with none');
    assert.equal(d.client.dashboard, null);
  });

  it('fills in the caller\'s own numbers once it is actually connected', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    await new Promise((r) => setTimeout(r, 300));
    try {
      const d = JSON.parse((await get(port, '/stripper/client.json')).body);
      assert.ok(d.client.connections >= 1, 'the open websocket is counted');
      assert.ok(Number.isInteger(d.client.entities_served),
        'the panel can show how many entities it is being served');
      assert.ok(d.client.traffic, 'traffic figures appear once there is traffic');
      assert.equal(typeof d.client.traffic.from_ha_bytes, 'number');
      // not_sent is a difference between two measured totals and can never be negative.
      assert.ok(d.client.traffic.not_sent_bytes >= 0);
    } finally { c.close(); }
  });
});
