// End-to-end coverage for the 0.2.3 fixes, driven through a real proxy process:
//   #10 regex auto-entities filters reach the allowlist
//   #4  template filters are rendered through HA; group members come along
//   #7  a grown allowlist reaches already-open pages without a manual reload
//   #9  the X-Forwarded-For chain survives an upstream proxy

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';
import { DASH_REGEX, DASH_TEMPLATE, DASH_GROUP, DASH_TEST } from './fixtures.mjs';

// Readiness is "the control connection has SUBSCRIBED", not "the allowlist is built".
//
// Those are different moments, and the proxy logs them in that order — the allowlist line comes
// FIRST, then `watching ... for live allowlist updates`. A test that waited on the allowlist and
// then fired a mock event could land it before subscribe_events had been processed, and the
// proxy would simply never see it: no recompute, no log line, a timeout blamed on duration.
// Measured at roughly one run in six before this changed, and raising the timeout could never
// have fixed it.
//
// Strictly stronger than the old wait, since the allowlist is already built by the time this
// line is written — so it is safe everywhere, not just in the suites that fire events.
const READY = /for live allowlist updates/;

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// statsPort defaults to 0 so the OS picks a free one. Without it every spawned proxy
// defaults to 8100, and two test files running in parallel fight over it — the loser then
// fails for a reason unrelated to what it is testing.
function spawnProxy({ mock, dashPaths, port, statsPort = 0, extraEnv = {} }) {
  const proc = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env, HA_BASE: mock.base, HA_TOKEN: 'test-token',
      DASH_PATHS: dashPaths, PORT: String(port), STATS_PORT: String(statsPort),
      SUPERVISOR_TOKEN: '', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const listeners = [];
  const onData = (b) => {
    out += b.toString();
    for (let i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i].re.test(out)) { listeners[i].resolve(out); listeners.splice(i, 1); }
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  // 25s, not 8s. These wait on a freshly spawned proxy reaching a log line, and the suite runs
  // its files in PARALLEL — a dozen node processes booting at once on a loaded machine pushed
  // two of these past 8s and failed a green build twice. The number is not a performance
  // budget: nothing here is measuring boot time, so a generous ceiling costs nothing while a
  // genuine hang still fails, just later.
  const waitForLog = (re, ms = 25000) => new Promise((resolve, reject) => {
    if (re.test(out)) return resolve(out);
    const l = { re, resolve: (v) => { clearTimeout(t); resolve(v); } };
    listeners.push(l);
    const t = setTimeout(() => {
      const i = listeners.indexOf(l);
      if (i >= 0) { listeners.splice(i, 1); reject(new Error(`timeout waiting for ${re}\n--- proxy output ---\n${out}`)); }
    }, ms);
  });
  return { proc, get out() { return out; }, waitForLog, kill: () => proc.kill() };
}

// Ask for the trimmed state list the way the frontend does.
async function allowlistViaProxy(port) {
  const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
  await c.authed;
  const res = await c.rpc({ type: 'get_states' });
  c.close();
  return new Set(res.result.map((e) => e.entity_id));
}

describe('regex, template and group filters reach the allowlist', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa({
      configs: { 'regex-dash': DASH_REGEX, 'tpl-dash': DASH_TEMPLATE, 'group-dash': DASH_GROUP },
    });
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'regex-dash,tpl-dash,group-dash', port });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('#10 resolves an anchored regex entity_id filter', async () => {
    const allow = await allowlistViaProxy(port);
    assert.ok(allow.has('sensor.pv_roof_power'), 'pv_roof_power allowlisted');
    assert.ok(allow.has('sensor.pv_shed_power'), 'pv_shed_power allowlisted');
  });

  it('#4 renders template filters through HA and keeps the ids', async () => {
    assert.ok(mock.renderedTemplates().includes('PV_TEMPLATE'),
      `proxy never asked HA to render the template: ${JSON.stringify(mock.renderedTemplates())}`);
    const allow = await allowlistViaProxy(port);
    assert.ok(allow.has('sensor.pv_roof_power'), 'entity from the rendered template is allowlisted');
  });

  it('#4 releases the render_template subscription instead of leaking it', async () => {
    // render_template is a subscription that re-fires forever; we want one snapshot.
    assert.ok(mock.unsubscribed().length > 0, 'proxy unsubscribed from the template');
  });

  it('#4 pulls in group members that appear nowhere in the config', async () => {
    const allow = await allowlistViaProxy(port);
    assert.ok(allow.has('cover.shade_group'), 'the group itself');
    assert.ok(allow.has('cover.shade_left'), 'member not named anywhere in the dashboard');
    assert.ok(allow.has('cover.shade_right'), 'member not named anywhere in the dashboard');
  });

  it('still trims — the decoys never make it through', async () => {
    const allow = await allowlistViaProxy(port);
    assert.equal(allow.has('light.decoy'), false);
    assert.equal(allow.has('sensor.decoy_power'), false);
  });
});

describe('a template that never renders does not break the build', () => {
  let mock, proxy, port;
  after(async () => { proxy?.kill(); await mock?.close(); });

  it('falls back to the rest of the dashboard instead of failing', async () => {
    // An unknown template makes HA answer `result: success=false` — the proxy must carry on.
    mock = await startMockHa({ configs: { 'tpl-dash': DASH_TEMPLATE, 'test-dash': DASH_TEST }, templates: {} });
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'tpl-dash,test-dash', port });
    await proxy.waitForLog(READY);
    const allow = await allowlistViaProxy(port);
    // test-dash still resolved in full despite tpl-dash's template failing.
    assert.ok(allow.has('light.living_room'));
    assert.ok(allow.has('switch.fan'));
    assert.equal(proxy.proc.exitCode, null, 'proxy stayed up');
  });
});

describe('#7 a grown allowlist reaches already-open pages', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa({ configs: { 'test-dash': DASH_TEST } });
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('drops open connections on growth so the frontend re-subscribes', async () => {
    const browser = new WebSocket(`ws://127.0.0.1:${port}/api/websocket`);
    browser.on('error', () => {});
    const closed = new Promise((res) => browser.on('close', res));
    await new Promise((res) => browser.on('open', res));
    browser.send(JSON.stringify({ type: 'auth', access_token: 'x' }));
    await delay(200);
    browser.send(JSON.stringify({ id: 1, type: 'subscribe_entities' }));
    await delay(200);
    const before = new Set(mock.lastSubscribeEntities());
    assert.equal(before.has('light.bedroom'), false, 'not allowlisted yet');

    // Edit the dashboard to add an entity -> allowlist grows.
    mock.setConfig('test-dash', {
      views: [{ path: 'main', cards: [
        { type: 'entities', entities: ['light.living_room', 'sensor.temperature', 'light.bedroom'] },
      ] }],
    });
    mock.fireLovelaceUpdated('test-dash');
    await proxy.waitForLog(/reconnecting 1 open dashboard connection/, 10000);

    // The open socket is dropped; a real frontend reconnects here on its own.
    await closed;
    const after = await allowlistViaProxy(port);
    assert.ok(after.has('light.bedroom'), 'the reconnected client sees the new entity');
  });

  it('does not churn connections when nothing was added', async () => {
    const browser = new WebSocket(`ws://127.0.0.1:${port}/api/websocket`);
    browser.on('error', () => {});
    await new Promise((res) => browser.on('open', res));
    const marker = proxy.out.length;
    mock.fireLovelaceUpdated('test-dash');           // same config -> no growth
    await delay(2500);
    assert.doesNotMatch(proxy.out.slice(marker), /reconnecting \d+ open dashboard/);
    assert.equal(browser.readyState, WebSocket.OPEN, 'connection left alone');
    browser.close();
  });
});

// Registry CHANGE events were filtered by nothing per connection. registryEventMatters gates
// only the control connection's rebuild decision, and the egress filter covered
// subscribe_entities alone — so a panel subscribed here got a change event for every entity on
// the instance, measured at 91,873 bytes per frame and 14.3% of all websocket traffic.
//
// The browser holds no registry row for an entity outside its allowlist, because the registry it
// was served was already trimmed, so the update has nothing to apply to.
describe('registry change events are filtered to the allowlist', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('forwards a change for an entity the dashboard shows, drops one it cannot see', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const id = c.send({ type: 'subscribe_events', event_type: 'entity_registry_updated' });
    await delay(300);

    // Listen on the RAW socket. An earlier draft used a `c.onMessage?.()` that does not exist,
    // so optional chaining silently no-opped, `seen` stayed empty and the assertion below passed
    // no matter what the proxy did — verified by deleting the filter and watching it still pass.
    const seen = [];
    c.ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        for (const x of (Array.isArray(m) ? m : [m])) {
          if (x?.type === 'event' && x.id === id) seen.push(x.event?.data?.entity_id);
        }
      } catch { /* non-JSON frames are not this test's business */ }
    });
    const got = c.waitFor((m) => m.type === 'event' && m.id === id
      && m.event?.data?.entity_id === 'light.living_room');

    // The decoy is not on any dashboard; the light is. Fired decoy FIRST, so if it were
    // forwarded it would arrive before the one being waited on.
    mock.fireEvent('entity_registry_updated', { action: 'update', entity_id: 'light.decoy' });
    mock.fireEvent('entity_registry_updated', { action: 'update', entity_id: 'light.living_room' });

    const ev = await got;
    assert.equal(ev.event.data.entity_id, 'light.living_room',
      'the allowlisted entity must arrive');
    assert.ok(!seen.includes('light.decoy'),
      'a registry change for an entity this connection cannot see must be dropped');
    c.close();
  });
});

describe('#9 the X-Forwarded-For chain survives an upstream proxy', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  const get = (headers) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/x', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ xff: res.headers['x-echo-xff'], proto: res.headers['x-echo-xfproto'] }));
    });
    req.on('error', reject);
  });

  it('keeps the real client IP at the head of the chain', async () => {
    // Whatever the proxy library does with hops, the first entry must remain the browser. HA
    // walks the chain from the right and takes the first untrusted entry as the client; lose
    // the head and trusted_networks matches the wrong machine.
    const { xff } = await get({ 'x-forwarded-for': '203.0.113.7' });
    const parts = xff.split(',').map((s) => s.trim());
    assert.equal(parts[0], '203.0.113.7', `real client IP preserved, got "${xff}"`);
  });

  it('keeps the For and Proto chains the same length, which is what HA enforces', async () => {
    // This is the actual #9 invariant, and it is worth stating as the invariant rather than as
    // "our hop is appended". The original bug was NOT that a hop went missing — it was that
    // X-Forwarded-For got flattened to one entry while X-Forwarded-Proto still carried two, and
    // HA rejects that mismatch with `Incorrect number of elements in X-Forward-Proto`.
    //
    // Appending to both is one way to satisfy it; appending to neither is another. Asserting the
    // invariant rather than the mechanism means this test keeps its meaning if the proxy library
    // underneath ever changes — which is exactly what happened when it did.
    const { xff, proto } = await get({
      'x-forwarded-for': '203.0.113.7',
      'x-forwarded-proto': 'https',
    });
    const n = (h) => String(h || '').split(',').filter((s) => s.trim()).length;
    assert.ok(n(proto) === 1 || n(proto) === n(xff),
      `For has ${n(xff)} entries and Proto has ${n(proto)} — HA answers 400 on a mismatch `
      + `(for="${xff}" proto="${proto}")`);
  });

  it('still normalizes IPv4-mapped IPv6 to bare IPv4', async () => {
    const { xff } = await get({ 'x-forwarded-for': '::ffff:192.168.5.247' });
    assert.match(xff, /(^|[\s,])192\.168\.5\.247([\s,]|$)/, `mapped prefix stripped, got "${xff}"`);
    assert.doesNotMatch(xff, /::ffff:/);
  });

  it('a direct client still yields a single entry', async () => {
    // No upstream proxy: the add-on itself must supply the client address, or HA sees nothing
    // and trusted_networks cannot match at all.
    const { xff } = await get({});
    assert.equal(xff.split(',').length, 1, `got "${xff}"`);
    assert.doesNotMatch(xff, /::ffff:/);
  });
});
