// Pausing the trim, per Home Assistant user, for a bounded time.
//
// The case this exists for: an admin away from home, on a phone through Cloudflare, who cannot
// see an entity because no card on the dashboard names it — so the very thing they need in order
// to troubleshoot is what the trimming has removed. What matters in these tests is that the pause
// reaches the connection BEFORE its first `subscribe_entities` (anything later is too late, since
// HA cannot amend a live subscription), that it is scoped to the one user, and that it ends.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';
import {
  emptyPauses, sanitize, pauseUser, resumeUser, sweep, pausedUntil, pausedForUser, anyActive,
  listPauses, msUntilEndOfDay, readPauses, writePauses, ADMINS, isRoleKey, MAX_PAUSE_MS,
} from '../pause.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

describe('the pause store', () => {
  const NOW = 1_700_000_000_000;

  it('holds a pause for one user and answers for that user only', () => {
    const s = pauseUser(emptyPauses(), 'u-david', 3600000, { name: 'David', now: NOW });
    assert.equal(pausedUntil(s, 'u-david', NOW), NOW + 3600000);
    assert.equal(pausedUntil(s, 'u-michelle', NOW), null);
  });

  it('matches the user id regardless of case, since it arrives from two different sources', () => {
    // One end is Supervisor's Ingress header, the other is auth/current_user. They agree on the
    // id but nothing guarantees they agree on its casing.
    const s = pauseUser(emptyPauses(), 'U-David', 60000, { now: NOW });
    assert.ok(pausedUntil(s, 'u-david', NOW));
  });

  it('is over once the clock passes it, without anything having to run', () => {
    const s = pauseUser(emptyPauses(), 'u-david', 60000, { now: NOW });
    assert.equal(pausedUntil(s, 'u-david', NOW + 59000), NOW + 60000);
    assert.equal(pausedUntil(s, 'u-david', NOW + 61000), null, 'an elapsed pause is not a pause');
    assert.equal(anyActive(s, NOW + 61000), false);
  });

  it('sweeps expired pauses and names who expired, so their connections can be recycled', () => {
    let s = pauseUser(emptyPauses(), 'u-david', 60000, { now: NOW });
    s = pauseUser(s, 'u-kiosk', 600000, { now: NOW });
    const [next, expired] = sweep(s, NOW + 61000);
    assert.deepEqual(expired, ['u-david']);
    assert.ok(pausedUntil(next, 'u-kiosk', NOW + 61000), 'the other pause is untouched');
  });

  it('refuses a pause with no duration, rather than writing one that never ends', () => {
    assert.throws(() => pauseUser(emptyPauses(), 'u-david', 0), /duration/);
    assert.throws(() => pauseUser(emptyPauses(), '', 1000), /user id/);
  });

  it('caps a pause at a day, however long it was asked for', () => {
    const s = pauseUser(emptyPauses(), 'u-david', 99 * 24 * 3600000, { now: NOW });
    assert.equal(pausedUntil(s, 'u-david', NOW), NOW + MAX_PAUSE_MS);
  });

  // The switch in Home Assistant has no user behind it, so what it can pause is a ROLE. These
  // pin that it reaches every administrator and nobody else.
  it('pauses every administrator at once, and only administrators', () => {
    const s = pauseUser(emptyPauses(), ADMINS, 3600000, { now: NOW });
    const admin = { id: 'u-david', name: 'David', is_admin: true };
    const kiosk = { id: 'u-kiosk', name: 'Kiosk', is_admin: false };
    assert.ok(pausedForUser(s, admin, NOW), 'an admin is paused by the role');
    assert.equal(pausedForUser(s, kiosk, NOW), null, 'a wall panel keeps its trim');
    assert.equal(pausedForUser(s, null, NOW), null, 'an unresolved user is never paused');
  });

  it('keeps a personal pause working for a non-admin', () => {
    const s = pauseUser(emptyPauses(), 'u-kiosk', 3600000, { now: NOW });
    assert.ok(pausedForUser(s, { id: 'u-kiosk', is_admin: false }, NOW));
  });

  it('cannot collide with a real user id', () => {
    // HA user ids are 32 hex characters, so a colon cannot appear in one.
    assert.ok(isRoleKey(ADMINS));
    assert.ok(!isRoleKey('0123456789abcdef0123456789abcdef'));
    assert.match(ADMINS, /:/);
  });

  it('labels the role pause for the console, which should not know the key', () => {
    const s = pauseUser(emptyPauses(), ADMINS, 60000, { now: NOW });
    const [row] = listPauses(s, NOW);
    assert.equal(row.role, 'admin');
    assert.equal(row.name, 'administrators');
  });

  it('resumes early', () => {
    const s = resumeUser(pauseUser(emptyPauses(), 'u-david', 60000, { now: NOW }), 'u-david');
    assert.equal(pausedUntil(s, 'u-david', NOW), null);
  });

  it('drops junk on load rather than trusting the file', () => {
    // Same rule as history.mjs: this file is read back across restarts and versions, and a
    // damaged row here decides whether a connection is trimmed. The safe failure is "still
    // trimming", never "silently stopped".
    const s = sanitize({ pauses: {
      'u-good': { until: NOW + 60000 },
      'u-expired': { until: NOW - 1 },
      'u-nonsense': { until: 'soon' },
      'u-forever': { until: NOW + 99 * 24 * 3600000 },
      'u-broken': 'not an object',
    } }, NOW);
    assert.deepEqual(Object.keys(s.pauses).sort(), ['u-forever', 'u-good']);
    assert.equal(s.pauses['u-forever'].until, NOW + MAX_PAUSE_MS, 'a hand-edited year is still a day');
    assert.deepEqual(sanitize(null, NOW), emptyPauses());
    assert.deepEqual(sanitize({ pauses: 'nope' }, NOW), emptyPauses());
  });

  it('will not let a persisted __proto__ key touch the prototype', () => {
    const s = sanitize(JSON.parse('{"pauses":{"__proto__":{"until":99999999999999}}}'), NOW);
    assert.deepEqual(s.pauses, {});
    assert.equal({}.until, undefined);
  });

  it('round-trips through /data and comes back without the expired rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strimmer-pause-'));
    let s = pauseUser(emptyPauses(), 'u-david', 3600000);
    s = pauseUser(s, 'u-old', 1000);
    writePauses(dir, s);
    const back = readPauses(dir, Date.now() + 2000);
    assert.ok(pausedUntil(back, 'u-david'), 'a live pause survives a restart');
    assert.equal(pausedUntil(back, 'u-old'), null, 'one that ran out while down does not');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a missing or unreadable file as no pauses at all', () => {
    assert.deepEqual(readPauses('/nope/not/here'), emptyPauses());
    assert.deepEqual(readPauses(null), emptyPauses());
  });

  it('lists what the console renders, soonest expiry first', () => {
    let s = pauseUser(emptyPauses(), 'u-late', 600000, { name: 'Late', now: NOW });
    s = pauseUser(s, 'u-soon', 60000, { name: 'Soon', now: NOW });
    assert.deepEqual(listPauses(s, NOW).map((p) => p.user), ['u-soon', 'u-late']);
  });

  // "Rest of the day" is a question about the VIEWER's midnight. The container runs UTC and the
  // person is somewhere else, so the console sends its own offset and the span is computed from
  // it — a timezone setting here would be a second thing to keep in step with reality.
  it('computes the rest of the day in the viewer\'s timezone, not the container\'s', () => {
    const at2300utc = Date.UTC(2026, 0, 15, 23, 0, 0);
    const utc = msUntilEndOfDay(0, at2300utc);
    assert.ok(utc > 59 * 60000 && utc <= 3600000, `an hour left in UTC, got ${utc}ms`);
    // New York is UTC-5 in January: 23:00 UTC is 18:00 there, so about six hours remain.
    const ny = msUntilEndOfDay(300, at2300utc);
    assert.ok(ny > 5.9 * 3600000 && ny < 6.1 * 3600000, `about six hours in New York, got ${ny}ms`);
  });

  it('never returns a zero-length or over-long day', () => {
    const justBeforeMidnight = Date.UTC(2026, 0, 15, 23, 59, 59, 900);
    assert.ok(msUntilEndOfDay(0, justBeforeMidnight) >= 60000, 'a pause of 0ms would be a no-op');
    assert.ok(msUntilEndOfDay(-100000, Date.UTC(2026, 0, 15, 12)) <= MAX_PAUSE_MS, 'a bogus offset buys nothing');
  });
});

// The proxy end: a pause has to reach the bridge before its first subscribe_entities, apply to
// one user only, and put the trim back when it ends.
describe('a paused user is served untrimmed', () => {
  let mock, proxy, port, statsPort, dataDir, out = '';

  const post = (p, body, headers = {}) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: statsPort, path: p, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    });
    req.on('error', reject);
    req.end(data);
  });

  // What Ingress looks like from here: Supervisor's header, and the user it authenticated.
  const asUser = (id, name) => ({
    'x-ingress-path': '/api/hassio_ingress/test',
    'x-remote-user-id': id,
    'x-remote-user-display-name': name,
  });

  // The entity_ids the proxy injected for a connection, or null when it injected none — which is
  // what "not trimmed" looks like on the wire: HA reads a missing entity_ids as "no filter".
  const injectedFor = async (token) => {
    const seq = mock.subscribeEntitiesSeq();
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, token);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    const got = await mock.waitForSubscribeEntities(seq);
    c.close();
    return got ?? null;
  };

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    statsPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strimmer-pausedata-'));
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: {
        ...process.env, HA_BASE: mock.base, HA_TOKEN: 'test-token', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(statsPort), STRIP_ENTITIES: '1',
        CONFIG_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => { out += b.toString(); });
    proxy.stderr.on('data', (b) => { out += b.toString(); });
    // Wait for the ALLOWLIST, not just the console port. The proxy refuses `/api/websocket`
    // until it has one — correctly, since an empty entity_ids means "no filter" to HA — so a
    // harness that only waits for the server to bind passes alone and loses the race whenever
    // the suite runs the spawn-heavy files together. Same marker every other proxy suite uses.
    // 40s, not 25: this file adds one more spawning suite to a run that already has five,
    // and the deadline should outlast a loaded machine rather than report a startup that was
    // merely slow as a startup that failed.
    const deadline = Date.now() + 40000;
    while (!/for live allowlist updates/.test(out)) {
      if (Date.now() > deadline) throw new Error(`proxy never started\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  after(() => {
    proxy?.kill(); mock?.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('trims normally before anyone pauses', async () => {
    const ids = await injectedFor('david-token');
    assert.ok(Array.isArray(ids) && ids.length, 'a normal connection gets an injected allowlist');
  });

  it('refuses a pause that did not come through Ingress', async () => {
    const res = await post('/pause', { preset: 'hour' });
    assert.equal(res.status, 403, 'anything on the LAN could otherwise turn the trimming off');
    assert.match(res.body, /Ingress/);
  });

  it('refuses a pause when Home Assistant did not say who is asking', async () => {
    // The identity comes from Supervisor, never the body. Without it there is nobody to pause,
    // and guessing would mean pausing the wrong person — or everybody.
    const res = await post('/pause', { preset: 'hour', user: 'u-david' },
      { 'x-ingress-path': '/api/hassio_ingress/test' });
    assert.equal(res.status, 400);
    assert.match(res.body, /did not say who you are/);
  });

  it('stops trimming that user, and nobody else', async () => {
    const res = await post('/pause', { preset: 'hour' }, asUser('u-david', 'David'));
    assert.equal(res.status, 200);
    assert.ok(res.json.until > Date.now(), 'the reply says when it ends');

    assert.equal(await injectedFor('david-token'), null,
      'the paused user gets no entity_ids at all, which is how HA is told not to filter');
    const michelle = await injectedFor('michelle-token');
    assert.ok(Array.isArray(michelle) && michelle.length,
      'everyone else keeps their trim — a pause is one person troubleshooting, not a global switch');
  });

  it('says so in the log, with an end time', async () => {
    const re = /trim PAUSED for David until .* — serving everything until|trim PAUSED for David until/;
    const deadline = Date.now() + 5000;
    while (!re.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.match(out, /trim PAUSED for David until/);
  });

  it('shows the pause in the snapshot the console polls', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: statsPort, path: '/stats.json',
        headers: { 'x-ingress-path': '/api/hassio_ingress/test' } }, (r) => {
        let b = ''; r.on('data', (c) => b += c); r.on('end', () => resolve(JSON.parse(b)));
      });
      req.on('error', reject);
    });
    assert.equal(res.pauses.length, 1);
    assert.equal(res.pauses[0].name, 'David');
    assert.ok(res.pauses[0].msLeft > 0);
  });

  it('hides WHO is paused from a reader that is not on Ingress, but not THAT it is paused', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${statsPort}/stats.json`, (r) => {
        let b = ''; r.on('data', (c) => b += c); r.on('end', () => resolve(JSON.parse(b)));
      });
      req.on('error', reject);
    });
    assert.equal(res.redacted, true);
    assert.equal(res.pauses.length, 1, 'a health check should still see that trimming is off');
    assert.equal(res.pauses[0].user, undefined, 'but not whose it is');
    assert.equal(res.pauses[0].name, undefined);
  });

  it('drops that user\'s open connections so the pause reaches the page they are looking at', async () => {
    // HA cannot amend a live subscribe_entities, so a pause that does not recycle is a pause the
    // phone in your hand never sees.
    await post('/resume', {}, asUser('u-david', 'David'));
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, 'david-token');
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    await new Promise((r) => setTimeout(r, 400));
    const closed = new Promise((r) => c.ws.once('close', () => r(true)));
    const res = await post('/pause', { preset: 'hour' }, asUser('u-david', 'David'));
    assert.equal(res.status, 200);
    assert.ok(res.json.reconnected >= 1, 'the reply reports what it recycled');
    assert.equal(await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 3000))]), true,
      'the connection must be dropped so the frontend re-subscribes untrimmed');
    c.close();
  });

  it('pauses admins as a group, leaving the kiosk user trimmed', async () => {
    // What the Home Assistant switch does. david-token is an admin in the mock; kiosk-token is
    // not, which is exactly the wall-panel case this scope exists to protect.
    // Clear BOTH kinds first. The previous test leaves David paused personally, and a personal
    // pause outlives the role one — which is correct, and would otherwise make this test look
    // like the role resume had failed.
    await post('/resume', { user: 'role:admin' }, asUser('u-david', 'David'));
    await post('/resume', {}, asUser('u-david', 'David'));
    const res = await post('/pause', { preset: 'hour', scope: 'admins' }, asUser('u-david', 'David'));
    assert.equal(res.status, 200);
    assert.equal(res.json.user, 'role:admin');

    assert.equal(await injectedFor('david-token'), null, 'an admin is untrimmed');
    const kiosk = await injectedFor('kiosk-token');
    assert.ok(Array.isArray(kiosk) && kiosk.length, 'a non-admin panel keeps its allowlist');

    await post('/resume', { user: 'role:admin' }, asUser('u-david', 'David'));
    const back = await injectedFor('david-token');
    assert.ok(Array.isArray(back) && back.length, 'and it goes back afterwards');
  });

  it('puts the trim back when the pause is ended early', async () => {
    // Sets up its own pause rather than inheriting one from the test above: state that leaks
    // between tests makes whichever one runs second lie about what it is checking.
    await post('/pause', { preset: 'hour' }, asUser('u-david', 'David'));
    const res = await post('/resume', {}, asUser('u-david', 'David'));
    assert.equal(res.status, 200);
    assert.equal(res.json.wasPaused, true);
    const ids = await injectedFor('david-token');
    assert.ok(Array.isArray(ids) && ids.length, 'trimming resumes without waiting for the expiry');
  });

  it('survives a restart mid-pause, because a forgotten pause is worse than a remembered one', async () => {
    await post('/pause', { preset: 'hour' }, asUser('u-david', 'David'));
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'pauses.json'), 'utf8'));
    assert.ok(onDisk.pauses['u-david'].until > Date.now());
    const back = readPauses(dataDir);
    assert.ok(pausedUntil(back, 'u-david'), 'and it is still live when read back');
    await post('/resume', {}, asUser('u-david', 'David'));
  });
});
