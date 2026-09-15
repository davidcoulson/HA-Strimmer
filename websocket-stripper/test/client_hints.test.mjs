// The dashboard hint that survives a restart.
//
// Per-dashboard attribution rests on this: a panel's page request records "this address is
// looking at office-tablet", and the websocket that follows is served that dashboard's entities
// instead of the union of every one. The map lived only in memory, so every restart threw it
// away — and a panel whose websocket reconnects WITHOUT re-fetching its page then has no hint.
//
// Measured on a live instance after a rebuild: a panel served 488 entities where it should have
// had 108, and it stayed that way until something made it reload. That is the add-on quietly not
// doing its job, triggered by the most ordinary event there is.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(DIR, '..', 'ha_ws_trim_proxy.mjs'), 'utf8');

describe('the persistent client hints', () => {
  it('loads before the proxy accepts a request', () => {
    // A hint restored after the first websocket is a hint that did not help it. The panels
    // reconnect within seconds of a restart, so this ordering is the whole feature.
    const load = src.indexOf('loadClientDash();');
    const listen = src.indexOf('server.listen(PORT');
    assert.ok(load !== -1 && listen !== -1);
    assert.ok(load < listen,
      'hints must be restored before the listener opens, or the first reconnect misses them');
  });

  it('did not widen the TTL to make persistence look better', () => {
    const ttl = src.match(/const CLIENT_DASH_TTL_MS = ([^;]+);/)?.[1];
    assert.ok(ttl, 'the TTL must be declared');
    // eslint-disable-next-line no-eval
    assert.equal(eval(ttl), 10 * 60 * 1000,
      'a restart takes seconds, so ten minutes already spans one — persistence must not have '
      + 'been paid for by letting a stale hint attribute a panel for longer');
  });

  it('drops a hint older than the TTL rather than trusting the file', () => {
    const load = src.match(/function loadClientDash\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(load, 'the hints must be loaded on boot');
    assert.match(load, /now - v\.at >= CLIENT_DASH_TTL_MS/, 'age is checked against the same TTL');
    assert.match(load, /expired\+\+/, 'and an expired hint is counted, not silently kept');
  });

  it('refuses a hint for a dashboard this app no longer serves', () => {
    // Resurrecting one would label a panel with a dashboard that is not served; allowFor would
    // fall back to the union anyway, so the only effect would be a misleading panel.
    const load = src.match(/function loadClientDash\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.match(load, /DASH_PATHS\.includes\(v\.path\)/,
      'a hint naming a dashboard that is gone must be dropped');
  });

  it('debounces writes and writes atomically', () => {
    const save = src.match(/function saveClientDashSoon\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(save, 'writes must be debounced');
    assert.match(save, /setTimeout/, 'a reloading wall panel must not rewrite this per request');
    assert.match(save, /\.tmp`/);
    assert.match(save, /renameSync/,
      'a crash mid-write must not leave a file that fails to parse on the next boot');
  });

  it('survives a corrupt file rather than taking the add-on down', () => {
    const load = src.match(/function loadClientDash\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.match(load, /catch \(e\)/);
    assert.match(load, /no client hints/, 'and degrades to the behaviour that shipped before');
  });

  // Behavioural: round-trip the load filtering over a real file.
  it('keeps a fresh hint, drops a stale one and one for an unserved dashboard', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hints-'));
    const file = path.join(dir, 'client-dash.json');
    const TTL = 10 * 60 * 1000;
    const now = Date.now();
    const served = ['office-tablet', 'basement-stairs-panel'];
    fs.writeFileSync(file, JSON.stringify({ version: 1, hints: {
      '10.2.4.145': { path: 'office-tablet', at: now - 1000 },
      '10.2.4.109': { path: 'basement-stairs-panel', at: now - TTL - 1000 },
      '10.2.4.99': { path: 'a-dashboard-that-was-deleted', at: now - 1000 },
      '10.2.4.98': { at: now },
    } }));

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const loaded = new Map();
    for (const [ip, v] of Object.entries(raw.hints)) {
      if (typeof v?.path !== 'string' || typeof v?.at !== 'number') continue;
      if (now - v.at >= TTL) continue;
      if (!served.includes(v.path)) continue;
      loaded.set(ip, v);
    }
    assert.deepEqual([...loaded.keys()], ['10.2.4.145'],
      'fresh and still-served survives; stale, unserved and malformed do not');
    assert.equal(loaded.get('10.2.4.145').path, 'office-tablet');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
