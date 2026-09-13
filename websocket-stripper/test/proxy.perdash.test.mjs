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

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

function spawnProxy({ mock, dashPaths, port, extraEnv = {} }) {
  const proc = spawn(process.execPath, [PROXY], {
    cwd: path.join(DIR, '..'),
    env: {
      ...process.env,
      HA_BASE: mock.base,
      HA_TOKEN: 'test-token',
      DASH_PATHS: dashPaths,
      PORT: String(port),
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
  const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
  await c.authed;
  c.send({ type: 'subscribe_entities' });
  await new Promise((r) => setTimeout(r, 300));
  const got = mock.lastSubscribeEntities();
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
    await proxy.waitForLog(/union allowlist for/);
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
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  const injectedWithUA = async (ua, pageUrl = null) => {
    if (pageUrl) await httpGet(`http://127.0.0.1:${port}${pageUrl}`);
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, 'test-token',
      ua ? { 'user-agent': ua } : undefined);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    await new Promise((r) => setTimeout(r, 300));
    const got = mock.lastSubscribeEntities();
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
      mock, dashPaths: 'test-dash', port,
      // The case per-dashboard rules cannot express: two people, one dashboard, different
      // entities. David gets the decoys; Michelle opens the very same dashboard and does not.
      extraEnv: { USER_OVERRIDES: JSON.stringify([
        { user: 'David', always_forward: ['/^sensor\\.decoy_/'] },
      ]) },
    });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  const injectedForToken = async (token) => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, token);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    await new Promise((r) => setTimeout(r, 400));
    const got = mock.lastSubscribeEntities();
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

  it('applies no rules when the user is unknown', async () => {
    const other = await injectedForToken('some-other-token');
    assert.ok(!other.has('sensor.decoy_power'));
    assert.ok(other.has('light.living_room'));
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
    await proxy.waitForLog(/union allowlist for/);
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
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  // Same process, so the same source IP for both — exactly the NAT case.
  const withCookie = async (dash) => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, 'test-token', dash ? { Cookie: `ws_dash=${dash}` } : undefined);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    await new Promise((r) => setTimeout(r, 300));
    const got = mock.lastSubscribeEntities();
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
    await proxy.waitForLog(/union allowlist for/);
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
    await proxy.waitForLog(/union allowlist for/);
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
    await proxy.waitForLog(/union allowlist for/);
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
    await px.waitForLog(/union allowlist for/);
    const ext = await negotiated(`ws://127.0.0.1:${p2}/api/websocket`);
    px.kill();
    assert.doesNotMatch(ext, /permessage-deflate/);
  });
});

// Lovelace resources are instance-wide in HA, so every kiosk parses every custom card in the
// install — the largest remaining cost once states and registries are trimmed.
describe('resource trimming', () => {
  let mock, proxy, port;
  // A dashboard whose only custom card is `custom:my-fancy-card`.
  const CFG = { views: [{ cards: [{ type: 'custom:my-fancy-card', entity: 'light.living_room' }] }] };

  before(async () => {
    mock = await startMockHa({ configs: { 'res-dash': CFG } });
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'res-dash', port, extraEnv: { TRIM_RESOURCES: '1' } });
    await proxy.waitForLog(/union allowlist for/);
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
      await px.waitForLog(/union allowlist for/);
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
    await px.waitForLog(/union allowlist for/);
    const urls = await resourcesFor(p2, '/res-dash');
    px.kill();
    assert.ok(urls.includes('/res/global-patcher.js'), 'always_forward must win over the content match');
  });

  it('an unattributed connection still gets every resource', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    await px.waitForLog(/union allowlist for/);
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
      await px.waitForLog(/union allowlist for/);
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
      await px.waitForLog(/union allowlist for/);
      const urls = await resourcesFor(p2, '/bambu-dash');
      assert.ok(urls.some((u) => u.includes('bambulab-print_status-cards')),
        'all fragments present must count as a match');
      assert.ok(!urls.some((u) => u.includes('unrelated-widget')),
        'a bundle sharing no fragment must still be dropped');
    } finally { px.kill(); await m2.close(); }
  });

  it('trim_resources off (the default) leaves the list untouched', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2 });
    await px.waitForLog(/union allowlist for/);
    const urls = await resourcesFor(p2, '/res-dash');
    px.kill();
    assert.equal(urls.length, TOTAL_RESOURCES);
  });
});

// get_services carries every service of every integration and is sent on every page load —
// 193KB across 115 domains on the instance this was built against, where only 45 domains had
// any entity at all.
describe('get_services trimming', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port, extraEnv: { TRIM_SERVICES: '1' } });
    await proxy.waitForLog(/union allowlist for/);
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
      await px.waitForLog(/union allowlist for/);
      const r = await services(p2);
      assert.ok(r.vacuum && r.lawn_mower, 'with the option off nothing is removed');
    } finally { px.kill(); }
  });
});

describe('registry trimming', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    await proxy.waitForLog(/union allowlist for/);
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
      await px.waitForLog(/union allowlist for/);
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
    await px.waitForLog(/union allowlist for/);
    await httpGet(`http://127.0.0.1:${p2}/test-dash`);
    const c = haClient(`ws://127.0.0.1:${p2}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: "config/entity_registry/list" })).result;
    c.close(); px.kill();
    assert.ok(rows.some((r) => r.entity_id === 'light.bedroom'),
      'with trimming off, entities from other dashboards must still pass through');
  });
});
