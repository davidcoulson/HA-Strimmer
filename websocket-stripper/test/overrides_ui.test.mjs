// The override wizard's rules about which matchers can be combined.
//
// This logic lives in panel.html because it runs in the browser, which normally puts it beyond
// the suite's reach — and that is exactly why it is worth pulling out and exercising. Getting it
// wrong does not throw: it writes a rule into the nearest config key, the engine never evaluates
// it, and the rule sits in the list looking correct while doing nothing. That is the failure the
// whole Overrides screen exists to prevent, so it cannot be the failure the screen ships with.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const panel = fs.readFileSync(path.join(DIR, '..', 'panel.html'), 'utf8');

// Values built inside the sandbox carry that realm's prototypes, so deepEqual -- which is
// deepStrictEqual here -- rejects an array that is correct in every other way. Compare the data.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Pull just the wizard's decision functions into a sandbox. Taking the whole script would drag in
// the DOM; these three are deliberately pure so they can be tested at all.
function load() {
  const grab = (name, re) => {
    const m = panel.match(re);
    if (!m) throw new Error(`could not find ${name} in panel.html`);
    return m[0];
  };
  const src = [
    grab('MATCHERS', /const MATCHERS = \[[\s\S]*?\n\];/),
    grab('kindFor', /function kindFor\(picked\) \{[\s\S]*?\n\}/),
    grab('buildRule', /function buildRule\(key, values, effects\) \{[\s\S]*?\n\}/),
  ].join('\n');
  const ctx = {};
  vm.createContext(ctx);
  new vm.Script(src + '\n;({ MATCHERS, kindFor, buildRule })').runInContext(ctx);
  return new vm.Script('({ MATCHERS, kindFor, buildRule })').runInContext(ctx);
}

describe('the override wizard', () => {
  const { MATCHERS, kindFor, buildRule } = load();

  it('sends each matcher combination to the list that can actually evaluate it', () => {
    assert.equal(kindFor(['dashboard']).key, 'dashboard_overrides');
    assert.equal(kindFor(['user']).key, 'user_overrides');
    assert.equal(kindFor(['user', 'dashboard']).key, 'user_overrides',
      'a user rule may be scoped to one dashboard');
    assert.equal(kindFor(['client']).key, 'client_overrides');
    assert.equal(kindFor(['user_agent']).key, 'user_agent_dashboards');
  });

  it('refuses combinations no rule list can hold, and says why', () => {
    // The device is known when the socket opens; the user only once the token resolves. Nothing
    // evaluates both, so a rule asking for both would simply never fire.
    const both = kindFor(['user', 'client']);
    assert.ok(both.error, 'user + device must be refused');
    assert.match(both.error, /user|device/i);
    assert.equal(both.key, undefined, 'a refused combination must not also name a key');

    const scopedDevice = kindFor(['client', 'dashboard']);
    assert.ok(scopedDevice.error, 'device + dashboard must be refused');

    const uaPlus = kindFor(['user_agent', 'dashboard']);
    assert.ok(uaPlus.error, 'a client-app rule cannot be combined');

    const nothing = kindFor([]);
    assert.ok(nothing.error, 'matching nothing must be refused');
  });

  it('builds a rule in the shape its list expects', () => {
    const dash = buildRule('dashboard_overrides', { dashboard: 'kitchen' },
      { always_forward: 'sensor.a, /^update\\./', never_forward: '' });
    assert.equal(dash.dashboard, 'kitchen');
    assert.deepEqual(plain(dash.always_forward), ['sensor.a', '/^update\\./'],
      'a comma-separated list is split and trimmed, and a regex survives it');
    assert.deepEqual(plain(dash.never_forward), []);

    const user = buildRule('user_overrides', { user: 'David Coulson', dashboard: 'lovelace' },
      { always_forward: '/^update\\./' });
    assert.equal(user.user, 'David Coulson');
    assert.equal(user.dashboard, 'lovelace');

    // A user rule with no dashboard must not carry an empty one: the engine treats a present
    // dashboard as a scope, so `dashboard: ''` would scope the rule to a dashboard that does
    // not exist and the rule would never apply.
    const anywhere = buildRule('user_overrides', { user: 'David Coulson' }, { always_forward: 'x' });
    assert.ok(!('dashboard' in anywhere), 'an unscoped user rule must omit dashboard entirely');

    const client = buildRule('client_overrides', { client: '10.2.4.0/24' },
      { devices: 'Basement Stairs Panel, Test Panel' });
    assert.equal(client.client, '10.2.4.0/24');
    assert.deepEqual(plain(client.devices), ['Basement Stairs Panel', 'Test Panel']);

    const ua = buildRule('user_agent_dashboards', { user_agent: 'io.robbie.HomeAssistant' },
      { assume_dashboard: 'lovelace' });
    assert.deepEqual(plain(ua), { match: 'io.robbie.HomeAssistant', dashboard: 'lovelace' },
      'the client-app list uses match/dashboard, not the always/never shape');
  });

  it('offers a matcher for each thing a rule list can key on', () => {
    assert.deepEqual(plain(MATCHERS.map((m) => m.id).sort()),
      ['client', 'dashboard', 'user', 'user_agent']);
    for (const m of MATCHERS) {
      assert.ok(m.label && m.hint, `${m.id} needs a label and an example`);
    }
  });
});
