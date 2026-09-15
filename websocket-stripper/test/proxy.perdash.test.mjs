// Per-dashboard allowlists + registry trimming.
//
// The union is what every connection used to get. These tests pin the two properties that
// make per-dashboard trimming safe to leave on by default:
//   1. a client that asked for dashboard A gets A's entities — NOT the union;
//   2. a client we can't attribute still gets the union, so nothing renders worse than before.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { WebSocket as WS } from 'ws';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';

// How many resources the mock serves. Derived, not hard-coded: two tests assert "nothing
// was removed", and a literal count made adding a fixture resource look like a regression.
const TOTAL_RESOURCES = 7;

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

// statsPort defaults to 0 so the OS picks a free one. Without it every spawned proxy
// defaults to 8100, and two test files running in parallel fight over it — the loser then
// fails for a reason unrelated to what it is testing.
function spawnProxy({ mock, dashPaths, port, statsPort = 0, extraEnv = {} }) {
  const proc = spawn(process.execPath, [PROXY], {
    cwd: path.join(DIR, '..'),
    env: {
      ...process.env,
      HA_BASE: mock.base,
      HA_TOKEN: 'test-token',
      DASH_PATHS: dashPaths,
      PORT: String(port), STATS_PORT: String(statsPort),
      STRIP_ENTITIES: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const listeners = [];
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  function onData(b) {
    out += b.toString();
    for (let i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i].re.test(out)) { listeners[i].resolve(out); listeners.splice(i, 1); }
    }
  }
  const waitForLog = (re, ms = 8000) => new Promise((resolve, reject) => {
    if (re.test(out)) return resolve(out);
    const l = { re, resolve: (v) => { clearTimeout(t); resolve(v); } };
    listeners.push(l);
    const t = setTimeout(() => {
      const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1);
      reject(new Error(`timeout waiting for ${re}\n--- proxy output ---\n${out}`));
    }, ms);
  });
  return { proc, get out() { return out; }, waitForLog, kill: () => proc.kill() };
}

const httpGet = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    let body = ''; res.on('data', (c) => body += c);
    res.on('end', () => resolve({ status: res.statusCode, body, setCookie: res.headers['set-cookie'] }));
  });
  req.on('error', reject);
});

// Ask for entity_ids the proxy injected for a connection opened after `pageUrl` was fetched
// (or with no page fetch at all, when pageUrl is null).
async function injectedFor(port, mock, pageUrl) {
  if (pageUrl) await httpGet(`http://127.0.0.1:${port}${pageUrl}`);
  // Snapshot BEFORE the socket opens, so the wait below cannot be satisfied by a
  // subscription that was already in flight from an earlier test.
  const seq = mock.subscribeEntitiesSeq();
  const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
  await c.authed;
  c.send({ type: 'subscribe_entities' });
  const got = await mock.waitForSubscribeEntities(seq);
  c.close();
  return new Set(got ?? []);
}

describe('per-dashboard allowlists', () => {
  let mock, proxy, port;
  // test-dash names 6 ids; auto-dash resolves a label filter to living_room + bedroom.
  const TEST_DASH = ['light.living_room', 'sensor.temperature', 'camera.front', 'binary_sensor.front_door', 'sensor.humidity', 'switch.fan'];

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash,auto-dash', port });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('serves one dashboard its OWN entities, not the union', async () => {
    const got = await injectedFor(port, mock, '/test-dash');
    assert.deepEqual(got, new Set(TEST_DASH));
    // light.bedroom belongs only to auto-dash — the whole point is that it is NOT sent here.
    assert.ok(!got.has('light.bedroom'), 'union-only entity must not leak into a single dashboard');
  });

  it('serves a different dashboard a different set from the same proxy', async () => {
    const got = await injectedFor(port, mock, '/auto-dash');
    assert.ok(got.has('light.bedroom'), 'auto-dash resolves its own label filter');
    assert.ok(!got.has('camera.front'), 'test-dash-only entity must not leak into auto-dash');
  });

  it('a view path under the dashboard still attributes to that dashboard', async () => {
    const got = await injectedFor(port, mock, '/test-dash/some-view');
    assert.deepEqual(got, new Set(TEST_DASH));
  });

  it('never injects an empty entity_ids (which HA reads as "no filter")', async () => {
    // An unknown path leaves the previous hint in place, which is deliberate — the point
    // here is only that we never end up injecting nothing.
    const got = await injectedFor(port, mock, '/not-a-dashboard');
    assert.ok(got.size > 0, 'an unknown path must never produce an empty entity_ids');
  });
});

// Deliberately its own proxy: the IP->dashboard hint is sticky by design, so a connection
// that has never fetched a dashboard page only exists on a freshly started proxy.
// The IP hint is shared by every device behind one NAT, so a phone and a laptop on the
// same WAN address overwrite each other. A cookie is per-browser, which is the granularity
// actually wanted — and it is what makes remote access through a tunnel work, where every
// client arrives from one address.
describe('User-Agent attribution fallback', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({
      mock, dashPaths: 'test-dash,auto-dash', port,
      extraEnv: { UA_DASHBOARDS: JSON.stringify([
        { match: 'io.robbie.HomeAssistant', dashboard: 'auto-dash' },
      ]) },
    });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  const injectedWithUA = async (ua, pageUrl = null) => {
    if (pageUrl) await httpGet(`http://127.0.0.1:${port}${pageUrl}`);
    const seq = mock.subscribeEntitiesSeq();
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, 'test-token',
      ua ? { 'user-agent': ua } : undefined);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    const got = await mock.waitForSubscribeEntities(seq);
    c.close();
    return new Set(got ?? []);
  };

  // The companion app's native connection never fetches a dashboard page, so it has no cookie
  // and no IP hint and would otherwise be served the union of every dashboard.
  it('attributes a companion-app connection that has no other signal', async () => {
    const app = await injectedWithUA('Home Assistant/2026.9.1 (io.robbie.HomeAssistant; iOS 27.0.0)');
    assert.ok(app.has('light.bedroom'), 'got auto-dash, the dashboard named for this UA');
    assert.ok(!app.has('sensor.humidity'), 'and NOT the union, which would include test-dash');
  });

  // Before the next test, which fetches a page: an IP hint lives for ten minutes, so a client
  // that ran after it would be attributed and never exercise the union at all.
  it('leaves an unrecognised client on the union', async () => {
    const other = await injectedWithUA('Mozilla/5.0 (X11; Linux x86_64) Firefox/141.0');
    assert.ok(other.has('sensor.humidity'), 'union covers every dashboard');
    assert.ok(other.has('light.bedroom'));
  });

  it('never overrides a real signal', async () => {
    // Same app UA, but this client did load a dashboard page: the page wins.
    const real = await injectedWithUA(
      'Home Assistant/2026.9.1 (io.robbie.HomeAssistant; iOS 27.0.0)', '/test-dash/main');
    assert.ok(real.has('sensor.humidity'), 'the page GET decides, not the User-Agent');
  });

});

describe('per-user always_forward', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({
      mock, dashPaths: 'test-dash,auto-dash', port,
      // The case per-dashboard rules cannot express: two people, one dashboard, different
      // entities. David gets the decoys; Michelle opens the very same dashboard and does not.
      extraEnv: { USER_OVERRIDES: JSON.stringify([
        { user: 'David', dashboard: 'test-dash', always_forward: ['/^sensor\\.decoy_/'] },
      ]) },
    });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  const injectedForToken = async (token) => {
    await httpGet(`http://127.0.0.1:${port}/test-dash/main`);   // so the rule's dashboard scope matches
    const seq = mock.subscribeEntitiesSeq();
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, token);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    // The proxy HOLDS everything after `auth` until the user is resolved, which means a
    // fresh websocket to HA on the first lookup for a token. That took a fixed 1200ms sleep,
    // which passed alone and lost the race whenever the suite ran the spawn-heavy files
    // concurrently — reading the previous test's entity set and asserting on it.
    const got = await mock.waitForSubscribeEntities(seq);
    c.close();
    return new Set(got ?? []);
  };

  it('widens the allowlist for the matching user', async () => {
    const david = await injectedForToken('david-token');
    assert.ok(david.has('sensor.decoy_power'), 'David gets his extra entities');
    assert.ok(david.has('light.living_room'), 'and still gets the dashboard itself');
  });

  it('leaves a different user on the same dashboard untouched', async () => {
    const michelle = await injectedForToken('michelle-token');
    assert.ok(!michelle.has('sensor.decoy_power'), 'Michelle must not inherit David rules');
    assert.ok(michelle.has('light.living_room'), 'but still gets the dashboard itself');
  });

  it('honours a rule scoped to one dashboard', async () => {
    // David's rule is scoped to test-dash. On auto-dash he is still David, but the rule must
    // not follow him there — that is the whole point of scoping it.
    // Page GET FIRST: the websocket upgrade is what reads the attribution, so fetching the
    // page afterwards would leave this client on the previous test's hint.
    await httpGet(`http://127.0.0.1:${port}/auto-dash/main`);
    const seq = mock.subscribeEntitiesSeq();
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, 'david-token');
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    const got = new Set((await mock.waitForSubscribeEntities(seq)) ?? []);
    c.close();
    assert.ok(!got.has('sensor.decoy_power'), 'a test-dash rule must not apply on auto-dash');
  });

  it('applies no rules when the user is unknown', async () => {
    const other = await injectedForToken('some-other-token');
    assert.ok(!other.has('sensor.decoy_power'));
    assert.ok(other.has('light.living_room'));
  });
});

// REGRESSION, and the reason this needs its own proxy: the token cache. A user lookup happens
// once per token, so a delay only bites on a COLD cache — reusing the suite above would have
// tested nothing while looking like it tested everything.
//
// The bug: the proxy holds a connection's messages until the user is resolved, precisely so
// per-user rules can widen the allowlist before the frontend subscribes. But
// subscribe_entities was rewritten with the allowlist at the moment it was QUEUED and then
// flushed verbatim — so whenever the lookup was slower than the frontend's first subscribe,
// HA received the PRE-rules entity list and the rule was silently discarded. The gate kept
// ordering and lost content.
//
// Nothing logged a problem. The proxy still reported "user rules applied", because it had
// applied them — to an allowlist that was never sent. From outside, the rule simply worked on
// some connections and not others.
describe('per-user rules survive a slow user lookup', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({
      mock, dashPaths: 'test-dash,auto-dash', port,
      extraEnv: { USER_OVERRIDES: JSON.stringify([
        { user: 'David', dashboard: 'test-dash', always_forward: ['/^sensor\\.decoy_/'] },
      ]) },
    });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('stamps the allowlist when the message is sent, not when it is queued', async () => {
    // Make the lookup lose the race on purpose. Before the fix this fails every run; at the
    // mock's natural speed it passed most runs, which is how it survived this long.
    mock.setCurrentUserDelay(300);
    await httpGet(`http://127.0.0.1:${port}/test-dash/main`);
    const seq = mock.subscribeEntitiesSeq();
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, 'david-token');
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    const got = new Set((await mock.waitForSubscribeEntities(seq)) ?? []);
    c.close();
    assert.ok(got.has('sensor.decoy_power'),
      'the rule must reach the FIRST subscribe_entities, which is the only one that matters');
    assert.ok(got.has('light.living_room'), 'and the dashboard itself is still there');
  });
});

describe('per-dashboard always_forward', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({
      mock, dashPaths: 'test-dash,auto-dash', port,
      // Only test-dash may see the decoys. group-dash must not pay for them — that is the
      // entire reason this option exists: a global always_forward puts the cost on every
      // panel, which on a real instance meant 252 update entities landing on a wall panel
      // that shows four lights.
      extraEnv: { DASHBOARD_OVERRIDES: JSON.stringify([
        { dashboard: 'test-dash', always_forward: ['/^sensor\\.decoy_/'] },
      ]) },
    });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  // FIRST in this block on purpose: the IP hint set by a page GET lives for ten minutes, so a
  // test that fetched a dashboard page would leave this client attributed and never see the
  // union at all.
  it('still includes them in the union, so an unattributed client is never short', async () => {
    const union = await injectedFor(port, mock, null);
    assert.ok(union.has('sensor.decoy_power'), 'union covers whatever dashboard it might be');
    assert.ok(union.has('light.bedroom'), 'and still covers the other dashboard');
  });

  it('adds the entities to the named dashboard only', async () => {
    const named = await injectedFor(port, mock, '/test-dash/main');
    assert.ok(named.has('sensor.decoy_power'), 'the named dashboard gets the override');
    assert.ok(named.has('sensor.decoy_energy'));
  });

  it('leaves every other dashboard untouched', async () => {
    const other = await injectedFor(port, mock, '/auto-dash/main');
    assert.ok(!other.has('sensor.decoy_power'), 'another dashboard must not pay for it');
    assert.ok(!other.has('sensor.decoy_energy'));
    assert.ok(other.has('light.bedroom'), 'but still gets its own entities');
  });

});

describe('cookie attribution survives a shared IP', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash,auto-dash', port });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  // Same process, so the same source IP for both — exactly the NAT case.
  const withCookie = async (dash) => {
    const seq = mock.subscribeEntitiesSeq();
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, 'test-token', dash ? { Cookie: `ws_dash=${dash}` } : undefined);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    const got = await mock.waitForSubscribeEntities(seq);
    c.close();
    return new Set(got ?? []);
  };

  it('a dashboard page GET sets the cookie', async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/test-dash`);
    assert.match(String(res.setCookie ?? ''), /ws_dash=test-dash/,
      'the page response must stamp the dashboard on the browser');
  });

  it('two clients on the SAME ip get different allowlists from their cookies', async () => {
    const a = await withCookie('test-dash');
    const b = await withCookie('auto-dash');
    assert.ok(a.has('camera.front'), 'test-dash cookie gets test-dash entities');
    assert.ok(!a.has('light.bedroom'), 'and not the other dashboard\'s');
    assert.ok(b.has('light.bedroom'), 'auto-dash cookie gets auto-dash entities');
    assert.ok(!b.has('camera.front'), 'and not the other dashboard\'s');
  });

  it('the cookie wins over a conflicting IP hint', async () => {
    await httpGet(`http://127.0.0.1:${port}/auto-dash`);   // IP hint now says auto-dash
    const got = await withCookie('test-dash');             // cookie says test-dash
    assert.ok(got.has('camera.front') && !got.has('light.bedroom'),
      'the per-browser signal must beat the per-IP one');
  });

  it('an unknown cookie value falls back rather than serving nothing', async () => {
    const got = await withCookie('not-a-dashboard');
    assert.ok(got.size > 0, 'an empty entity_ids would mean NO filter to HA');
  });
});

describe('an unattributed client still gets the union', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash,auto-dash', port });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('falls back to the union, never to a partial list', async () => {
    const got = await injectedFor(port, mock, null);
    assert.ok(got.has('light.bedroom') && got.has('camera.front'),
      'an unattributed connection must get the full union — the pre-feature behaviour');
  });
});

describe('per_dashboard=0 restores the union for every connection', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash,auto-dash', port, extraEnv: { PER_DASHBOARD: '0' } });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('ignores the page hint and serves the union', async () => {
    const got = await injectedFor(port, mock, '/test-dash');
    assert.ok(got.has('light.bedroom'), 'with the feature off, test-dash still gets the union');
  });
});

// HA's own websocket negotiates permessage-deflate. `ws` does not enable it server-side by
// default, so inserting this proxy silently dropped compression from the browser leg.
describe('websocket compression', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  const negotiated = (url) => new Promise((resolve) => {
    const ws = new WS(url, { perMessageDeflate: true });
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
    ws.on('upgrade', (r) => finish(r.headers['sec-websocket-extensions'] || ''));
    ws.on('error', () => finish(''));
    setTimeout(() => finish(''), 5000);
  });

  it('offers permessage-deflate to the browser, as HA itself does', async () => {
    assert.match(await negotiated(`ws://127.0.0.1:${port}/api/websocket`), /permessage-deflate/);
  });

  it('compress_websocket=0 turns it off', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'test-dash', port: p2, extraEnv: { COMPRESS_WS: '0' } });
    await px.waitForLog(READY);
    const ext = await negotiated(`ws://127.0.0.1:${p2}/api/websocket`);
    px.kill();
    assert.doesNotMatch(ext, /permessage-deflate/);
  });
});

// Lovelace resources are instance-wide in HA, so every kiosk parses every custom card in the
// install — the largest remaining cost once states and registries are trimmed.
// repairs/list_issues is ~27KB on every page load and a kiosk never renders it. Lossy in one
// direction though — an admin on a trimmed dashboard stops seeing repair notices — so it is off
// by default, and both halves of that are pinned here.
// The largest untrimmed payload in a page load, and the most dangerous to trim: a missing
// translation renders its raw key ON the dashboard rather than degrading quietly.
describe('translation trimming', () => {
  const resources = async (extraEnv) => {
    const m2 = await startMockHa();
    const port = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'test-dash', port, extraEnv });
    try {
      await px.waitForLog(READY);
      const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
      await c.authed;
      const r = (await c.rpc({ type: 'frontend/get_translations', language: 'en' })).result;
      c.close();
      return r.resources;
    } finally { px.kill(); await m2.close(); }
  };

  it('keeps entity domains AND the integrations providing them, drops the rest', async () => {
    const r = await resources({ TRIM_TRANSLATIONS: '1' });
    assert.ok(r['component.light.entity_component._.state.on'], 'an entity domain in view is kept');
    // The subtle half: hue provides light.living_room, and its state names live under the
    // INTEGRATION. Filtering on entity domains alone would drop this and show raw keys.
    assert.ok(r['component.hue.entity.light.x.state.on'],
      'the integration providing a visible entity must be kept');
    assert.ok(!r['component.tuya_local.entity.sensor.y.state.z'],
      'an integration no dashboard can see is dropped');
    assert.ok(!r['component.roborock.entity.vacuum.v.state.w'], 'likewise');
  });

  it('never drops a key that is not component-shaped', async () => {
    const r = await resources({ TRIM_TRANSLATIONS: '1' });
    assert.equal(r['ui.panel.lovelace.editor.save'], 'Save',
      'anything outside component.<x> must pass through untouched');
  });

  it('is off by default', async () => {
    const r = await resources({});
    assert.ok(r['component.tuya_local.entity.sensor.y.state.z'],
      'off by default — nothing is lost until asked for');
  });
});

// HA sends every installed theme to every client on every load. A panel renders one.
// The device and area registries were trimmed to the UNION allowlist while the entity registry
// used the per-connection one — so a panel showing one dashboard received every device and area
// reachable by every other dashboard too. Measured live: the device registry trimmed 87% against
// the entity registry's 99.3% on the same principle.
//
// The fixtures matter here. An earlier draft asserted on a device that no dashboard reached, so
// the union and per-connection answers were identical and the test passed with the fix removed.
// These two dashboards deliberately reach DIFFERENT devices: sensor.temperature -> dev_thermo,
// light.kitchen -> dev_kitchen_light.
describe('device and area registries are cut to the CONNECTION, not the union', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa({ configs: {
      'dash-thermo': { views: [{ cards: [{ type: 'entities', entities: ['sensor.temperature'] }] }] },
      'dash-kitchen': { views: [{ cards: [{ type: 'entities', entities: ['light.kitchen'] }] }] },
    } });
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'dash-thermo,dash-kitchen', port });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  const devicesFor = async (pageUrl) => {
    await httpGet(`http://127.0.0.1:${port}${pageUrl}`);
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: 'config/device_registry/list' })).result;
    c.close();
    return rows.map((r) => r.id);
  };

  it('a dashboard gets only the devices its own entities reach', async () => {
    const ids = await devicesFor('/dash-thermo');
    assert.ok(ids.includes('dev_thermo'), 'the device behind a visible entity must be kept');
    assert.ok(!ids.includes('dev_kitchen_light'),
      'a device reachable only through the OTHER dashboard must not be sent');
  });

  it('and the other dashboard gets its own, not the first one\'s', async () => {
    const ids = await devicesFor('/dash-kitchen');
    assert.ok(ids.includes('dev_kitchen_light'), 'its own device is kept');
    assert.ok(!ids.includes('dev_thermo'), 'and the other dashboard\'s is not');
  });
});

describe('theme trimming', () => {
  const themes = async (extraEnv, cfg) => {
    const m2 = await startMockHa(cfg ? { configs: { 'res-dash': cfg } } : undefined);
    const port = await getFreePort();
    const dash = cfg ? 'res-dash' : 'test-dash';
    const px = spawnProxy({ mock: m2, dashPaths: dash, port, extraEnv });
    try {
      await px.waitForLog(READY);
      const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
      await c.authed;
      const r = (await c.rpc({ type: 'frontend/get_themes' })).result;
      c.close();
      return r;
    } finally { px.kill(); await m2.close(); }
  };

  it('keeps the themes a dashboard names, plus the defaults HA reports', async () => {
    // This dashboard asks for `Frosted`; HA's default is `Mushroom`. Both must survive.
    const r = await themes({ TRIM_THEMES: '1' }, {
      views: [{ theme: 'Frosted', cards: [{ type: 'custom:my-fancy-card', entity: 'light.living_room' }] }],
    });
    assert.ok(r.themes.Frosted, 'the theme the dashboard names must be kept');
    assert.ok(r.themes.Mushroom, 'and the default HA reports, which no dashboard names');
    assert.ok(!r.themes.minimalist, 'a theme nothing references is dropped');
    assert.ok(!r.themes.iCloud3, 'likewise');
  });

  it('is off by default', async () => {
    const r = await themes({}, null);
    assert.equal(Object.keys(r.themes).length, 4, 'nothing is lost until asked for');
  });
});

describe('repairs trimming', () => {
  const issues = async (p2, extraEnv) => {
    const m2 = await startMockHa();
    const port = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'test-dash', port, extraEnv });
    try {
      await px.waitForLog(READY);
      const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
      await c.authed;
      const r = (await c.rpc({ type: 'repairs/list_issues' })).result;
      c.close();
      return r;
    } finally { px.kill(); await m2.close(); }
  };

  it('empties the issue list when trim_repairs is on', async () => {
    const r = await issues(null, { TRIM_REPAIRS: '1' });
    assert.deepEqual(r.issues, [], 'a kiosk gets an empty backlog');
    // Emptied, NOT dropped: the frontend waits on this reply, so the shape must survive.
    assert.ok(r && typeof r === 'object' && 'issues' in r,
      'the result must still be a well-formed answer, or the request hangs forever');
  });

  it('leaves the backlog alone by default', async () => {
    const r = await issues(null, {});
    assert.equal(r.issues.length, 2, 'off by default — an admin must not silently lose repairs');
  });
});

describe('resource trimming', () => {
  let mock, proxy, port;
  // A dashboard whose only custom card is `custom:my-fancy-card`.
  const CFG = { views: [{ cards: [{ type: 'custom:my-fancy-card', entity: 'light.living_room' }] }] };

  before(async () => {
    mock = await startMockHa({ configs: { 'res-dash': CFG } });
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'res-dash', port, extraEnv: { TRIM_RESOURCES: '1' } });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  const resourcesFor = async (p, pageUrl) => {
    if (pageUrl) await httpGet(`http://127.0.0.1:${p}${pageUrl}`);
    const c = haClient(`ws://127.0.0.1:${p}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: 'lovelace/resources' })).result;
    c.close();
    return rows.map((r) => r.url);
  };

  it('keeps the resource providing a card the dashboard uses, drops the rest', async () => {
    const urls = await resourcesFor(port, '/res-dash');
    assert.ok(urls.includes('/res/my-fancy-card.js'), 'the card this dashboard renders must survive');
    assert.ok(!urls.includes('/res/unrelated-widget.js'), 'a card no view references must be dropped');
  });

  // Regression: a loose icon-prefix pattern turns `16:9` and `06:00` into the keys "16" and
// "06", and a 2-char string appears in every minified bundle — so everything matches and
  // nothing is dropped. That silently disabled the whole feature (39/45 kept, 97KB saved).
  it('is not fooled by aspect ratios and times into keeping everything', async () => {
    // The entity matters: with none, the allowlist is empty and the proxy rightly refuses the
    // websocket with 503, which fails this test for an unrelated reason.
    const cfg = { views: [{ cards: [
      { type: 'custom:my-fancy-card', entity: 'light.living_room', aspect_ratio: '16:9', schedule: '06:00' },
    ] }] };
    const m2 = await startMockHa({ configs: { 'ratio-dash': cfg } });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'ratio-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(READY);
      const urls = await resourcesFor(p2, '/ratio-dash');
      assert.ok(!urls.includes('/res/unrelated-widget.js'),
        'an aspect_ratio must not become a match-everything key');
    } finally {
      // finally, not trailing statements: a throw above otherwise leaks the proxy and mock,
      // and the open handles hang the whole test FILE rather than failing one test.
      px.kill(); await m2.close();
    }
  });

  it('resources_always_forward rescues a global plugin that registers no card', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1', RESOURCES_ALWAYS_FORWARD: 'global-patcher' } });
    await px.waitForLog(READY);
    const urls = await resourcesFor(p2, '/res-dash');
    px.kill();
    assert.ok(urls.includes('/res/global-patcher.js'), 'always_forward must win over the content match');
  });

  it('an unattributed connection still gets every resource', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    await px.waitForLog(READY);
    const urls = await resourcesFor(p2, null);   // no page GET -> no dashboard attribution
    px.kill();
    assert.equal(urls.length, TOTAL_RESOURCES, 'a connection we cannot attribute must not have resources removed');
  });

  // The one failure the documented tuning loop ("load it and see what looks wrong") cannot
  // catch: a resource that registers no element and is named by no dashboard, but runs on
  // load and subscribes to state. Dropping it leaves the dashboard pixel-identical and only
  // stops the behaviour, so the log has to say which resources those could be.
  it('names the resources dropped by EVERY dashboard, since those fail silently', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(/drop\s+\d+KB \/res\/global-patcher\.js/);
      const out = px.out;
      assert.match(out, /dropped by ALL dashboards \(no dashboard references them\)/);
      assert.match(out, /INVISIBLE/, 'the warning must say the failure is invisible');
      assert.match(out, /resources_always_forward/, 'and name the option that fixes it');
      assert.match(out, /\/res\/global-patcher\.js/, 'and list the offending resource');
    } finally { px.kill(); }
  });

  // A 3-character icon namespace matched as a bare substring kept 4.8MB of bundles that
  // merely contained those letters in base64 blobs and minified identifiers. An icon
  // reference always carries its colon, so that is what gets matched.
  it('matches an icon namespace with its colon, not as a bare substring', async () => {
    const cfg = { views: [{ cards: [{ type: 'tile', entity: 'light.living_room', icon: 'cbi:bulb' }] }] };
    const m2 = await startMockHa({ configs: { 'icon-dash': cfg } });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'icon-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(READY);
      const urls = await resourcesFor(p2, '/icon-dash');
      assert.ok(urls.some((u) => u.includes('icon-pack')), 'a body containing "cbi:" must be kept');
      assert.ok(!urls.some((u) => u.includes('cbi-lookalike')),
        'a body containing only the bare letters "cbi" must NOT be kept');
      // The pack that SERVES the namespace registers it as a key and never writes `cbi:`.
      assert.ok(urls.some((u) => u.includes('provider')),
        'the provider registering customIconsets["cbi"] must be kept');
    } finally { px.kill(); await m2.close(); }
  });

  // Big bundles build their element names at runtime: ha-bambulab-cards.js is 3.2MB and the
  // string `ha-bambulab-print_status-card` appears nowhere in it, only `bambulab` and
  // `print_status` separately. Requiring every fragment keeps that specific.
  it('matches a card whose element name is built at runtime, via its fragments', async () => {
    const cfg = { views: [{ cards: [{ type: 'custom:ha-bambulab-print_status-card', entity: 'light.living_room' }] }] };
    const m2 = await startMockHa({ configs: { 'bambu-dash': cfg } });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'bambu-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(READY);
      const urls = await resourcesFor(p2, '/bambu-dash');
      assert.ok(urls.some((u) => u.includes('bambulab-print_status-cards')),
        'all fragments present must count as a match');
      assert.ok(!urls.some((u) => u.includes('unrelated-widget')),
        'a bundle sharing no fragment must still be dropped');
    } finally { px.kill(); await m2.close(); }
  });

  // Reported by the lovelace-navbar-card author. A HACS update rewrote one resource's
  // cache-busting query string — `?hacstag=...62` to `...63` — and the card vanished from every
  // dashboard: no console error, no network request, an error card with empty text. The path
  // never moved and the file never moved; only the query did.
  //
  // The keep-set was built from the FULL url, so a changed query matched nothing and the
  // resource was dropped. Not specific to that card either: every HACS update of any installed
  // module was queued up behind the same bug.
  //
  // Its OWN mock and proxy, because it mutates a resource URL and must not leak that into the
  // tests above. The URL is bumped WITHOUT a rebuild, deliberately — not being told is exactly
  // what happens in the real failure.
  it('survives a HACS cache-buster change without a rebuild (query string is not identity)', async () => {
    const m2 = await startMockHa({ configs: { 'res-dash': CFG } });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'res-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(READY);
      const before = await resourcesFor(p2, '/res-dash');
      assert.ok(before.some((u) => u.startsWith('/res/my-fancy-card.js')),
        'baseline: the card resource is served before the bump');

      m2.bumpResourceQuery('my-fancy-card', '?hacstag=1361984262163');

      const after = await resourcesFor(p2, '/res-dash');
      const card = after.find((u) => u.startsWith('/res/my-fancy-card.js'));
      assert.ok(card, 'the resource must survive a query-string change it was never told about');
      // The query must reach the frontend verbatim — it is the browser's cache-buster, so
      // handing back the old one would serve a stale file.
      assert.equal(card, '/res/my-fancy-card.js?hacstag=1361984262163',
        'the new query string must be passed through untouched');
      assert.ok(!after.includes('/res/unrelated-widget.js'),
        'and trimming still works — this is not a test that everything is now forwarded');
    } finally { px.kill(); await m2.close(); }
  });

  // The navbar-card case, reduced: a card whose defining file is identifiable by name, and
  // which the trimmer dropped. This must be reported, because it is PROVEN broken — not guessed.
  it('reports a card whose only literal definer was dropped', async () => {
    const m2 = await startMockHa({
      // renders my-fancy-card; `resources_never_forward` then drops the one file that names it
      configs: { 'res-dash': CFG },
    });
    const p2 = await getFreePort();
    const sp = await getFreePort();
    const px = spawnProxy({
      mock: m2, dashPaths: 'res-dash', port: p2, statsPort: sp,
      extraEnv: { TRIM_RESOURCES: '1', RESOURCES_NEVER_FORWARD: 'my-fancy-card' },
    });
    try {
      await px.waitForLog(READY);
      const stats = JSON.parse((await httpGet(`http://127.0.0.1:${sp}/stats.json`)).body);
      const unmet = (stats.resources || {}).unmetByDashboard || {};
      assert.deepEqual(unmet['res-dash'], ['my-fancy-card'],
        'the card whose definer was dropped must be named');
    } finally { px.kill(); await m2.close(); }
  });

  // The other half, and the reason the previous attempt was withdrawn. Mushroom's fixture body
  // builds its element names at runtime — `customElements.define(`${P}-${t}-card`)` — so the
  // string `mushroom-cover-card` appears nowhere in the file. Real bundles do exactly this;
  // measured on a live install, mushroom.js and ha-bambulab-cards.js both do.
  //
  // Nothing can tell whether such a card will render, so nothing must be claimed. Reporting it
  // would be crying wolf, and a warning people learn to ignore is worse than no warning.
  it('stays silent about a card whose bundle builds its name at runtime', async () => {
    const m2 = await startMockHa({
      configs: { 'res-dash': { views: [{ cards: [
        { type: 'custom:mushroom-cover-card', entity: 'light.living_room' },
      ] }] } },
      resources: [{ id: 'm1', type: 'module', url: '/res/mushroom.js' }],
    });
    const p2 = await getFreePort();
    const sp = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'res-dash', port: p2, statsPort: sp,
      extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(READY);
      const stats = JSON.parse((await httpGet(`http://127.0.0.1:${sp}/stats.json`)).body);
      const res = stats.resources || {};
      assert.deepEqual(res.unmetByDashboard || {}, {},
        'a card that cannot be verified must not be reported as broken');
      // And the silence is declared rather than implied.
      assert.ok((res.unmetCoverage || {}).unknowable >= 1,
        'the unverifiable card must be counted, so the silence is legible');
    } finally { px.kill(); await m2.close(); }
  });

  it('trim_resources off (the default) leaves the list untouched', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2 });
    await px.waitForLog(READY);
    const urls = await resourcesFor(p2, '/res-dash');
    px.kill();
    assert.equal(urls.length, TOTAL_RESOURCES);
  });
});

// get_services carries every service of every integration and is sent on every page load —
// 193KB across 115 domains on the instance this was built against, where only 45 domains had
// any entity at all.
describe('resource matching: a bundle that never names its own cards', () => {
  let mock, proxy, port;
  before(async () => {
    // Its own mock: this needs a specific resource set, and mutating the shared fixtures
    // changes counts that other tests assert exactly.
    mock = await startMockHa({
      configs: { 'mush-dash': { views: [{ cards: [
        { type: 'custom:mushroom-cover-card', entity: 'cover.shade_left' },
      ] }] } },
      resources: [
        { id: 'm1', type: 'module', url: '/res/mushroom.js' },
        { id: 'm2', type: 'module', url: '/res/unrelated.js' },
      ],
      resourceBodies: {
        // Exactly how Mushroom ships: names built from template literals, so the string
        // "mushroom-cover-card" is absent, and so are the generic halves "cover" and "card".
        '/res/mushroom.js': 'const P="mushroom";for(const t of TYPES)customElements.define(`${P}-${t}-card`,C);',
        '/res/unrelated.js': 'export const widget = 1;',
      },
    });
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'mush-dash', port, extraEnv: { TRIM_RESOURCES: '1' } });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  // Regression: Mushroom builds element names from template literals, so "mushroom-cover-card"
  // appears nowhere in mushroom.js. The old matcher required every fragment to be present AND
  // two distinctive ones, which no `<oneword>-<generic>-card` name can satisfy — so it silently
  // dropped the whole Mushroom family and every card using it rendered as an error.
  it('keeps a bundle identified only by one rare fragment', async () => {
    await httpGet(`http://127.0.0.1:${port}/mush-dash`);
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const kept = (await c.rpc({ type: 'lovelace/resources' })).result.map((r) => r.url);
    c.close();
    assert.ok(kept.includes('/res/mushroom.js'),
      `mushroom.js must survive trimming; kept: ${JSON.stringify(kept)}`);
    assert.ok(!kept.includes('/res/unrelated.js'),
      `trimming should drop the unused bundle; kept=${JSON.stringify(kept)}`);
  });
});

describe('get_services trimming', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port, extraEnv: { TRIM_SERVICES: '1' } });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  const services = async (p) => {
    const c = haClient(`ws://127.0.0.1:${p}/api/websocket`);
    await c.authed;
    const r = (await c.rpc({ type: 'get_services' })).result;
    c.close();
    return r;
  };

  it('keeps the domains the connection can see and drops the rest', async () => {
    const r = await services(port);
    assert.ok(r.light, 'a domain this dashboard shows must survive');
    assert.ok(!r.vacuum, 'a domain with no entity on any dashboard must be dropped');
    assert.ok(!r.lawn_mower, 'likewise');
  });

  it('always keeps homeassistant, whose services are domain-agnostic', async () => {
    const r = await services(port);
    assert.ok(r.homeassistant, 'turn_on/toggle/reload apply across domains — dropping them breaks more than it saves');
  });

  it('trim_services off (the default) leaves every domain', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'test-dash', port: p2 });
    try {
      await px.waitForLog(READY);
      const r = await services(p2);
      assert.ok(r.vacuum && r.lawn_mower, 'with the option off nothing is removed');
    } finally { px.kill(); }
  });
});

// get_services is instance-wide and sent on every page load, exactly like the registries
// beside it — but it was the one big payload still being rebuilt by HA and re-parsed here once
// per connection, while the registries were served from memory.
describe('get_services caching', () => {
  const ask = async (p) => {
    const c = haClient(`ws://127.0.0.1:${p}/api/websocket`);
    await c.authed;
    const r = (await c.rpc({ type: 'get_services' })).result;
    c.close();
    return r;
  };

  // Its own proxy and mock, because "the first connection fetches it" is only observable on a
  // COLD cache — reuse a warm one and the test passes without proving anything.
  it('serves the second connection from cache without asking HA again', async () => {
    const m2 = await startMockHa();
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'test-dash', port: p2, extraEnv: { TRIM_SERVICES: '1' } });
    try {
      await px.waitForLog(READY);
      const before = m2.rpcCount('get_services');
      const first = await ask(p2);
      const mid = m2.rpcCount('get_services');
      const second = await ask(p2);
      const after = m2.rpcCount('get_services');

      assert.equal(mid - before, 1, 'the first connection must fetch it from HA');
      assert.equal(after - mid, 0, 'the second must not — that is the whole point');
      assert.deepEqual(second, first, 'and must still get an identical answer');
    } finally { px.kill(); await m2.close(); }
  });

  // A widened connection must never share an entry with a narrower one — it would read rows
  // missing its extra entities, and write rows that over-serve everyone else on that dashboard.
  //
  // The first implementation achieved that by making widened connections skip the cache. That
  // was correct and nearly useless: measured on a live instance, MOST connections are widened
  // (voice-satellite panels self-identify, the admin user matches a user rule) and the hit rate
  // fell from 97.9% to 9.1%. So the allowlist's signature is part of the KEY instead — a
  // widened connection still caches, just under its own identity, which it shares with its own
  // reconnects and with any other client holding the same set.
  //
  // This test therefore asserts the property that matters — a pinned client does NOT get the
  // unpinned entry — rather than the mechanism, which has already changed once.
  it('a widened connection caches under its own identity, never the narrow one', async () => {
    const m2 = await startMockHa();
    const p2 = await getFreePort();
    const px = spawnProxy({
      mock: m2, dashPaths: 'test-dash', port: p2,
      extraEnv: {
        TRIM_SERVICES: '1',
        // sensor.decoy_power exists on the instance and is on no dashboard, so this genuinely
        // widens the set rather than being a no-op the pinning check would ignore.
        CLIENT_OVERRIDES: JSON.stringify([
          { client: '127.0.0.1', devices: [], always_forward: ['sensor.decoy_power'] },
        ]),
      },
    });
    try {
      await px.waitForLog(READY);
      const before = m2.rpcCount('get_services');
      await ask(p2);
      const afterFirst = m2.rpcCount('get_services');
      await ask(p2);
      const afterSecond = m2.rpcCount('get_services');

      assert.equal(afterFirst - before, 1, 'the first widened connection still has to fetch');
      // The point of the rewrite: a widened client is not punished with a permanent miss. Its
      // second connection carries the same set, so it shares its own entry.
      assert.equal(afterSecond - afterFirst, 0,
        'a widened connection must reuse its OWN cached entry on reconnect');

      // And the widening is real: the pinned entity reaches this connection, which is what a
      // stale narrow cache would have silently withheld.
      const c = haClient(`ws://127.0.0.1:${p2}/api/websocket`);
      await c.authed;
      const ids = (await c.rpc({ type: 'get_states' })).result.map((e) => e.entity_id);
      c.close();
      assert.ok(ids.includes('sensor.decoy_power'), 'the client_overrides entity must be present');
    } finally { px.kill(); await m2.close(); }
  });

  // The property the signature key exists for, and the one every other test here misses: two
  // connections to the SAME proxy on the SAME dashboard holding DIFFERENT allowlists must not
  // share a cache entry.
  //
  // Every loopback client presents as 127.0.0.1, so a client_overrides pin cannot produce that
  // pair — it widens all of them or none. Two USERS can: David matches a user rule and gets the
  // decoys, Michelle opens the identical dashboard and does not. That is exactly the live shape
  // that caused this (an admin user matching a rule alongside unwidened wall panels).
  //
  // Without the signature in the key, whoever connects first wins and the other silently
  // inherits their registry.
  it('two users on one dashboard never share each other\'s cached registry', async () => {
    const m2 = await startMockHa();
    const p2 = await getFreePort();
    const px = spawnProxy({
      mock: m2, dashPaths: 'test-dash', port: p2,
      // light.kitchen, because it is in the entity REGISTRY fixture and on no dashboard. The
      // sensor.decoy_* entities exist only in STATES, so widening with those would leave both
      // users' registries identical and the test would pass without proving anything.
      extraEnv: { USER_OVERRIDES: JSON.stringify([
        { user: 'David', dashboard: 'test-dash', always_forward: ['light.kitchen'] },
      ]) },
    });
    try {
      await px.waitForLog(READY);
      const registryFor = async (token) => {
        // Needed for the rule's `dashboard: 'test-dash'` scope to match: without a page fetch
        // the connection is unattributed, dash is null, and no scoped user rule can apply.
        await httpGet(`http://127.0.0.1:${p2}/test-dash/main`);
        const c = haClient(`ws://127.0.0.1:${p2}/api/websocket`, token);
        await c.authed;
        const rows = (await c.rpc({ type: 'config/entity_registry/list' })).result;
        c.close();
        return new Set(rows.map((r) => r.entity_id));
      };

      // David first, so his (wider) answer is the one sitting in the cache when Michelle asks.
      const david = await registryFor('david-token');
      const michelle = await registryFor('michelle-token');

      assert.ok(david.has('light.kitchen'),
        'the user rule must actually widen David, or this test proves nothing');
      assert.ok(!michelle.has('light.kitchen'),
        'Michelle must NOT inherit David\'s cached registry rows');
    } finally { px.kill(); await m2.close(); }
  });
});

describe('registry trimming', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    await proxy.waitForLog(READY);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('cuts the entity registry to entities the connection can see', async () => {
    await httpGet(`http://127.0.0.1:${port}/test-dash`);
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: "config/entity_registry/list" })).result;
    c.close();
    assert.ok(Array.isArray(rows), 'registry came back as a list');
    const ids = new Set(rows.map((r) => r.entity_id));
    // test-dash uses living_room / temperature / fan; bedroom and kitchen belong to other
    // dashboards and must not survive.
    assert.ok(ids.has('light.living_room'), 'an entity this dashboard shows must survive');
    assert.ok(!ids.has('light.bedroom'), 'an entity from another dashboard must not survive');
    assert.ok(!ids.has('light.kitchen'), 'an entity no dashboard shows must not survive');
  });

  // The regression this pins: `list_for_display` answers with an OBJECT, so an
  // Array.isArray() guard on the result skipped it — and it is the single largest payload
  // the frontend fetches (1.44MB of a 2.46MB load on the instance this was built against).
  it('cuts list_for_display, which is an object and not a list', async () => {
    await httpGet(`http://127.0.0.1:${port}/test-dash`);
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const r = (await c.rpc({ type: 'config/entity_registry/list_for_display' })).result;
    c.close();
    assert.ok(r && !Array.isArray(r) && Array.isArray(r.entities), 'shape is {entity_categories, entities}');
    const ids = new Set(r.entities.map((e) => e.ei));      // rows key entity_id as `ei`
    assert.ok(ids.has('light.living_room'), 'an entity this dashboard shows must survive');
    assert.ok(!ids.has('light.bedroom'), 'an entity from another dashboard must not survive');
    assert.ok(!ids.has('light.kitchen'), 'an entity no dashboard shows must not survive');
    assert.deepEqual(r.entity_categories, { 0: 'config', 1: 'diagnostic' },
      'the category map is not per-entity and must be passed through intact');
  });

  // Registries are per-INSTANCE: for one allowlist every client gets byte-identical rows.
  // A kiosk load opens several websockets, so without a cache HA re-serialises ~10MB of
  // entity registry per connection and this proxy re-parses it, for no new information.
  //
  // Its own proxy and mock on purpose: the cache is warm by this point in the shared
  // instance, so "the first connection fetches" is only observable on a cold one.
  it('serves the second connection from cache without asking HA again', async () => {
    const m2 = await startMockHa();
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'test-dash', port: p2 });
    try {
      await px.waitForLog(READY);
      const ask = async () => {
        const c = haClient(`ws://127.0.0.1:${p2}/api/websocket`);
        await c.authed;
        const rows = (await c.rpc({ type: 'config/entity_registry/list' })).result;
        c.close();
        return rows;
      };
      const before = m2.rpcCount('config/entity_registry/list');
      const first = await ask();
      const mid = m2.rpcCount('config/entity_registry/list');
      const second = await ask();
      const after = m2.rpcCount('config/entity_registry/list');

      assert.equal(mid - before, 1, 'the first connection must fetch it from HA');
      assert.equal(after - mid, 0, 'the second must not — that is the whole point');
      assert.deepEqual(second, first, 'and must still get identical rows');
    } finally { px.kill(); await m2.close(); }
  });

  it('trim_registries=0 leaves the registry untouched', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'test-dash', port: p2, extraEnv: { TRIM_REGISTRIES: '0' } });
    await px.waitForLog(READY);
    await httpGet(`http://127.0.0.1:${p2}/test-dash`);
    const c = haClient(`ws://127.0.0.1:${p2}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: "config/entity_registry/list" })).result;
    c.close(); px.kill();
    assert.ok(rows.some((r) => r.entity_id === 'light.bedroom'),
      'with trimming off, entities from other dashboards must still pass through');
  });
});

// Skipping the user lookup when no per-user rule could possibly apply.
//
// Resolving the user costs a round trip to HA and the connection is held for its duration. That
// is worth paying when a rule might widen the allowlist, and pure loss when none can. Measured on
// a live instance, every per-user rule was scoped to one dashboard — so every wall-panel
// connection paid the lookup to reach a foregone conclusion.
describe('per-user gate is skipped when no rule could match', () => {
  let mock, proxy, port, out = '';

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: {
        ...process.env,
        HA_BASE: mock.base, HA_TOKEN: 'test-token',
        DASH_PATHS: 'test-dash,auto-dash',
        PORT: String(port), STATS_PORT: String(await getFreePort()),
        STRIP_ENTITIES: '1', PER_DASHBOARD: '1',
        // Scoped to auto-dash only — a test-dash connection can never match it.
        USER_OVERRIDES: JSON.stringify([
          { user: 'someone', dashboard: 'auto-dash', always_forward: ['light.bedroom'] },
        ]),
        // Make a lookup impossible to miss if it happens.
        CLIENT_DASH_TTL_MS: '60000',
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

  // The identity of a connection no rule can match is still worth KNOWING — the stats panel has
  // a user column, and leaving it blank made every wall panel look anonymous when the truth was
  // that nobody had asked. So the lookup happens; what must not happen is the connection WAITING
  // for it. That distinction is the whole point: the original 1.6s-per-load regression was not
  // caused by looking the user up, it was caused by holding the client until the answer arrived.
  it('resolves the user for reporting without making the connection wait for it', async () => {
    mock.setCurrentUserDelay?.(400);           // a gate, if there is one, is unmissable
    // Attribute the connection to test-dash first. Unattributed connections still gate, and
    // deliberately so — we cannot rule a rule out when we do not know the dashboard.
    await httpGet(`http://127.0.0.1:${port}/test-dash/main`);
    const before = mock.rpcCount('auth/current_user');
    const seq = mock.subscribeEntitiesSeq();
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const t0 = Date.now();
    c.send({ type: 'subscribe_entities', id: 60 });
    await mock.waitForSubscribeEntities(seq);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 300,
      `the subscription must not wait on the 400ms user lookup (took ${elapsed}ms)`);

    // ...and the lookup still happens, off to one side. Without this half the test is satisfied
    // by never resolving the user at all, which is the behaviour being replaced.
    const deadline = Date.now() + 5000;
    while (mock.rpcCount('auth/current_user') === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(mock.rpcCount('auth/current_user') > before,
      'the user must still be resolved, so the panel can report who this is');
    c.close();
  });
});

// Latency regressions: the proxy inserting a blocking round trip before it forwards the client.
//
// This is the CLASS of bug, not one instance of it. A per-user rule scoped to a dashboard the
// client never opened once held every connection while the add-on resolved the user — to reach a
// conclusion that could not change anything. Measured end-to-end in a browser it cost ~1.6
// seconds per page load and made the add-on measure *slower* than not using it at all on a LAN.
//
// The whole suite passed throughout. Every test asserted the gate WORKED; none asserted it stayed
// out of the way, and none measured time. These two do, from both sides, because a one-sided
// latency test is trivially satisfied by removing the feature.
describe('a connection is not delayed by work that cannot change its answer', () => {
  let mock, proxy, port, out = '';

  // The user lookup is slowed far past any plausible scheduling noise, so "did the connection
  // wait for it" is a question about hundreds of milliseconds rather than a few.
  const LOOKUP_MS = 600;

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: {
        ...process.env,
        HA_BASE: mock.base, HA_TOKEN: 'test-token',
        DASH_PATHS: 'test-dash,auto-dash',
        PORT: String(port), STATS_PORT: String(await getFreePort()),
        STRIP_ENTITIES: '1', PER_DASHBOARD: '1',
        USER_OVERRIDES: JSON.stringify([
          { user: 'someone', dashboard: 'auto-dash', always_forward: ['light.bedroom'] },
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
    mock.setCurrentUserDelay(LOOKUP_MS);
  });

  after(() => { proxy?.kill(); mock?.close(); });

  // How long from opening the socket to HA actually receiving the subscription.
  // A DISTINCT token per call, because the proxy caches the token -> user resolution. Sharing one
  // would let whichever test ran first warm the cache and hand the next a lookup that costs
  // nothing — a test passing for a reason that has nothing to do with what it claims to check.
  let tokenSeq = 0;
  const timeToSubscribe = async (pageUrl, id) => {
    if (pageUrl) await httpGet(`http://127.0.0.1:${port}${pageUrl}`);
    const seq = mock.subscribeEntitiesSeq();
    const t0 = Date.now();
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, `test-token-${++tokenSeq}`);
    await c.authed;
    c.send({ type: 'subscribe_entities', id });
    await mock.waitForSubscribeEntities(seq);
    const ms = Date.now() - t0;
    c.close();
    return ms;
  };

  it('a dashboard no rule is scoped to is not held for a user lookup', async () => {
    const ms = await timeToSubscribe('/test-dash/main', 80);
    assert.ok(ms < LOOKUP_MS / 2,
      `test-dash cannot match a rule scoped to auto-dash, so the connection must not wait `
      + `${LOOKUP_MS}ms for a user lookup — took ${ms}ms`);
  });

  it('but a dashboard a rule IS scoped to still waits, so the rule can apply', async () => {
    // The other half. Without this, deleting the gate entirely would pass the test above — and
    // that is precisely the "fix" that silently serves the wrong allowlist.
    const ms = await timeToSubscribe('/auto-dash/main', 81);
    assert.ok(ms >= LOOKUP_MS * 0.8,
      `auto-dash CAN match a rule, so its allowlist must not be sent before the user resolves `
      + `— took only ${ms}ms`);
  });
});

// Modules that render nothing, found by the config block they read.
//
// This is the failure `resources_always_forward` existed to paper over. A dashboard carrying
// `kiosk_mode:` at its top level is unambiguously asking for kiosk-mode.js — but `kiosk_mode` is
// a KEY, its values are booleans, and the card walk only ever inspects VALUES shaped like
// `custom:x`. The evidence was in the config all along, in a place nothing looked.
describe('resources for modules that register no card', () => {
  // Compared on PATH, not full URL: the mock appends a HACS-style `?hacstag=` cache-buster, and
  // a resource's identity is its path — the same rule the proxy itself applies.
  const resourcesFor = async (p, pageUrl) => {
    if (pageUrl) await httpGet(`http://127.0.0.1:${p}${pageUrl}`);
    const c = haClient(`ws://127.0.0.1:${p}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: 'lovelace/resources' })).result;
    c.close();
    return rows.map((r) => String(r.url).split('?')[0]);
  };

  // Shaped exactly like a real one: a module block beside `title` and `views`, whose values are
  // booleans and nested keys — nothing a value-walk can see.
  const CFG = {
    title: 'Home',
    global_patcher: { mobile_settings: { hide_header: true, hide_sidebar: false } },
    views: [{ cards: [{ type: 'custom:my-fancy-card', entity: 'light.living_room' }] }],
  };

  it('keeps the module its top-level config block names, with nothing pinned', async () => {
    const m2 = await startMockHa({ configs: { 'mod-dash': CFG } });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'mod-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(READY);
      const urls = await resourcesFor(p2, '/mod-dash');
      assert.ok(urls.includes('/res/global-patcher.js'),
        'a module named by its own config block must survive without resources_always_forward');
      // The point is a NARROWER miss, not a wider net: everything else must still go.
      assert.ok(!urls.includes('/res/unrelated-widget.js'),
        'detecting module blocks must not turn into keeping everything');
    } finally { px.kill(); await m2.close(); }
  });

  // A config block is not a card, and must never be counted as one. The proxy reports the card
  // types each dashboard needs, warns about those whose file was dropped, and lists those it
  // cannot verify — a module name leaking into that set would produce warnings about something
  // that was never going to render, which is the class of never-true warning already shipped and
  // withdrawn once here.
  it('never counts the config block as a card type', async () => {
    const m2 = await startMockHa({ configs: { 'mod-dash': CFG } });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'mod-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(READY);
      const needs = /resources mod-dash needs: (.*)/.exec(px.out);
      assert.ok(needs, `expected a "needs" line:\n${px.out}`);
      assert.match(needs[1], /my-fancy-card/, 'the real card type is still listed');
      assert.doesNotMatch(needs[1], /global[_-]patcher/,
        'a module config block is not a card type and must not be reported as one');
      assert.doesNotMatch(px.out, /will NOT render[^\n]*global[_-]patcher/,
        'and must never produce an unrenderable-card warning');
    } finally { px.kill(); await m2.close(); }
  });

  // The guard that keeps this from becoming the "everything matches everything" bug: only keys
  // Home Assistant does not define itself are treated as module names. `title` and `views` occur
  // on every dashboard, and as substrings in most bundles.
  // The guard that stops this becoming the "everything matches everything" bug. `title` and
  // `views` sit on every dashboard and occur as substrings in plenty of bundles, so treating
  // every top-level key as a module name would keep those bundles on every install — the same
  // silent disabling of the trim that the MIN_KEY and fragment-frequency rules exist to prevent.
  // The bundle here contains both words, so a missing skip-list keeps it.
  it('ignores the dashboard keys Home Assistant defines itself', async () => {
    const m2 = await startMockHa({
      configs: { 'plain-dash': { title: 'x', views: [{ cards: [{ type: 'custom:my-fancy-card', entity: 'light.living_room' }] }] } },
      resources: [
        { id: 'r1', type: 'module', url: '/res/my-fancy-card.js' },
        { id: 'r2', type: 'module', url: '/res/decoy.js' },
      ],
      resourceBodies: { '/res/decoy.js': 'const a="title";const b="views";const c="config";' },
    });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'plain-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(READY);
      const urls = await resourcesFor(p2, '/plain-dash');
      assert.ok(urls.includes('/res/my-fancy-card.js'), 'the real card still survives');
      assert.ok(!urls.includes('/res/decoy.js'),
        'a bundle containing only Home Assistant\'s own dashboard keys must not be kept');
    } finally { px.kill(); await m2.close(); }
  });
});

// A bundle that only MENTIONS another card is not that card's provider.
//
// The literal test answers "could this bundle define this card". It cannot answer the reverse,
// and on a real instance that cost real time: bubble-card.js and simple-swipe-card.js both
// contain the string `grid-layout`, utility-cards.js and swipe-navigation.js both contain
// `navbar-card`, because each integrates with them. A dashboard using only grid-layout and
// navbar-card kept all four — 1,326 ms of parsing on a px30 wall panel, 10% of a 13.3 s cold
// start, for cards that were never on the page.
describe('resource matching: a mention is not a provider', () => {
  const resourcesFor = async (p, pageUrl) => {
    if (pageUrl) await httpGet(`http://127.0.0.1:${p}${pageUrl}`);
    const c = haClient(`ws://127.0.0.1:${p}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: 'lovelace/resources' })).result;
    c.close();
    return rows.map((r) => String(r.url).split('?')[0]);
  };

  // `navbar-card.js` is named for the card. `integrator.js` merely talks about it.
  const RES = [
    { id: 'a', type: 'module', url: '/res/navbar-card.js' },
    { id: 'b', type: 'module', url: '/res/integrator.js' },
  ];
  const BODIES = {
    '/res/navbar-card.js': 'customElements.define("navbar-card", C);',
    '/res/integrator.js': 'const supported=["navbar-card","other-card"];// integrates with navbar-card',
  };
  const CFG = { views: [{ cards: [{ type: 'custom:navbar-card', entity: 'light.living_room' }] }] };

  it('keeps the file named for the card and drops the one that only mentions it', async () => {
    const m2 = await startMockHa({ configs: { 'p-dash': CFG }, resources: RES, resourceBodies: BODIES });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'p-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(READY);
      const urls = await resourcesFor(p2, '/p-dash');
      assert.ok(urls.includes('/res/navbar-card.js'), 'the provider must survive');
      assert.ok(!urls.includes('/res/integrator.js'),
        'a bundle that only names the card is not needed to render it');
    } finally { px.kill(); await m2.close(); }
  });

  it('does not report the card as unrenderable when only the mention was dropped', async () => {
    const m2 = await startMockHa({ configs: { 'p-dash': CFG }, resources: RES, resourceBodies: BODIES });
    const p2 = await getFreePort();
    const sp = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'p-dash', port: p2, statsPort: sp, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(READY);
      const stats = JSON.parse((await httpGet(`http://127.0.0.1:${sp}/stats.json`)).body);
      assert.deepEqual(stats.resources.unmetByDashboard || {}, {},
        'the provider is kept, so nothing is unrenderable');
      assert.doesNotMatch(px.out, /will NOT render/);
    } finally { px.kill(); await m2.close(); }
  });

  // Frequency has to be counted over PATHS, not bodies. On the instance this came from, the
  // fragment `layout` appears in 24 of 42 bundle BODIES — far too common to identify anything —
  // while naming exactly one file. Judged by bodies it is noise; judged by paths it is the
  // answer. Here four decoys mention "layout" in passing, which is enough to disqualify the
  // fragment if the wrong denominator is used, and the real provider then goes unrecognised.
  it('counts fragment frequency over paths, not bodies', async () => {
    const decoys = ['alpha', 'beta', 'gamma', 'delta'];
    const m2 = await startMockHa({
      configs: { 'l-dash': { views: [{ cards: [{ type: 'custom:grid-layout', entity: 'light.living_room' }] }] } },
      resources: [
        { id: 'p', type: 'module', url: '/res/layout-card.js' },
        { id: 'm', type: 'module', url: '/res/bubble-card.js' },
        ...decoys.map((d, i) => ({ id: 'd' + i, type: 'module', url: `/res/${d}.js` })),
      ],
      resourceBodies: {
        '/res/layout-card.js': 'customElements.define("grid-layout", C);',
        '/res/bubble-card.js': 'const supports=["grid-layout"];// works inside grid-layout',
        ...Object.fromEntries(decoys.map((d) => [`/res/${d}.js`, `// mentions layout in passing\nconst layout=1;`])),
      },
    });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'l-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(READY);
      const urls = await resourcesFor(p2, '/l-dash');
      assert.ok(urls.includes('/res/layout-card.js'), 'the file named for the card must survive');
      assert.ok(!urls.includes('/res/bubble-card.js'),
        'path frequency identifies the provider even when the fragment is common in bodies');
    } finally { px.kill(); await m2.close(); }
  });

  // The narrowing only applies where a provider is identifiable. When no file is named for the
  // card — the runtime-built-name case — the old body test must still run, or bundles like
  // mushroom.js would start being dropped, which is the dangerous direction.
  //
  // The second card exists to keep the keep-set non-empty. Without it this test cannot fail:
  // an empty keep set disables resource trimming altogether (`if (keep?.size)`), so a build that
  // wrongly dropped the anonymous bundle would forward every resource anyway and the assertion
  // would pass on a bug. Found by reintroducing exactly that bug and watching it pass.
  it('falls back to the body test when no file is named for the card', async () => {
    const m2 = await startMockHa({
      configs: { 'p-dash': { views: [{ cards: [
        { type: 'custom:zzz-widget-card', entity: 'light.living_room' },
        { type: 'custom:solid-card', entity: 'light.living_room' },
      ] }] } },
      resources: [
        { id: 'a', type: 'module', url: '/res/anonymous-bundle.js' },
        { id: 'b', type: 'module', url: '/res/solid-card.js' },
        { id: 'c', type: 'module', url: '/res/decoy.js' },
      ],
      resourceBodies: {
        '/res/anonymous-bundle.js': 'const t="zzz-widget-card";customElements.define(t,C);',
        '/res/solid-card.js': 'customElements.define("solid-card", C);',
        '/res/decoy.js': 'const unrelated = 1;',
      },
    });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'p-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(READY);
      const urls = await resourcesFor(p2, '/p-dash');
      assert.ok(urls.includes('/res/solid-card.js'), 'the named provider is kept');
      assert.ok(urls.includes('/res/anonymous-bundle.js'),
        'with no provider identifiable, the literal body match must still keep it');
      assert.ok(!urls.includes('/res/decoy.js'), 'and trimming is actually happening');
    } finally { px.kill(); await m2.close(); }
  });
});
