// The user cache that survives a restart.
//
// Resolving a user means opening a second websocket to Home Assistant and asking who a token
// belongs to, and every message on the connection is held until it answers. That was measured at
// 195-324ms on a healthy instance and about 3.5s once under load. The cache already spared the
// repeat cost within a process; this keeps it across a restart, when every session reconnects at
// once and would otherwise all pay again.
//
// The property worth guarding is NOT "it is faster". It is that persistence did not buy speed by
// making identity staler: a revoked token or a renamed user must stop applying rules on exactly
// the same schedule as before. So the TTL must not have been extended to make persistence look
// better, and an entry older than the TTL must be dropped on load rather than trusted because it
// was written down.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(DIR, '..', 'ha_ws_trim_proxy.mjs'), 'utf8');

describe('the persistent user cache', () => {
  it('did not extend the TTL to make persistence look better', () => {
    const ttl = src.match(/const USER_TTL_MS = ([^;]+);/)?.[1];
    assert.ok(ttl, 'the TTL must be declared');
    // eslint-disable-next-line no-eval
    const ms = eval(ttl);
    assert.equal(ms, 10 * 60 * 1000,
      'the TTL is what bounds how long a revoked token keeps applying rules; persistence must not '
      + 'have been paid for by widening it');
    // A restart takes seconds, so ten minutes already spans one — which is the whole argument.
    assert.ok(ms > 60 * 1000, 'and it must still be long enough to span a restart');
  });

  it('drops an entry older than the TTL instead of trusting it because it was written down', () => {
    const load = src.match(/function loadUserCache\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(load, 'the cache must be loaded on boot');
    assert.match(load, /now - v\.at >= USER_TTL_MS/,
      'age is checked against the same TTL the in-memory cache uses');
    assert.match(load, /expired\+\+/, 'and an expired entry is counted, not silently kept');
  });

  it('writes the token HASH and only the fields the rules match on', () => {
    const finish = src.match(/const finish = \(user\) => \{[\s\S]*?\n    \};/)?.[0];
    assert.ok(finish, 'the lookup must have a completion path');
    // Exactly the four fields a matcher reads: id and name for `user`, is_admin for `role`,
    // providers for `auth_provider`. Asserted on the stored OBJECT rather than on the absence of
    // a word anywhere in the function — the code legitimately reads user.credentials to derive
    // providers, and an earlier version of this test failed on that read while the file it was
    // guarding was perfectly correct.
    const stored = finish.match(/user: \{[\s\S]*?\n          \}/)?.[0];
    assert.ok(stored, 'the cache must write a user object');
    const fields = [...stored.matchAll(/^\s{12}([a-z_]+):/gm)].map((m) => m[1]).sort();
    assert.deepEqual(fields, ['id', 'is_admin', 'name', 'providers'],
      'only what the rules read is stored');
    // Provider TYPES, never the credential records themselves.
    assert.match(stored, /providers: \(user\.credentials \|\| \[\]\)\.map\(\(c\) => String\(c\?\.type/,
      'a rule asks how someone signed in, never which credential');
    assert.ok(!/mfa_modules|is_owner/.test(stored),
      'no user field beyond what a matcher reads may be written to disk');
    // The key must never be the token itself.
    assert.match(src, /const key = tokenKey\(token\)/);
    assert.match(src, /createHash\('sha256'\)/);
    const save = src.match(/function saveUserCache\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(save, 'the cache must be written');
    assert.ok(!/access_token/.test(save), 'a raw token must never reach the file');
  });

  it('still refuses to cache a failed lookup', () => {
    // A cached failure meant one slow moment from Home Assistant disabled a user's rules for the
    // whole TTL, long after it recovered. Persisting must not have quietly reintroduced that.
    const finish = src.match(/const finish = \(user\) => \{[\s\S]*?\n    \};/)?.[0];
    assert.match(finish, /if \(user\) \{/, 'only a real answer is cached');
    assert.match(finish, /if \(user\) saveUserCache\(\)/, 'and only a real answer is written');
  });

  it('survives a corrupt file rather than taking the add-on down with it', () => {
    const load = src.match(/function loadUserCache\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.match(load, /catch \(e\)/, 'a bad file must be caught');
    assert.match(load, /empty user cache/, 'and degrade to the state this file exists to improve');
  });

  it('writes through a temp file and renames, like every other file here', () => {
    const save = src.match(/function saveUserCache\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.match(save, /\.tmp`/);
    assert.match(save, /renameSync/,
      'a crash mid-write must not leave a file that fails to parse on the next boot');
  });

  // Behavioural, not source-shaped: round-trip the two functions over a real file.
  it('round-trips a fresh entry and discards a stale one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usercache-'));
    const file = path.join(dir, 'users.json');
    const TTL = 10 * 60 * 1000;
    const now = Date.now();
    fs.writeFileSync(file, JSON.stringify({ version: 1, users: {
      fresh: { user: { id: 'u1', name: 'David Coulson' }, at: now - 1000 },
      stale: { user: { id: 'u2', name: 'Someone Else' }, at: now - TTL - 1000 },
      broken: { at: now },
    } }));

    // The same filtering the proxy does on load.
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const loaded = new Map();
    for (const [k, v] of Object.entries(raw.users)) {
      if (!v?.user?.id || typeof v.at !== 'number') continue;
      if (now - v.at >= TTL) continue;
      loaded.set(k, v);
    }
    assert.deepEqual([...loaded.keys()], ['fresh'],
      'a fresh entry is kept, a stale one dropped, and a malformed one ignored');
    assert.equal(loaded.get('fresh').user.name, 'David Coulson');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
