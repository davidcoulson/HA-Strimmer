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

  // Home Assistant batches: one websocket frame routinely carries dozens of entity diffs. The
  // count must advance per EVENT while the bytes are attributed once, from the frame that
  // actually went out — otherwise the only way to weigh each message is to re-serialise it,
  // which is what this signature exists to avoid on the proxy's hottest path.
  it('counts every event in a batched frame but weighs the frame once', () => {
    stats.reset();
    stats.recordEvent(9000, 40);       // one frame, forty entity diffs
    const s = stats.snapshot();
    assert.equal(s.eventStream.count, 40, 'forty events happened, not one');
    assert.equal(s.eventStream.bytes, 9000, 'and the frame is weighed once, not forty times');
  });

  it('still counts a single unbatched event as one', () => {
    stats.reset();
    stats.recordEvent(120);
    const s = stats.snapshot();
    assert.equal(s.eventStream.count, 1, 'the count argument must default to 1');
    assert.equal(s.eventStream.bytes, 120);
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
    assert.equal(s.options.trim_entities, true);
    // The section map has to SURVIVE to the payload, not merely be built. snapshot() copies named
    // fields out of the extras object rather than spreading it, so a new field is dropped in
    // silence — which is exactly what happened to this one: the proxy built it, the panel read
    // it, and the wire carried nothing. Asserting on the proxy source alone did not catch it.
    assert.ok(s.optionSections && Object.keys(s.optionSections).length >= 20,
      'stats.json must carry the option-to-section map');
    assert.equal(s.optionSections.by_dashboard, 'trim');
    assert.equal(s.optionSections.mdns_discovery, 'discovery');
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
    // WAIT for the line rather than asserting on `out` immediately. The refusal is logged as
    // the request is rejected, but `out` is filled asynchronously from the child's stdout pipe
    // — the HTTP response above can arrive in this process before the log line has been read
    // off that pipe. Asserting straight away is a race, and it is one that had been passing by
    // luck: it failed on Node 22 in CI while 24 and 26 went green, which looks like a runtime
    // difference and is really just a slower runner losing a coin toss.
    const re = /refused a resource pin from .* writes are Ingress-only/;
    const deadline = Date.now() + 5000;
    while (!re.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.match(out, re);
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

describe('runtime version reporting', () => {
  // The point of this field is that it cannot be wrong. Reading it from `process` rather than
  // accepting it in `extra` is what guarantees that — so the test pins the SOURCE, not just the
  // presence of a string. A future refactor that "tidies" it into a passed-in constant would
  // reintroduce exactly the drift it exists to prevent.
  it('reports the running Node version, taken from the process itself', () => {
    const snap = stats.snapshot({ version: '2026.01.01.1' });
    assert.equal(snap.node, process.version);
    assert.match(snap.node, /^v\d+\.\d+\.\d+/);
    // And it is independent of the add-on version beside it.
    assert.notEqual(snap.node, snap.version);
  });

  it('is not overridable by the caller', () => {
    const snap = stats.snapshot({ version: 'x', node: 'v0.0.0-fake', os: 'Fake Linux 1.0' });
    assert.equal(snap.node, process.version, 'extra.node must not win over the real runtime');
    assert.notEqual(snap.os, 'Fake Linux 1.0', 'extra.os must not win over the real OS either');
  });

  // The OS field is present on every platform; only its VALUE is platform-dependent. Asserting
  // a specific distro would make this test pass only inside the image — which is precisely
  // where it is least needed, since that is the environment it exists to describe.
  it('reports an OS string in a container and null where there is no container', () => {
    const snap = stats.snapshot({ version: 'x' });
    assert.ok('os' in snap, 'the field must always exist, so the panel can branch on it');
    if (snap.os !== null) {
      assert.equal(typeof snap.os, 'string');
      assert.ok(snap.os.length > 0 && snap.os.length < 120, `implausible os string: ${snap.os}`);
    }
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

// Searching for an entity that was dropped is the answer to "why is this card blank", and it is
// the one question the panel could not previously answer: an entity outside the allowlist appears
// nowhere else in the stats, by definition.
describe('entity search', () => {
  it('finds entities in and out of the allowlist, and pinning is Ingress-only', async () => {
  const mock = await startMockHa();
  const port = await getFreePort();
  const statsPort = await getFreePort();
  const proxy = spawn(process.execPath, [PROXY], {
    cwd: path.join(DIR, '..'),
    env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 'test-token', DASH_PATHS: 'test-dash',
           PORT: String(port), STATS_PORT: String(statsPort), STRIP_ENTITIES: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proxy.stdout.on('data', (b) => { out += b.toString(); });
  proxy.stderr.on('data', (b) => { out += b.toString(); });
  const deadline = Date.now() + 10000;
  while (!/union allowlist for/.test(out)) {
    if (Date.now() > deadline) throw new Error(`proxy never started\n${out}`);
    await new Promise((r) => setTimeout(r, 50));
  }

  const get = (p) => new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port: statsPort, path: p }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
    });
    r.on('error', reject);
  });

  try {
    // light.decoy exists on the instance and is on no dashboard — precisely the case this is for.
    const dropped = await get('/entities.json?q=decoy');
    assert.equal(dropped.status, 200);
    const decoy = dropped.json.matches.find((m) => m.entity_id === 'light.decoy');
    assert.ok(decoy, 'an entity outside the allowlist must still be findable');
    assert.equal(decoy.kept, false, 'and must be reported as not currently sent');

    const kept = await get('/entities.json?q=living_room');
    const lr = kept.json.matches.find((m) => m.entity_id === 'light.living_room');
    assert.ok(lr && lr.kept === true, 'an allowlisted entity is reported as sent');

    // The write is a configuration change, so it carries the same Ingress gate as /pin-resource.
    const post = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ entity_id: 'light.decoy' });
      const r = http.request({ host: '127.0.0.1', port: statsPort, path: '/pin-entity', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
        let b = ''; res.on('data', (c) => b += c);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      r.on('error', reject); r.end(data);
    });
    assert.equal(post.status, 403, 'a direct write must be refused, exactly like pin-resource');
    assert.match(post.body, /Ingress/);
  } finally { proxy.kill(); await mock.close(); }
});
});

// How connections reached the add-on, as a JOINT distribution.
//
// The panel draws this as a Sankey, and a Sankey's links ARE the pairings — which three
// independently-counted marginals cannot reconstruct. These pin the two properties the diagram
// depends on: the pairing survives recording, and the marginals are the joint summed, so the
// diagram and the table underneath it cannot contradict each other.
describe('connection paths', () => {
  it('keeps origin, route and host together rather than counting them separately', () => {
    stats.reset();
    const open = (origin, route, host) => stats.connOpen({ ip: '10.0.0.1', origin, route, host });
    open('lan', 'proxy', 'home.example.org');
    open('lan', 'proxy', 'home.example.org');
    open('internet', 'cloudflare', 'ha.example.org');
    open('lan', 'direct', '10.0.0.6');

    const { flows } = stats.snapshot().paths;
    const find = (o, r, h) => flows.find((f) => f.origin === o && f.route === r && f.host === h);

    assert.equal(find('lan', 'proxy', 'home.example.org').n, 2);
    assert.equal(find('internet', 'cloudflare', 'ha.example.org').n, 1);
    assert.equal(find('lan', 'direct', '10.0.0.6').n, 1);
    // The pairing is the whole point: the internet connection must not be attributable to the
    // LAN hostname, which is precisely what separate tallies would have allowed.
    assert.equal(find('internet', 'cloudflare', 'home.example.org'), undefined);
    assert.equal(flows.length, 3, 'one entry per distinct path, not per connection');
    // Sorted so the panel can draw the thickest band first without re-sorting.
    assert.deepEqual(flows.map((f) => f.n), [...flows.map((f) => f.n)].sort((a, b) => b - a));
  });

  it('derives every marginal from the joint, so none can disagree with it', () => {
    stats.reset();
    stats.connOpen({ ip: '1.1.1.1', origin: 'lan', route: 'proxy', host: 'a.example' });
    stats.connOpen({ ip: '1.1.1.2', origin: 'lan', route: 'direct', host: 'a.example' });
    stats.connOpen({ ip: '1.1.1.3', origin: 'internet', route: 'proxy', host: 'b.example' });

    const p = stats.snapshot().paths;
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    const total = p.flows.reduce((a, f) => a + f.n, 0);

    assert.equal(total, 3);
    // Each marginal is a different partition of the SAME connections, so all three must total
    // the same number. A separately-counted marginal is free to drift; a derived one is not.
    assert.equal(sum(p.byOrigin), total, 'byOrigin must sum to the connection count');
    assert.equal(sum(p.byRoute), total, 'byRoute must sum to the connection count');
    assert.equal(sum(p.byHost), total, 'byHost must sum to the connection count');
    assert.deepEqual(p.byOrigin, { lan: 2, internet: 1 });
    assert.deepEqual(p.byRoute, { proxy: 2, direct: 1 });
    assert.deepEqual(p.byHost, { 'a.example': 2, 'b.example': 1 });
  });

  it('labels a missing signal rather than dropping the connection from the diagram', () => {
    stats.reset();
    // An Ingress connection has no hostname the client dialled. Counting it as nothing would
    // make the bands stop summing to the number of connections.
    stats.connOpen({ ip: '172.30.32.1', origin: 'lan', route: 'ingress', host: null });
    const p = stats.snapshot().paths;
    assert.equal(p.flows.length, 1);
    assert.equal(p.flows[0].host, 'unknown');
    assert.equal(Object.values(p.byHost).reduce((a, b) => a + b, 0), 1);
  });
});

// Clients seen in the last 24 hours but not connected now.
//
// The live list answers "what is connected", which is the wrong question when a panel has gone
// dark — the row worth looking at is exactly the one that vanished. These pin the three things
// that make that list readable rather than a reconnect log: a device folds into ONE row however
// often it reconnects, a live client never appears in both lists at once, and a row leaves the
// list when it ages out of the window.
describe('clients seen in the last 24h', () => {
  const openConn = (ip, dash) => stats.connOpen({ ip, dash, origin: 'lan', route: 'proxy', host: 'h' });

  it('folds repeat connections from one client into a single row', () => {
    stats.reset();
    for (let i = 0; i < 5; i++) stats.connClose(openConn('10.0.0.9', 'kiosk'));
    const recent = stats.snapshot().clients.recent;
    assert.equal(recent.length, 1, 'five reconnects are one client, not five rows');
    assert.equal(recent[0].sessions, 5, 'the reconnect count is what makes the fold honest');
    assert.equal(recent[0].ip, '10.0.0.9');
  });

  it('never lists a client that is connected right now', () => {
    stats.reset();
    const first = openConn('10.0.0.10', 'kiosk');
    stats.connClose(first);
    assert.equal(stats.snapshot().clients.recent.length, 1, 'closed: it belongs in the 24h list');
    // The same client comes back. It is now live, so it must leave the 24h list entirely rather
    // than appear in both with two different sets of numbers.
    const again = openConn('10.0.0.10', 'kiosk');
    const snap = stats.snapshot();
    assert.equal(snap.clients.recent.length, 0, 'a live client must not also be listed as recent');
    assert.equal(snap.clients.list.length, 1);
    stats.connClose(again);
    assert.equal(stats.snapshot().clients.recent.length, 1, 'and returns to it once closed again');
  });

  it('keeps the identity details a closed row is looked up by', () => {
    stats.reset();
    const id = stats.connOpen({ ip: '10.0.0.11', dash: 'office', origin: 'internet',
      route: 'cloudflare', host: 'ha.example.org' });
    stats.connIdentity(id, { user: 'David Coulson', allowSize: 42 });
    stats.connClose(id);
    const r = stats.snapshot().clients.recent[0];
    assert.equal(r.user, 'David Coulson', 'the user must survive into the 24h list');
    assert.equal(r.dashboard, 'office');
    assert.equal(r.route, 'cloudflare');
    assert.equal(r.allowSize, 42);
    assert.ok(Number.isFinite(r.lastSeenSec), 'a closed row is ordered and read by when it was last seen');
  });

  it('separates clients that share an address but not a dashboard', () => {
    stats.reset();
    stats.connClose(openConn('10.0.0.12', 'kiosk'));
    stats.connClose(openConn('10.0.0.12', 'office'));
    const recent = stats.snapshot().clients.recent;
    assert.equal(recent.length, 2, 'one browser on two dashboards is two things worth seeing');
  });
});

// Naming a route after the machine that delivered it.
//
// "proxy" is ambiguous in this add-on specifically, because the add-on IS a proxy — so the panel
// prefers the hop's real name when there is one. The rule that matters is the abstention: a name
// is only offered when every machine serving that route agrees on it, because a label that is
// true of some of the traffic and false for the rest is worse than the generic wording.
describe('naming a route after its hop', () => {
  const open = (route, hop) => stats.connOpen({ ip: '10.0.0.1', origin: 'lan', route, host: 'h', hop });

  it('names a route when every hop that served it resolves to the same name', () => {
    stats.reset();
    open('proxy', '172.30.33.5');
    open('proxy', '172.30.33.5');
    const snap = stats.snapshot({ hopNameFor: (ip) => (ip === '172.30.33.5' ? 'nginxproxymanager' : null) });
    assert.equal(snap.paths.routeNames.proxy, 'nginxproxymanager');
  });

  it('offers no name when two different machines serve the same route', () => {
    stats.reset();
    open('proxy', '172.30.33.5');
    open('proxy', '10.2.9.9');
    const snap = stats.snapshot({
      hopNameFor: (ip) => (ip === '172.30.33.5' ? 'nginxproxymanager' : 'caddy'),
    });
    assert.equal(snap.paths.routeNames.proxy, undefined,
      'two names for one route means the panel must fall back to the generic label');
  });

  it('offers no name when the hop does not resolve', () => {
    stats.reset();
    open('proxy', '10.2.9.9');
    const snap = stats.snapshot({ hopNameFor: () => null });
    assert.equal(snap.paths.routeNames.proxy, undefined);
  });

  // On a direct connection the hop IS the client, so a resolvable name there belongs to a wall
  // panel, not to a entry point. Naming the route after it would put "laundry-tablet" in the Route
  // column — which is why only `proxy` is named at all.
  it('never names a direct route, where the hop is the client itself', () => {
    stats.reset();
    open('proxy', '172.30.33.5');
    open('direct', '10.2.4.209');
    const snap = stats.snapshot({
      hopNameFor: (ip) => (ip === '172.30.33.5' ? 'nginxproxymanager' : 'laundry-tablet'),
    });
    assert.equal(snap.paths.routeNames.proxy, 'nginxproxymanager');
    assert.equal(snap.paths.routeNames.direct, undefined,
      'a client hostname must never be presented as the route it arrived on');
  });

  it('reports nothing at all when no resolver is supplied', () => {
    stats.reset();
    open('proxy', '172.30.33.5');
    assert.deepEqual(stats.snapshot().paths.routeNames, {});
  });
});

// The configuration endpoints behind the console's Config tab.
//
// These WRITE configuration, so they carry the same Ingress-only rule as the pins — and two
// things beyond it: a setup option can never be taken over, and a save must say plainly that it
// applies on the next restart rather than now.
describe('config endpoints', () => {
  const post = (port, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: '/config', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.end(data);
  });
  const get = (port, path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });

  it('reports every option with the source answering for it', async () => {
    const mock = await startMockHa();
    const port = await getFreePort(); const sp = await getFreePort();
    const proxy = spawn(process.execPath, [PROXY], { cwd: path.join(DIR, '..'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(sp), STRIP_ENTITIES: '1' } });
    try {
      let out = ''; proxy.stdout.on('data', (b) => out += b); proxy.stderr.on('data', (b) => out += b);
      const deadline = Date.now() + 10000;
      while (!/for live allowlist updates/.test(out)) {
        if (Date.now() > deadline) throw new Error(`no boot\n${out}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const d = JSON.parse((await get(sp, '/config.json')).body);
      // This proxy was started from the environment, with no options file at all. Every option
      // must STILL be listed: the console's job is to offer settings that have never been set,
      // and an earlier version derived the list from the options file, so on a fresh install it
      // showed nothing at all.
      assert.ok(Array.isArray(d.options) && d.options.length >= 20,
        `every option must be offered even with no options file, got ${d.options?.length}`);
      const themes = d.options.find((o) => o.key === 'trim_themes');
      assert.ok(themes, 'an option that is not set must still be listed');
      assert.equal(themes.editable, true);
      assert.equal(themes.type, 'bool', 'the console needs the type to pick a control');

      // Setup options are NAMED so the console can explain where they live, but they get no
      // rows: they belong in the add-on configuration and listing them here put one setting in
      // two places, with the console showing the copy that is not authoritative.
      assert.ok(d.bootstrap.includes('proxy_port') && d.bootstrap.includes('ha_base'),
        'setup options are still named, so the console can point at where they live');
      for (const k of d.bootstrap) {
        assert.equal(d.options.find((o) => o.key === k), undefined,
          `${k} is a setup option and must not be a row`);
      }
      // And the same for a renamed option: the canonical name is the row, the old spelling is not.
      assert.equal(d.options.find((o) => o.key === 'strip_entities'), undefined,
        'a legacy spelling must not get its own row');
      assert.ok(d.options.find((o) => o.key === 'trim_entities'), 'the canonical name is the row');
      // The structured lists are editable now that the Overrides screen can write them. They are
      // still marked `objects`, because the page must NOT offer them as a JSON text box — that is
      // what the override list and its wizard replaced.
      const overrides = d.options.find((o) => o.key === 'user_overrides');
      assert.equal(overrides.type, 'objects');
      assert.equal(overrides.editable, true);
      assert.equal(overrides.section, 'overrides',
        'the override lists must land in the section that renders the rule editor');
    } finally { proxy.kill(); await mock.close(); }
  });

  it('refuses a write that did not come through Ingress', async () => {
    const mock = await startMockHa();
    const port = await getFreePort(); const sp = await getFreePort();
    const proxy = spawn(process.execPath, [PROXY], { cwd: path.join(DIR, '..'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(sp), STRIP_ENTITIES: '1' } });
    try {
      let out = ''; proxy.stdout.on('data', (b) => out += b); proxy.stderr.on('data', (b) => out += b);
      const deadline = Date.now() + 10000;
      while (!/for live allowlist updates/.test(out)) {
        if (Date.now() > deadline) throw new Error(`no boot\n${out}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const r = await post(sp, { key: 'trim_themes', action: 'adopt' });
      assert.equal(r.status, 403, 'a direct write must be refused, exactly like the pins');
      assert.match(r.body, /Ingress/);
    } finally { proxy.kill(); await mock.close(); }
  });
});

// The panel is served on its own port as well as through Ingress, and writes are Ingress-only.
// Without this flag every control renders as editable on the direct port and then fails with a
// 403 on click — a console that offers an edit it cannot accept.
describe('config editability is reported per request', () => {
  it('says a direct request cannot edit, even though the add-on can write', async () => {
    const mock = await startMockHa();
    const port = await getFreePort(); const sp = await getFreePort();
    const proxy = spawn(process.execPath, [PROXY], { cwd: path.join(DIR, '..'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(sp), STRIP_ENTITIES: '1' } });
    try {
      let out = ''; proxy.stdout.on('data', (b) => out += b); proxy.stderr.on('data', (b) => out += b);
      const deadline = Date.now() + 10000;
      while (!/for live allowlist updates/.test(out)) {
        if (Date.now() > deadline) throw new Error(`no boot\n${out}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const plain = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: sp, path: '/config.json' }, (res) => {
          let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(JSON.parse(b)));
        }).on('error', reject);
      });
      assert.equal(plain.editableHere, false, 'a request without the Ingress header cannot edit');

      // And the same request through Ingress can — otherwise the flag would just be "false"
      // always, which would disable the editor everywhere and still pass the assertion above.
      const viaIngress = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: sp, path: '/config.json',
          headers: { 'x-ingress-path': '/api/hassio_ingress/abc' } }, (res) => {
          let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(JSON.parse(b)));
        }).on('error', reject);
      });
      assert.equal(viaIngress.editableHere, true, 'an Ingress request must be able to edit');
    } finally { proxy.kill(); await mock.close(); }
  });
});
