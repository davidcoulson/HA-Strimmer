import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATES } from './fixtures.mjs';
import { startMockHa, getFreePort } from './mock-ha.mjs';

const PROXY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ha_ws_trim_proxy.mjs');

test('always_forward_device_class forwards matching entities and only those', async () => {
  const mock = await startMockHa();
  const [port, sp] = [await getFreePort(), await getFreePort()];
  let out = '';
  const proxy = spawn(process.execPath, [PROXY], {
    env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash', PORT: String(port),
      STATS_PORT: String(sp), STRIP_ENTITIES: '1', ALWAYS_FORWARD_DEVICE_CLASS: 'binary_sensor:door' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxy.stdout.on('data', (b) => out += b); proxy.stderr.on('data', (b) => out += b);
  try {
    const deadline = Date.now() + 25000;
    while (!/device_class rules forward/.test(out)) {
      if (Date.now() > deadline) throw new Error(out);
      await new Promise((r) => setTimeout(r, 50));
    }
    const n = Number(/device_class rules forward (\d+)/.exec(out)[1]);
    assert.equal(n, STATES.filter((x) => x.attributes?.device_class === 'door').length);
    assert.ok(n >= 2);
  } finally { proxy.kill(); await mock.close(); }
});
