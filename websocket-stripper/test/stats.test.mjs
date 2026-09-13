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

  it('sizes the entity block, not the frame HA batched it into', async () => {
    // Regression: this measured `Buffer.byteLength(s)` — the whole frame. HA batches messages
    // into an array, so the number silently absorbed whatever was bundled alongside. On a live
    // instance two clients on the SAME dashboard with the SAME 149-entity allowlist reported
    // 246KB and 1.5KB, a 164x spread, because one had the registries batched in and the other
    // did not. A "Payload" column that varies 164x for identical payloads is worse than absent.
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities', id: 92 });
    await new Promise((r) => setTimeout(r, 200));

    // A small `a` block, batched with ~200KB of unrelated filler — an oversized result of the
    // kind HA really does pack alongside it.
    const a = { 'light.living_room': { s: 'on' }, 'sensor.temperature': { s: '21' } };
    const aBytes = Buffer.byteLength(JSON.stringify(a));
    const filler = { id: 999, type: 'result', success: true, result: { pad: 'x'.repeat(200000) } };
    mock.pushEntityEventBatched({ a }, filler);
    await new Promise((r) => setTimeout(r, 500));

    const s = JSON.parse((await httpGet(`http://127.0.0.1:${statsPort}/stats.json`)).body);
    const me = s.clients.list.find((x) => x.initialPayloadBytes != null && x.initialEntityCount === 2);
    assert.ok(me, `no connection reported the batched initial state; got ${JSON.stringify(s.clients.list.map((x) => [x.id, x.initialPayloadBytes, x.initialEntityCount]))}`);
    assert.equal(me.initialPayloadBytes, aBytes,
      'the reported payload must be exactly the `a` block, excluding the batched filler');
    assert.ok(me.initialPayloadBytes < 1000,
      `200KB of batched filler must not be counted as entity payload (got ${me.initialPayloadBytes})`);
    assert.equal(me.initialEntityCount, 2,
      'the entity count is reported so the byte figure can be sanity-checked');
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

describe('batched frame accounting', () => {
  let mock, proxy, port, statsPort, out = '';

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    statsPort = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: {
        ...process.env,
        HA_BASE: mock.base, HA_TOKEN: 'test-token', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(statsPort), STRIP_ENTITIES: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => { out += b.toString(); });
    proxy.stderr.on('data', (b) => { out += b.toString(); });
    const deadline = Date.now() + 8000;
    while (!/stats panel on/.test(out) || !/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(`proxy never started\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  after(() => { proxy?.kill(); mock?.close(); });

  // Regression: Home Assistant batches messages into a JSON array, and `m.type` is undefined on
  // an array. The batched frame was labelled in the array branch AND then fell through every
  // branch of done() into the "(no type field)" bucket — so each frame produced two rows.
  // Measured on a live instance: 165 batched frames, 165 phantom "(no type field)" entries
  // carrying 2.78MB that was never a distinct payload. The array branch also recorded inBytes
  // while every other path recorded outBytes, so the largest row in the table was reported at
  // its PRE-TRIM size and could not be compared with any row beside it.
  it('counts a batched frame once, at its trimmed size', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities', id: 70 });
    await new Promise((r) => setTimeout(r, 200));

    const before = JSON.parse((await httpGet(`http://127.0.0.1:${statsPort}/stats.json`)).body).byMessage;
    const noTypeBefore = before['(no type field)']?.count ?? 0;

    // A batch carrying an entity event plus an unrelated result — HA's real shape.
    mock.pushEntityEventBatched(
      { a: { 'light.living_room': { s: 'on' } } },
      { id: 998, type: 'result', success: true, result: { pad: 'x'.repeat(5000) } },
    );
    await new Promise((r) => setTimeout(r, 400));

    const after = JSON.parse((await httpGet(`http://127.0.0.1:${statsPort}/stats.json`)).body).byMessage;
    const batched = Object.entries(after).filter(([k]) => k.startsWith('batched '));
    assert.ok(batched.length, `a batched row was recorded; got ${JSON.stringify(Object.keys(after))}`);

    assert.equal(after['(no type field)']?.count ?? 0, noTypeBefore,
      'a batched frame must NOT also be filed under "(no type field)" — that bucket is for '
      + 'genuinely typeless objects, and double-counting made it the second-largest row on a live panel');

    // The recorded size must be what went out, not what came in. The filler is ~5KB and survives
    // trimming here, so this pins the units rather than the exact number.
    const [, row] = batched[0];
    assert.ok(row.bytes > 0, 'the batched row carries a size');
    assert.ok(row.bytes < 1024 * 1024, `a single small batch must not report megabytes (got ${row.bytes})`);
  });
});

// The write endpoint's security boundary.
//
// The stats server binds every interface — that is how http://<host>:8100/stats.json works from a
// laptop — and it has always been READ-ONLY, so an unauthenticated reader learned only what the
// panel shows. Adding a config-write endpoint to the same server would let anyone on the LAN
// change this add-on's settings. Writes are therefore accepted only from Home Assistant Ingress,
// which authenticates the user before proxying and stamps X-Ingress-Path.
describe('resource pinning is Ingress-only', () => {
  let mock, proxy, port, statsPort, out = '';

  const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: statsPort, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(data);
  });

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    statsPort = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: {
        ...process.env, HA_BASE: mock.base, HA_TOKEN: 'test-token', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(statsPort), STRIP_ENTITIES: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => { out += b.toString(); });
    proxy.stderr.on('data', (b) => { out += b.toString(); });
    const deadline = Date.now() + 8000;
    while (!/stats panel on/.test(out)) {
      if (Date.now() > deadline) throw new Error(`proxy never started\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  after(() => { proxy?.kill(); mock?.close(); });

  it('refuses a write that did not come through Ingress', async () => {
    const res = await post('/pin-resource', { fragment: 'kiosk-mode' });
    assert.equal(res.status, 403,
      'a direct request to the stats port must not be able to change add-on configuration');
    assert.match(res.body, /Ingress/);
  });

  it('says so in the log, so an attempt is visible rather than silent', async () => {
    assert.match(out, /refused a resource pin from .* writes are Ingress-only/);
  });

  it('rejects a fragment too short to mean anything, even via Ingress', async () => {
    // A fragment is matched as a substring against resource URLs. An empty or one-character one
    // would match every resource and silently undo the whole feature.
    const res = await post('/pin-resource', { fragment: 'a' }, { 'x-ingress-path': '/api/hassio_ingress/x' });
    assert.equal(res.status, 400);
    assert.match(res.body, /at least 3 characters/);
  });

  it('still serves reads to anyone, which is unchanged behaviour', async () => {
    const res = await httpGet(`http://127.0.0.1:${statsPort}/stats.json`);
    assert.equal(res.status, 200, 'read access must not be affected by the write gate');
  });
});

describe('registry cache hit rate', () => {
  it('is null before anything has been asked for, not zero', () => {
    // A 0% hit rate on zero requests is a fiction. Publishing it would put a false trough in the
    // long-term statistics every time the add-on restarted — the same class of bug as the
    // retained-zero one the MQTT publisher had.
    stats.reset();
    assert.equal(stats.snapshot().registryCache.hitRatePct, null);
  });

  it('is a real ratio once there are hits and misses', () => {
    stats.reset();
    stats.recordCacheHit(100);
    stats.recordCacheHit(100);
    stats.recordCacheHit(100);
    stats.recordCacheMiss();
    const c = stats.snapshot().registryCache;
    assert.equal(c.hits, 3);
    assert.equal(c.misses, 1);
    assert.equal(c.hitRatePct, 75, '3 of 4 is 75%');
  });

  it('reports 100 when nothing has missed', () => {
    stats.reset();
    stats.recordCacheHit(10);
    assert.equal(stats.snapshot().registryCache.hitRatePct, 100);
  });

  it('reports 0 when everything has missed, which is different from null', () => {
    stats.reset();
    stats.recordCacheMiss();
    assert.equal(stats.snapshot().registryCache.hitRatePct, 0);
  });
});
