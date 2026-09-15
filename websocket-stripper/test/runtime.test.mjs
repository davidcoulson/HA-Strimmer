// Runtime hardening: the three things that cost real outages rather than benchmarks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(DIR, '..', 'ha_ws_trim_proxy.mjs'), 'utf8');

// A bug in post-auth setup can never succeed on retry, and retrying it hides it completely: the
// add-on stays UP, logs "reconnecting" once a second, and serves no allowlist at all. That reads
// like a slow Home Assistant, not like a crash — which is why it went unnoticed twice in one
// afternoon (`id is not defined`, and nearly `path is not defined`).
describe('a code error is not mistaken for Home Assistant restarting', () => {
  const block = src.match(/\} catch \(e\) \{[\s\S]*?post-auth setup failed[\s\S]*?\n          \}/)?.[0];

  it('exits on a programming error instead of reconnecting forever', () => {
    assert.ok(block, 'the post-auth catch must exist');
    assert.match(block, /e instanceof ReferenceError/);
    assert.match(block, /e instanceof TypeError/);
    assert.match(block, /process\.exit\(1\)/,
      'retrying a ReferenceError produces a running process that serves nothing');
  });

  it('still retries the operational case it was written for', () => {
    // HA answering the handshake then dying mid-build IS fixed by reconnecting.
    assert.match(block, /post-auth setup failed/);
    assert.match(block, /ws\.close\(\)/, 'the socket is dropped so a retry is scheduled');
    const fatalAt = block.indexOf('process.exit(1)');
    const retryAt = block.indexOf('post-auth setup failed');
    assert.ok(fatalAt < retryAt,
      'the code-error test must come first, or every error takes the retry path');
  });

  it('is no more forgiving than the process-level handler', () => {
    // That handler forgives only network errnos; this catch used to forgive everything.
    const global = src.match(/const survivable = \(e, what\) => \{[\s\S]*?\n\};/)?.[0];
    assert.ok(global, 'the process-level rule must exist');
    assert.match(global, /NET_ERRNOS\.has\(e\?\.code\)/);
  });
});

// Node closes an idle keep-alive connection after 5s; nginx holds upstream keep-alives for 60.
// In that gap nginx can reuse a socket Node has just closed and return a 502 — sporadic and
// blamed on anything but the timeout. This add-on normally sits behind exactly such a proxy.
describe('keep-alive timeouts suit sitting behind a reverse proxy', () => {
  it('outlives a default nginx upstream idle timeout', () => {
    const ka = [...src.matchAll(/keepAliveTimeout = (\d+)/g)].map((m) => Number(m[1]));
    assert.equal(ka.length, 2, 'both servers need it, not just the proxy one');
    for (const v of ka) {
      assert.ok(v > 60000, `keepAliveTimeout ${v} must exceed nginx's 60s default`);
    }
  });

  it('reads headers for longer than it holds the connection', () => {
    const ka = Number(src.match(/server\.keepAliveTimeout = (\d+)/)[1]);
    const ht = Number(src.match(/server\.headersTimeout = (\d+)/)[1]);
    assert.ok(ht > ka,
      'headersTimeout below keepAliveTimeout cuts a request off mid-headers');
  });
});

// Every restart is a window in which a panel reconnecting before it re-fetches its page falls
// back to the union. Shortening the boot shortens that window.
describe('the compile cache is actually written', () => {
  // The cache exists for the NEXT boot, and two separate things were quietly stopping it from
  // ever reaching disk:
  //
  //   1. module.enableCompileCache() called from this ESM entrypoint runs AFTER every static
  //      import has already been compiled, so it caches nothing. NODE_COMPILE_CACHE is read
  //      before any of it is compiled.
  //   2. Node writes the cache at a normal exit, and the SIGTERM the Supervisor sends is not one.
  //
  // Neither announces itself — the app boots fine and is simply slower forever. So test the
  // observable thing: boot the real proxy, stop it the way the Supervisor does, look for files.
  it('lands on disk after the SIGTERM that Supervisor sends', async () => {
    const { spawn } = await import('node:child_process');
    const { startMockHa, getFreePort } = await import('./mock-ha.mjs');
    const os = await import('node:os');

    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'stripper-cc-'));
    const mock = await startMockHa();
    const port = await getFreePort();
    const sp = await getFreePort();
    const proxy = spawn(process.execPath, [path.join(DIR, '..', 'ha_ws_trim_proxy.mjs')], {
      cwd: path.join(DIR, '..'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(sp), NODE_COMPILE_CACHE: cache },
    });
    try {
      let out = '';
      proxy.stdout.on('data', (b) => out += b); proxy.stderr.on('data', (b) => out += b);
      const deadline = Date.now() + 10000;
      while (!/union allowlist for/.test(out)) {
        if (Date.now() > deadline) throw new Error(`no boot\n${out}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const exited = new Promise((r) => proxy.on('exit', r));
      proxy.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);

      const files = fs.readdirSync(cache, { recursive: true })
        .filter((f) => fs.statSync(path.join(cache, f)).isFile());
      assert.ok(files.length > 0,
        'nothing was cached, so every boot recompiles from source — the cache is enabled too ' +
        'late to catch the static imports, or SIGTERM killed the process before Node flushed it');
    } finally {
      proxy.kill('SIGKILL'); await mock.close();
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });

  it('is turned on where it can still catch the static imports', () => {
    const dockerfile = fs.readFileSync(path.join(DIR, '..', 'Dockerfile'), 'utf8');
    const env = dockerfile.match(/^ENV NODE_COMPILE_CACHE=(\S+)/m);
    assert.ok(env, 'NODE_COMPILE_CACHE must be set before node starts, not from inside the module');
    assert.match(env[1], /^\/data\b/,
      'the cache belongs on the persistent volume — Node\'s own default is under /tmp, which the '
      + 'container discards on exactly the restart this is meant to speed up');
    // Comments stripped: the reason this is not called here is itself written down there.
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/enableCompileCache/.test(code),
      'calling it from this ES module caches nothing: its static imports are already compiled');
  });
});

// A stop is half of every restart, and the restart is the event this app has to be good at.
describe('shutting down', () => {
  const handler = src.match(/function shutdown\(sig\) \{[\s\S]*?\n\}/)?.[0];

  it('writes the hints the debounce is still holding', () => {
    assert.ok(handler, 'there must be a shutdown handler at all');
    assert.match(handler, /flushClientDash\(\)/,
      'up to 5s of dashboard attribution is pending, and losing it costs a panel the very '
      + 'reload these hints exist to avoid');
    assert.match(src, /process\.on\('SIGTERM'/, 'SIGTERM is how Supervisor stops an add-on');
  });

  it('does not wait for long-lived websockets to drain', () => {
    // server.close() resolves only when every connection ends. Panels hold theirs open for days,
    // so awaiting it means awaiting the Supervisor's SIGKILL instead of exiting.
    assert.match(handler, /setTimeout\(\(\) => process\.exit\(0\), \d+\)/,
      'shutdown must be bounded by a timer, not by the connections closing');
  });

  it('a second signal gives up immediately', () => {
    assert.match(handler, /if \(shuttingDown\) process\.exit\(0\)/);
  });
});
