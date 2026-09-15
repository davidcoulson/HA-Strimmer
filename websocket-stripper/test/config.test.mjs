// Guards the add-on config's port handling: single source of truth (the `port` option),
// no inert `ports:` Docker mapping, and all three version stamps kept in sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(DIR, '..', p), 'utf8');
const cfg = read('config.yaml');

test('config.yaml has no top-level ports: / ports_description: block (inert under host_network)', () => {
  assert.ok(!/^ports:/m.test(cfg), 'ports: should be removed');
  assert.ok(!/^ports_description:/m.test(cfg), 'ports_description: should be removed');
});

test('config.yaml exposes the listen port in both options and schema', () => {
  // proxy_port is the canonical name; `port` (upstream's) stays schema-only so an existing
  // config keeps working without Supervisor discarding it.
  assert.match(cfg, /^\s{2}proxy_port:\s*9123\s*$/m, 'options.proxy_port default present');
  assert.match(cfg, /^\s{2}proxy_port:\s*"int\(1,65535\)\?"\s*$/m, 'schema.proxy_port present');
  assert.match(cfg, /^\s{2}port:\s*"int\(1,65535\)\?"\s*$/m, 'schema still accepts the old name');
});

test('host_network stays on (trusted-network kiosk login depends on it)', () => {
  assert.match(cfg, /^host_network:\s*true\s*$/m);
});

test('version is in sync across config.yaml, package.json, and the proxy VERSION const', () => {
  const cfgV = cfg.match(/^version:\s*"([^"]+)"/m)?.[1];
  const pkgV = JSON.parse(read('package.json')).version;
  const srcV = read('ha_ws_trim_proxy.mjs').match(/const VERSION = '([^']+)'/)?.[1];
  assert.ok(cfgV, 'config.yaml version found');
  assert.equal(pkgV, cfgV, 'package.json matches config.yaml');
  assert.equal(srcV, cfgV, 'VERSION const matches config.yaml');
});

// The add-on's Configuration tab renders from translations/en.yaml. Without an entry an
// option shows as its raw key with no help text — and several of these options have real
// footguns (trim_resources can fail silently), so an unlabelled one is a trap.
test('every schema option has a name and description in translations/en.yaml', () => {
  const tr = read('translations/en.yaml');
  const schema = cfg.slice(cfg.indexOf('\nschema:'));
  const options = [...schema.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
  assert.ok(options.length >= 10, `expected the full schema, parsed ${options.length}`);

  // Split into per-option blocks rather than using a lookahead: the last entry has no
  // following key to look ahead to, and JS has no \Z, so a lookahead silently never
  // matches it — which is exactly how this test first passed everything but the last option.
  const body = tr.slice(tr.indexOf('configuration:'));
  const blocks = new Map();
  let key = null, buf = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^ {2}([a-z_]+):\s*$/);
    if (m) { if (key) blocks.set(key, buf.join('\n')); key = m[1]; buf = []; }
    else if (key) buf.push(line);
  }
  if (key) blocks.set(key, buf.join('\n'));

  for (const opt of options) {
    const block = blocks.get(opt);
    assert.ok(block !== undefined, `translations/en.yaml is missing an entry for "${opt}"`);
    assert.match(block, /^ {4}name: /m, `"${opt}" has no name:`);
    assert.match(block, /^ {4}description: /m, `"${opt}" has no description:`);
  }
});

test('translations/en.yaml describes no option that does not exist', () => {
  const tr = read('translations/en.yaml');
  const schema = cfg.slice(cfg.indexOf('\nschema:'));
  const options = new Set([...schema.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]));
  const body = tr.slice(tr.indexOf('configuration:'));
  for (const [, key] of body.matchAll(/^ {2}([a-z_]+):/gm)) {
    assert.ok(options.has(key), `translations/en.yaml documents "${key}", which is not in the schema`);
  }
});

// The stats `options` block is hand-maintained, and it silently fell behind three times:
// log_level, trim_repairs and trim_translations were each added to config.yaml without it. The
// panel then reported them as absent, which reads identically to "Supervisor never passed this"
// — the precise question that block exists to answer. So the list is pinned to the schema.
test('the stats options block reports every simple option the schema declares', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const cfg = fs.readFileSync(path.join(dir, '..', 'config.yaml'), 'utf8');
  const src = fs.readFileSync(path.join(dir, '..', 'ha_ws_trim_proxy.mjs'), 'utf8');

  // Toggles and choices — the options a person reads off the panel to answer "is it on?".
  // List and free-string options are reported elsewhere and are deliberately out of scope.
  const simple = [...cfg.matchAll(/^  ([a-z_]+): "?(bool\??|list\([a-z|]+\)\?)"?$/gm)].map((m) => m[1]);
  assert.ok(simple.length >= 6, `expected several simple options, found ${simple.length}`);

  const block = src.slice(src.indexOf('    options: {'), src.indexOf('    allowlist: {'));
  const missing = simple.filter((k) => !block.includes(`${k}:`));
  assert.deepEqual(missing, [], `options missing from the stats block: ${missing.join(', ')}`);
});

// ingress_port is metadata Supervisor reads at install time; INGRESS_PORT is a constant compiled
// into the proxy, because the running process cannot see config.yaml. If they drift apart the
// sidebar panel breaks over Ingress while the direct port keeps working — a failure that looks
// like Ingress being broken rather than like a configuration mismatch.
test('ingress_port matches the INGRESS_PORT the proxy compiles in', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const cfg = fs.readFileSync(path.join(dir, '..', 'config.yaml'), 'utf8');
  const src = fs.readFileSync(path.join(dir, '..', 'ha_ws_trim_proxy.mjs'), 'utf8');

  const declared = Number((cfg.match(/^ingress_port:\s*(\d+)/m) || [])[1]);
  const compiled = Number((src.match(/^const INGRESS_PORT = (\d+);/m) || [])[1]);
  assert.ok(declared, 'config.yaml must declare an ingress_port');
  assert.ok(compiled, 'the proxy must compile in an INGRESS_PORT');
  assert.equal(compiled, declared,
    `INGRESS_PORT ${compiled} does not match config.yaml ingress_port ${declared}`);

  // And the option's default must be the same, or a fresh install has a panel that cannot be
  // reached from the sidebar out of the box.
  const dflt = Number((cfg.match(/^  mgmt_port:\s*(\d+)/m) || [])[1]);
  assert.ok(dflt, 'config.yaml must declare a mgmt_port default');
  assert.equal(dflt, declared, `mgmt_port default ${dflt} must equal ingress_port ${declared}`);

  // Both spellings must stay in the schema. `port` is upstream's name and `stats_port` is in
  // every config written before the rename; dropping either from the schema would make Supervisor
  // discard a working setting on upgrade, which is silent and costs someone their listen port.
  for (const k of ['proxy_port', 'port', 'mgmt_port', 'stats_port']) {
    assert.match(cfg, new RegExp(`^  ${k}: `, 'm'), `${k} must remain in the schema`);
  }
});

// The healthcheck used to carry its own copy of the stats port as a shell default. As an add-on
// that copy is the ONLY one that runs — Supervisor passes config in /data/options.json, so
// STATS_PORT is never in the container's environment. When the port moved 8100 -> 9122 the copy
// stayed behind, and a container that served every request correctly was marked unhealthy,
// restarted by the watchdog every ~85 seconds, and never reported `started` — so Ingress showed
// "The app is starting" forever. No test saw it, because every test asks the server directly on a
// port it was told. The fix was to delete the duplicate: the proxy writes the port it bound and
// the probe reads that file. This keeps it deleted.
test('the Dockerfile healthcheck reads the bound port instead of hardcoding one', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const dockerfile = fs.readFileSync(path.join(dir, '..', 'Dockerfile'), 'utf8');
  const src = fs.readFileSync(path.join(dir, '..', 'ha_ws_trim_proxy.mjs'), 'utf8');

  const portFile = (src.match(/^const STATS_PORT_FILE = '([^']+)';/m) || [])[1];
  assert.ok(portFile, 'the proxy must define STATS_PORT_FILE');
  // ...and must actually write it, or the probe has nothing to read.
  assert.match(src, new RegExp(`writeFileSync\\(STATS_PORT_FILE`),
    'the proxy must write STATS_PORT_FILE once the stats server binds');

  const probe = (dockerfile.match(/^HEALTHCHECK[\s\S]*?\n(?:\s+CMD[\s\S]*?)(?=\n\n|\n#|$)/m) || [])[0];
  assert.ok(probe, 'the Dockerfile must declare a HEALTHCHECK');
  assert.ok(probe.includes(portFile),
    `the healthcheck must read the port from ${portFile}, got: ${probe}`);
  // Any bare 4-5 digit number in the probe is a second source of truth for the port.
  const literal = probe.split(portFile).join('').match(/\b\d{4,5}\b/);
  assert.equal(literal, null,
    `the healthcheck must not hardcode a port (found ${literal && literal[0]})`);
});

// Both spellings of each port must stay readable in the source.
//
// `port` is upstream's name and `stats_port` is in every config written before the rename, so
// dropping either read would break a working install on upgrade — silently, since the option
// would simply stop being seen and the default would quietly take over. The env aliases are
// exercised by the whole suite, which spawns the proxy with PORT and STATS_PORT throughout; the
// options-file aliases have no such coverage, hence this.
test('the proxy still reads the pre-rename port option names', () => {
  const src = read('ha_ws_trim_proxy.mjs');
  for (const pair of [['proxy_port', 'port'], ['mgmt_port', 'stats_port']]) {
    const [canonical, legacy] = pair;
    assert.match(src, new RegExp(`OPT\\.${canonical}\\s*\\|\\|\\s*OPT\\.${legacy}`),
      `the proxy must read OPT.${canonical} and fall back to OPT.${legacy}`);
  }
  assert.match(src, /process\.env\.PROXY_PORT\s*\|\|\s*process\.env\.PORT/);
  assert.match(src, /process\.env\.MGMT_PORT\s*\|\|\s*process\.env\.STATS_PORT/);
});
