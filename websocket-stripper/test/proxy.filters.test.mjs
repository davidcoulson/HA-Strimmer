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
  const waitForLog = (re, ms = 8000) => new Promise((resolve, reject) => {
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
    await proxy.waitForLog(/union allowlist for/);
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
    await proxy.waitForLog(/union allowlist for/);
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
    await proxy.waitForLog(/union allowlist for/);
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

describe('#9 the X-Forwarded-For chain survives an upstream proxy', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  const get = (headers) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/x', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.headers['x-echo-xff']));
    });
    req.on('error', reject);
  });

  it('appends our hop instead of replacing the chain', async () => {
    // What Caddy would send. Flattening this to one entry is what produced HA's 400,
    // because http-proxy still appends a second entry to X-Forwarded-Proto.
    const xff = await get({ 'x-forwarded-for': '203.0.113.7' });
    const parts = xff.split(',').map((s) => s.trim());
    assert.equal(parts[0], '203.0.113.7', `real client IP preserved, got "${xff}"`);
    assert.equal(parts.length, 2, `chain kept both hops, got "${xff}"`);
  });

  it('still normalizes IPv4-mapped IPv6 to bare IPv4', async () => {
    const xff = await get({ 'x-forwarded-for': '::ffff:192.168.5.247' });
    assert.match(xff, /(^|[\s,])192\.168\.5\.247([\s,]|$)/, `mapped prefix stripped, got "${xff}"`);
    assert.doesNotMatch(xff, /::ffff:/);
  });

  it('a direct client still yields a single entry', async () => {
    const xff = await get({});
    assert.equal(xff.split(',').length, 1, `got "${xff}"`);
    assert.doesNotMatch(xff, /::ffff:/);
  });
});
