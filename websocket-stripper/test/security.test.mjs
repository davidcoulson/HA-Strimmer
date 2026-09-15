// What the network may read.
//
// The management server binds every interface, so everything it serves is reachable by anything
// on the LAN — including the IoT VLAN the panels sit on. Writes were gated from the start. Reads
// were not, and "statistics are harmless" turned out to be wrong in a way that is worth pinning
// down forever: Home Assistant puts credentials in request PATHS, and the request log kept them.
//
// Measured on a live instance before this was fixed: 2 webhook ids, 37 HLS stream tokens and 4
// signed camera-proxy paths, all readable without authentication. A webhook id is a bearer
// credential — anyone holding one can POST to it and fire whatever automation it drives.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

const req = (port, p, { headers = {}, method = 'GET' } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  r.on('error', reject); r.end();
});
// Supervisor's own address plus the header it sets. Loopback counts as Ingress for local testing,
// so a plain request from the test IS the "through Ingress" case once the header is present.
const ING = { 'x-ingress-path': '/api/hassio_ingress/abc' };

describe('what the network may read', () => {
  let mock, proxy, port, sp, out = '';

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    sp = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(sp), STRIP_ENTITIES: '1',
        USER_OVERRIDES: JSON.stringify([{ user: 'David Coulson', always_forward: ['/^update\\./'] }]) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => out += b); proxy.stderr.on('data', (b) => out += b);
    const deadline = Date.now() + 25000;
    while (!/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(`no boot\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  after(async () => { proxy?.kill(); await mock?.close(); });

  it('refuses every identity-bearing read that did not come through Ingress', async () => {
    for (const p of ['/access.json', '/entities.json', '/devices.json', '/config.json', '/history.json']) {
      const res = await req(sp, p);
      assert.equal(res.status, 403, `${p} must not be readable from the network`);
      assert.match(res.body, /Ingress/, `${p} must say why`);
    }
  });

  it('still serves all of them through Ingress', async () => {
    for (const p of ['/access.json', '/entities.json', '/devices.json', '/config.json', '/history.json']) {
      const res = await req(sp, p, { headers: ING });
      assert.equal(res.status, 200, `${p} must still work for the console`);
    }
  });

  // /access.json is the one that carried credentials, so it gets its own test naming them.
  it('never hands the request log — webhook ids and stream tokens — to the network', async () => {
    const res = await req(sp, '/access.json?limit=200');
    assert.equal(res.status, 403);
    assert.ok(!/\/api\/webhook\//.test(res.body), 'a webhook id must never appear in a refusal');
    assert.ok(!/\/api\/hls\//.test(res.body), 'nor a stream token');
  });

  // stats.json stays public on purpose: a `rest:` sensor polls it from HA core, not via Ingress.
  // Gating it wholesale would take that health sensor down — which this add-on already did once
  // by moving its port. So the aggregates stay and the identities go.
  it('keeps stats.json readable but strips who is connected', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    await new Promise((r) => setTimeout(r, 250));
    try {
      const lan = await req(sp, '/stats.json');
      assert.equal(lan.status, 200, 'a health check must still be able to poll this');
      const d = JSON.parse(lan.body);

      // What a health check needs.
      assert.equal(typeof d.allowlist.ready, 'boolean');
      assert.ok(d.allowlist.union > 0);
      assert.ok(d.savings, 'aggregates are kept');
      assert.equal(d.redacted, true, 'and it says it is not the whole picture');

      // What it does not.
      assert.deepEqual(d.clients.list, [], 'no per-client rows');
      assert.deepEqual(d.clients.recent, [], 'nor the 24h history of them');
      assert.ok(typeof d.clients.open === 'number', 'a count is fine, and useful');
      assert.deepEqual(d.mdns.devices, [], 'no discovered device names or addresses');
      assert.ok(!('routeNames' in d), 'no resolved internal hostnames');
      assert.ok(!('paths' in d),
        'the routing breakdown names the hostname each client arrived on, and is keyed by it');

      // Belt and braces, and how the `paths` miss was actually found: scan the WHOLE payload for
      // anything shaped like an address or a hostname, rather than trusting a list of field names
      // to stay complete as the snapshot grows.
      const raw = lan.body;
      assert.ok(!/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(raw),
        'no private address anywhere in the public payload');
      // Resource URLs are configuration and are deliberately kept, and some are public CDNs
      // (fonts.googleapis.com), so they are excluded rather than allowed to raise a false alarm
      // that trains people to ignore this check. Everything else that looks like a host is a leak.
      const withoutResourceUrls = raw.replace(/"https?:\/\/[^"]*"/g, '""');
      assert.ok(!/\b[a-z0-9-]+\.(?:local|lan|internal)\b/i.test(withoutResourceUrls),
        'no internal hostname anywhere in the public payload');
      // Dashboard names and installed-card paths are deliberately KEPT: they are configuration,
      // not identity — no person, machine or credential is named by them, and anyone who can load
      // a dashboard already sees both. Redacting them cost the health sensor detail and bought
      // nothing, so the line is drawn at identity rather than at "anything descriptive".
      assert.ok(d.allowlist.byDashboard, 'configuration aggregates are kept');

      // And through Ingress the console still sees everything.
      const ing = JSON.parse((await req(sp, '/stats.json', { headers: ING })).body);
      assert.ok(ing.clients.list.length >= 1, 'the console still gets the detail');
      assert.ok(!ing.redacted);
    } finally { c.close(); }
  });
});

describe('the client status endpoint', () => {
  let mock, proxy, port, sp, out = '';

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    sp = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(sp), STRIP_ENTITIES: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => out += b); proxy.stderr.on('data', (b) => out += b);
    const deadline = Date.now() + 25000;
    while (!/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(`no boot\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  after(async () => { proxy?.kill(); await mock?.close(); });

  it('refuses a request with no token', async () => {
    const res = await req(port, '/stripper/client.json');
    assert.equal(res.status, 401);
    assert.match(res.headers['www-authenticate'] || '', /Bearer/);
    // It must not leak the answer in the refusal.
    assert.ok(!/trimming/.test(res.body), 'a refusal must not carry the payload');
  });

  it('refuses a token Home Assistant does not accept', async () => {
    const res = await req(port, '/stripper/client.json', { headers: { authorization: 'Bearer invalid-token' } });
    assert.equal(res.status, 401);
    assert.ok(!/trimming/.test(res.body));
  });

  it('answers a caller holding a valid token', async () => {
    const res = await req(port, '/stripper/client.json', { headers: { authorization: 'Bearer david-token' } });
    assert.equal(res.status, 200, `expected an answer, got ${res.status}: ${res.body}`);
    const d = JSON.parse(res.body);
    assert.equal(d.stripper.running, true);
    assert.equal(typeof d.trimming.entities, 'boolean');
  });

  // An Authorization header makes this a non-simple cross-origin request, so a panel admin page
  // on its own origin preflights and never sends the real request if nobody answers.
  it('answers the CORS preflight the Authorization header forces', async () => {
    const res = await req(port, '/stripper/client.json', { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.match(res.headers['access-control-allow-headers'] || '', /authorization/i,
      'without this a browser will not send the token at all');
    assert.match(res.headers['access-control-allow-methods'] || '', /GET/);
  });
});
