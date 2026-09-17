// Redirect (Location header) handling — issue #9, second failure.
//
// `changeOrigin` makes HA see the request as arriving at HA_BASE, so its absolute redirects
// name HA's own address. http-proxy's `autoRewrite` fixed the host but never the scheme, so
// behind an HTTPS terminator the browser was sent from https://host/... to http://host/...,
// the edge proxy bounced it back to HTTPS, and HA reissued the same redirect — an infinite
// loop, and a page that never loads.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { getFreePort } from './mock-ha.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

// A stand-in HA that only needs to issue redirects. The allowlist never builds (no ws), which
// is fine: HTTP passthrough serves regardless, and that's all this exercises.
async function startRedirectHa(port, routes) {
  const server = http.createServer((req, res) => {
    const loc = routes[req.url.split('?')[0]];
    if (loc) { res.writeHead(302, { location: typeof loc === 'function' ? loc(port) : loc }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('HA_OK');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}

describe('#9 redirects point back at the origin the browser used', () => {
  let ha, proxy, haPort, port;

  before(async () => {
    haPort = await getFreePort();
    port = await getFreePort();
    ha = await startRedirectHa(haPort, {
      '/rel': '/lovelace/0',
      '/abs': (p) => `http://127.0.0.1:${p}/lovelace/0`,
      '/auth': (p) => `http://127.0.0.1:${p}/auth/authorize?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A${p}%2F`,
      '/third-party': 'https://example.com/oauth/callback',
      // The companion app authenticates with a custom-scheme callback.
      '/app-auth': (p) => `http://127.0.0.1:${p}/auth/authorize?client_id=https%3A%2F%2Fhome-assistant.io%2Fandroid&redirect_uri=homeassistant%3A%2F%2Fauth-callback`,
    });
    proxy = spawn(process.execPath, [PROXY], {
      env: {
        ...process.env, HA_BASE: `http://127.0.0.1:${haPort}`, HA_TOKEN: 't',
        DASH_PATHS: 'd', PORT: String(port), SUPERVISOR_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((r) => setTimeout(r, 1200));
  });
  after(async () => { proxy?.kill(); await new Promise((r) => ha.close(r)); });

  // Ask the way Caddy would: original Host + the client's real scheme.
  const viaEdge = (path, headers = { host: 'ha.duckdns.org', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'ha.duckdns.org' }) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
        res.resume();
        resolve({ status: res.statusCode, location: res.headers.location });
      }).on('error', reject);
    });

  it('rewrites BOTH scheme and host on an absolute redirect', async () => {
    const { location } = await viaEdge('/abs');
    // The whole bug: host-only rewriting left this on http:// and looped forever.
    assert.equal(location, 'https://ha.duckdns.org/lovelace/0');
  });

  it('rewrites redirect_uri inside the auth redirect', async () => {
    const { location } = await viaEdge('/auth');
    const u = new URL(location);
    assert.equal(u.origin, 'https://ha.duckdns.org');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://ha.duckdns.org/',
      'login must come back through the proxy, not HA\'s internal address');
  });

  it('does not mangle a custom-scheme redirect_uri (companion app auth)', async () => {
    // homeassistant://auth-callback parses with host 'auth-callback', which matches neither
    // HA nor the browser host — so it must pass through untouched. Broadening the rewrite to
    // "any absolute redirect_uri" would silently break app login and be miserable to debug.
    const { location } = await viaEdge('/app-auth');
    const u = new URL(location);
    assert.equal(u.origin, 'https://ha.duckdns.org', 'the redirect itself is still rewritten');
    assert.equal(u.searchParams.get('redirect_uri'), 'homeassistant://auth-callback');
    assert.equal(u.searchParams.get('client_id'), 'https://home-assistant.io/android');
  });

  it('leaves a relative redirect relative', async () => {
    const { location } = await viaEdge('/rel');
    assert.equal(location, '/lovelace/0');
  });

  it('does not touch a genuinely third-party redirect', async () => {
    const { location } = await viaEdge('/third-party');
    assert.equal(location, 'https://example.com/oauth/callback');
  });

  it('behaves for a direct client with no edge proxy', async () => {
    // No X-Forwarded-* from a client: the proxy adds its own, so scheme is plain http and
    // the host is whatever the browser asked for. This is the pre-existing common case.
    const { location } = await viaEdge('/abs', { host: `127.0.0.1:${port}` });
    assert.equal(location, `http://127.0.0.1:${port}/lovelace/0`);
  });

  it('non-redirect responses are untouched', async () => {
    const { status, location } = await viaEdge('/whatever');
    assert.equal(status, 200);
    assert.equal(location, undefined);
  });
});
