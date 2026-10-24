// Regressions found by the 2026-10-24 Codex review.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { WebSocket as WS } from 'ws';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';
import { certDaysLeft } from '../metrics.mjs';
import { looksCatastrophic } from '../lovelace_extract.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

async function withProxy(extraEnv, fn) {
  const mock = await startMockHa();
  const port = await getFreePort();
  let out = '';
  const proc = spawn(process.execPath, [PROXY], {
    cwd: path.join(DIR, '..'),
    env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 'test-token', DASH_PATHS: 'test-dash',
      PORT: String(port), STATS_PORT: '0', STRIP_ENTITIES: '1', PER_DASHBOARD: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (b) => { out += b.toString(); });
  proc.stderr.on('data', (b) => { out += b.toString(); });
  const deadline = Date.now() + 10000;
  while (!/for live allowlist updates/.test(out)) {
    if (Date.now() > deadline) throw new Error(`proxy never became ready\n${out}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  try { return await fn({ mock, port }); } finally { proc.kill(); await mock.close(); }
}

const subscribedIds = async (mock, port) => {
  const seq = mock.subscribeEntitiesSeq();
  const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
  await c.authed;
  c.send({ type: 'subscribe_entities' });
  const ids = (await mock.waitForSubscribeEntities(seq)) ?? [];
  c.close();
  return ids;
};

describe('certDaysLeft', () => {
  it('reads the expiry of a real TLS endpoint', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=localhost',
      '-keyout', path.join(d, 'k.pem'), '-out', path.join(d, 'c.pem')], { stdio: 'ignore' });
    const srv = tls.createServer({ key: fs.readFileSync(path.join(d, 'k.pem')), cert: fs.readFileSync(path.join(d, 'c.pem')) },
      (s) => s.end());
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const days = await certDaysLeft('127.0.0.1', { port: srv.address().port });
      assert.ok(days >= 29 && days <= 30, `expected ~30 days, got ${days}`);
    } finally { srv.close(); fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe('client rules that swap one entity for another', () => {
  it('apply when the set stays the same size', async () => {
    const victim = await withProxy({}, async ({ mock, port }) => {
      const ids = await subscribedIds(mock, port);
      return ids.find((i) => i.startsWith('light.') || i.startsWith('sensor.'));
    });
    assert.ok(victim, 'fixture needs an entity to remove');
    const rules = JSON.stringify([{ client: '127.0.0.1', always_forward: ['input_boolean.pinned_thing'], never_forward: [victim] }]);
    await withProxy({ CLIENT_OVERRIDES: rules }, async ({ mock, port }) => {
      const ids = await subscribedIds(mock, port);
      assert.ok(ids.includes('input_boolean.pinned_thing'), 'the added entity must be forwarded');
      assert.ok(!ids.includes(victim), 'the removed entity must not be');
    });
  });
});

describe('registry cache and authentication', () => {
  it('is not served to a socket that never authenticated', async () => {
    // The mock does not enforce auth the way HA does, so the observable is WHO answered: a cache
    // hit never reaches HA, a forwarded request does (and real HA then refuses it).
    await withProxy({ TRIM_SERVICES: '1' }, async ({ mock, port }) => {
      const warm = haClient(`ws://127.0.0.1:${port}/api/websocket`);
      await warm.authed;
      await warm.rpc({ type: 'get_services' });   // fills the cache
      const before = mock.rpcCount('get_services');
      const raw = new WS(`ws://127.0.0.1:${port}/api/websocket`);
      await new Promise((r) => raw.on('open', r));
      raw.send(JSON.stringify({ id: 1, type: 'get_services' }));   // no auth first
      await new Promise((r) => setTimeout(r, 800));
      raw.close(); warm.close();
      assert.equal(mock.rpcCount('get_services') - before, 1, 'must go to HA to be refused, not be answered from cache');
    });
  });
});

describe('looksCatastrophic', () => {
  const bad = ['^(a+)+$', '^(a|a)+$', '^((a)+)+$', '^(?:(a)+)+$', '^((a|b))+$', '^(x(a+))*$', '^(\\w+\\s?)*$'];
  const fine = ['^abc$', '^(abc)$', '^(ab)+$', '^\\(a+\\)+$', '^(a)(b)$', '^[a-z]+(x)$'];
  it('flags nested quantifiers and alternations at any depth', () => {
    for (const r of bad) assert.equal(looksCatastrophic(r), true, r);
  });
  it('leaves ordinary patterns alone', () => {
    for (const r of fine) assert.equal(looksCatastrophic(r), false, r);
  });
});
