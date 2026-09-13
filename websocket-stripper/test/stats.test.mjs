// The stats panel and its JSON API.
//
// The behaviour worth pinning here is not "a number appears". It is that the numbers mean
// what the panel claims they mean:
//   - trimmed payloads report a real before/after taken from the same answer;
//   - the event stream is reported as throughput and NEVER as a saving, because the
//     untrimmed volume does not exist to be measured (HA filters server-side);
//   - the API is read-only and unknown paths 404 rather than reaching the proxy.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';
import * as stats from '../stats.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

const httpGet = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    let body = ''; res.on('data', (c) => body += c);
    res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
  });
  req.on('error', reject);
});

describe('stats counters', () => {
  it('reports a real before/after per category', () => {
    stats.reset();
    stats.recordTrim('states', 1000, 100);
    stats.recordTrim('states', 1000, 300);
    const s = stats.snapshot();
    assert.equal(s.savings.byCategory.states.count, 2);
    assert.equal(s.savings.byCategory.states.before, 2000);
    assert.equal(s.savings.byCategory.states.after, 400);
    assert.equal(s.savings.byCategory.states.saved, 1600);
    assert.equal(s.savings.byCategory.states.savedPct, 80);
  });

  it('keeps the event stream out of the savings total', () => {
    stats.reset();
    stats.recordTrim('states', 1000, 100);
    stats.recordEvent(5000);
    const s = stats.snapshot();
    // 5000 bytes of events must not inflate either side of the saving.
    assert.equal(s.savings.before, 1000);
    assert.equal(s.savings.after, 100);
    assert.equal(s.eventStream.bytes, 5000);
    assert.equal(s.eventStream.count, 1);
    assert.ok(!('saved' in s.eventStream), 'the event stream must never report a saving');
  });

  it('tracks open connections and forgets closed ones', () => {
    stats.reset();
    const a = stats.connOpen({ ip: '10.0.0.1', dash: 'kitchen', via: 'cookie', allowSize: 12 });
    stats.connOpen({ ip: '10.0.0.2', dash: null, via: null, allowSize: 99 });
    stats.connTraffic(a, 500, 100, false);
    let s = stats.snapshot();
    assert.equal(s.clients.open, 2);
    assert.equal(s.clients.total, 2);
    const first = s.clients.list.find((c) => c.id === a);
    assert.equal(first.dashboard, 'kitchen');
    assert.equal(first.attributedVia, 'cookie');
    assert.equal(first.fromHA, 500);
    assert.equal(first.toBrowser, 100);

    stats.connClose(a);
    s = stats.snapshot();
    assert.equal(s.clients.open, 1);
    assert.equal(s.clients.total, 2, 'lifetime count must not go down when a client leaves');
  });

  it('reports no rate for a connection too young to have one', () => {
    stats.reset();
    const id = stats.connOpen({ ip: '10.0.0.3', dash: 'kitchen', via: 'ip', allowSize: 5 });
    stats.connTraffic(id, 200000, 200000, true);
    const c = stats.snapshot().clients.list[0];
    // Extrapolating 200KB from a connection milliseconds old would claim megabytes/min.
    assert.equal(c.eventBytesPerMin, null, 'a sub-minute connection must not report a rate');
    assert.equal(c.eventBytes, 200000, 'the raw total is still reported');
  });

  it('counts only genuine events as event traffic', () => {
    stats.reset();
    const id = stats.connOpen({ ip: '10.0.0.4', dash: null, via: null, allowSize: 1 });
    stats.connTraffic(id, 500, 500, false);   // an untrimmed reply, e.g. lovelace/config
    stats.connTraffic(id, 100, 100, true);    // an actual state event
    const c = stats.snapshot().clients.list[0];
    assert.equal(c.eventBytes, 100, 'untrimmed replies must not be counted as update traffic');
    assert.equal(c.toBrowser, 600, 'but they do count toward total traffic');
  });

  it('survives a division by zero when nothing has been trimmed', () => {
    stats.reset();
    const s = stats.snapshot();
    assert.equal(s.savings.savedPct, 0);
    assert.equal(s.savings.before, 0);
    assert.deepEqual(s.savings.byCategory, {});
  });
});

describe('stats API over HTTP', () => {
  let mock, proxy, port, statsPort, out = '';

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    statsPort = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: {
        ...process.env,
        HA_BASE: mock.base,
        HA_TOKEN: 'test-token',
        DASH_PATHS: 'test-dash',
        PORT: String(port),
        STATS_PORT: String(statsPort),
        STRIP_ENTITIES: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => { out += b.toString(); });
    proxy.stderr.on('data', (b) => { out += b.toString(); });
    const deadline = Date.now() + 8000;
    while (!/stats panel on/.test(out) || !/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(`proxy never started its stats server / built an allowlist\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  after(() => { proxy?.kill(); mock?.close(); });

  it('serves the panel HTML', async () => {
    const res = await httpGet(`http://127.0.0.1:${statsPort}/`);
    assert.equal(res.status, 200);
    assert.match(res.type, /text\/html/);
    assert.match(res.body, /WebSocket Stripper/);
    assert.match(res.body, /stats\.json/);
  });

  it('serves stats.json with the live configuration', async () => {
    const res = await httpGet(`http://127.0.0.1:${statsPort}/stats.json`);
    assert.equal(res.status, 200);
    assert.match(res.type, /application\/json/);
    const s = JSON.parse(res.body);
    assert.ok(s.version, 'version is reported');
    assert.equal(s.options.strip_entities, true);
    assert.ok(s.allowlist.union > 0, 'the allowlist size is reported');
    assert.ok(Object.keys(s.allowlist.byDashboard).includes('test-dash'));
  });

  it('counts a get_states trim with the instance size behind it', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'get_states' });
    await new Promise((r) => setTimeout(r, 400));
    c.close();

    const s = JSON.parse((await httpGet(`http://127.0.0.1:${statsPort}/stats.json`)).body);
    const states = s.savings.byCategory.states;
    assert.ok(states, 'a states trim was recorded');
    assert.ok(states.before > states.after, `expected a real reduction, got ${states.before} -> ${states.after}`);
    assert.ok(states.saved > 0);
    // The untrimmed get_states IS the whole instance, so it doubles as the instance size.
    assert.ok(s.allowlist.instanceEntities > 0, 'instance size learned from the untrimmed answer');
    assert.ok(s.allowlist.instanceEntities >= s.allowlist.union);
  });

  it('passes binary frames through byte-for-byte', async () => {
    // Regression: every frame was run through raw.toString() and forwarded as a string. For
    // the JSON control protocol that is fine; for binary frames it UTF-8-decodes arbitrary
    // bytes (lossy) and re-sends them as a TEXT frame. HA uses binary frames for media, and
    // on a real instance they were 90% of everything a wall panel received.
    const { WebSocket: WS } = await import('ws');
    const ws = new WS(`ws://127.0.0.1:${port}/api/websocket`);
    const frames = [];
    ws.on('message', (data, isBinary) => { if (isBinary) frames.push(Buffer.from(data)); });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.send(JSON.stringify({ type: 'auth', access_token: 'test-token' }));
    await new Promise((r) => setTimeout(r, 200));

    // Bytes that are NOT valid UTF-8: if anything decodes them, they come back changed.
    const payload = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0x01, 0x02, 0xc0]);
    mock.sendBinaryToLastClient?.(payload);
    await new Promise((r) => setTimeout(r, 300));
    ws.close();

    if (!mock.sendBinaryToLastClient) return;   // mock without binary support: nothing to assert
    assert.equal(frames.length, 1, 'the binary frame arrived as a binary frame');
    assert.deepEqual(frames[0], payload, 'bytes survived the proxy unchanged');
  });

  it('404s unknown paths instead of proxying them', async () => {
    const res = await httpGet(`http://127.0.0.1:${statsPort}/lovelace`);
    assert.equal(res.status, 404);
  });

  // The point of this measurement is to answer "is it actually faster" with something other
  // than an opinion — and to do it for clients like the iOS companion app, which opens a
  // native socket and cannot be instrumented from outside at all.
  it('times the first entity payload from connect to on-the-wire', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities', id: 90 });
    await new Promise((r) => setTimeout(r, 200));

    // `a` is HA's "added" block: the full state of every subscribed entity, sent once when the
    // subscription opens. This is the payload a dashboard cannot render without.
    mock.pushEntityEvent({ a: { 'light.living_room': { s: 'on' }, 'sensor.temperature': { s: '21' } } });
    await new Promise((r) => setTimeout(r, 400));

    const s = JSON.parse((await httpGet(`http://127.0.0.1:${statsPort}/stats.json`)).body);
    const me = s.clients.list.find((x) => x.msToEntityData != null);
    assert.ok(me, `no connection reported a timing; clients: ${JSON.stringify(s.clients.list)}`);
    assert.ok(me.msToEntityData >= 0, 'time from connect to payload delivered');
    assert.ok(me.initialPayloadBytes > 0, 'the payload size is reported');
    assert.ok(me.initialDrainMs >= 0, 'and how long it took to leave the machine');
    // Loopback, so the write drains immediately. The number only becomes interesting over a
    // real link — which is the entire reason it is measured separately from the total.
    assert.ok(me.initialDrainMs <= me.msToEntityData,
      'drain is part of the total, so it cannot exceed it');
    c.close();
  });

  it('reports the cold-start payload only, not every later diff', async () => {
    // A re-subscribe or a later `a` block is a different event. Averaging them into the same
    // field would quietly destroy the cold-start number this exists to report — which is the
    // one a user actually experiences as "the dashboard came up".
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities', id: 91 });
    await new Promise((r) => setTimeout(r, 200));
    mock.pushEntityEvent({ a: { 'light.living_room': { s: 'on' } } });
    await new Promise((r) => setTimeout(r, 300));

    const first = JSON.parse((await httpGet(`http://127.0.0.1:${statsPort}/stats.json`)).body)
      .clients.list.find((x) => x.msToEntityData != null);
    assert.ok(first, 'a first payload was timed');

    // A much larger second payload on the same connection must not overwrite it.
    const big = {};
    for (let i = 0; i < 200; i++) big[`light.filler_${i}`] = { s: 'on', a: { friendly_name: 'x'.repeat(80) } };
    mock.pushEntityEvent({ a: big });
    await new Promise((r) => setTimeout(r, 400));

    const after = JSON.parse((await httpGet(`http://127.0.0.1:${statsPort}/stats.json`)).body)
      .clients.list.find((x) => x.id === first.id);
    assert.equal(after.initialPayloadBytes, first.initialPayloadBytes,
      'the cold-start payload size must be immutable once recorded');
    c.close();
  });
});
