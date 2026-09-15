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

  it('sends every combination to the one overrides list', () => {
    // There is one list now, and the engine works out when a rule can be evaluated from what it
    // matches on. The combinations that used to be refused are the whole point of the change.
    for (const picked of [['dashboard'], ['user'], ['client'], ['user_agent'],
      ['user', 'dashboard'], ['user', 'client'], ['client', 'dashboard'],
      ['user', 'client', 'dashboard', 'user_agent']]) {
      const k = kindFor(picked);
      assert.equal(k.error, undefined, `${picked.join('+')} must be allowed`);
      assert.equal(k.key, 'overrides');
    }
  });

  it('still refuses a rule that matches nothing', () => {
    // A rule with no matcher applies to every connection, which is what the global always/never
    // lists already are — and it would do it silently, under a name that says "override".
    const nothing = kindFor([]);
    assert.ok(nothing.error, 'matching nothing must be refused');
    assert.equal(nothing.key, undefined, 'a refused rule must not also name a key');
  });

  it('writes only the matchers and effects that were filled in', () => {
    const rule = buildRule('overrides',
      { user: 'David Coulson', client: '10.2.4.109' },
      { always_forward: 'sensor.a, /^update\\./', never_forward: '', devices: '' });
    assert.equal(rule.user, 'David Coulson');
    assert.equal(rule.client, '10.2.4.109');
    assert.deepEqual(plain(rule.always_forward), ['sensor.a', '/^update\\./'],
      'a comma-separated list is split and trimmed, and a regex survives it');

    // An empty string is NOT the same as an absent matcher: the engine treats a present dashboard
    // as a scope, so `dashboard: ''` would scope the rule to a dashboard that does not exist and
    // the rule would never fire. Same for an empty effect list, which would read as "forward
    // nothing" rather than "no forward rule".
    assert.ok(!('dashboard' in rule), 'an unset matcher must be omitted entirely');
    assert.ok(!('user_agent' in rule), 'an unset matcher must be omitted entirely');
    assert.ok(!('never_forward' in rule), 'an empty effect must be omitted entirely');
    assert.ok(!('devices' in rule), 'an empty effect must be omitted entirely');

    const devices = buildRule('overrides', { client: '10.2.4.0/24' },
      { devices: 'Basement Stairs Panel, Test Panel' });
    assert.deepEqual(plain(devices.devices), ['Basement Stairs Panel', 'Test Panel'],
      'whole devices may be named on any rule, not only a device-matched one');
  });

  it('offers a matcher for each thing a rule list can key on', () => {
    assert.deepEqual(plain(MATCHERS.map((m) => m.id).sort()),
      ['client', 'dashboard', 'user', 'user_agent']);
    for (const m of MATCHERS) {
      assert.ok(m.label && m.hint, `${m.id} needs a label and an example`);
    }
  });
});

// One word per concept across the whole screen.
//
// The same matcher was called "user agent" on the left of a row and "client app" on the right,
// and a device rule said "when client is ..." under a tag reading "device" — one fact, printed
// twice, in two vocabularies. It reads as two different things being described.
describe('the override list vocabulary', () => {
  const kinds = (() => {
    const m = panel.match(/const OVERRIDE_KINDS = \{[\s\S]*?\n\};/);
    assert.ok(m, 'OVERRIDE_KINDS must exist');
    return m[0];
  })();

  it('uses the wizard\'s words for every matcher', () => {
    const wizardWords = new Set(['dashboard', 'user', 'device', 'client app']);
    // Every matcher name printed in a row must be one the wizard also uses.
    const names = [...kinds.matchAll(/\['([a-z ]+)',/g)].map((m) => m[1]);
    assert.ok(names.length >= 6, `expected several matcher names, found ${names.length}`);
    for (const n of names) {
      assert.ok(wizardWords.has(n), `"${n}" is not one of the wizard's words`);
    }
    // And specifically the two that were wrong.
    assert.ok(!kinds.includes("'user agent'"), 'the User-Agent matcher must be called "client app"');
    assert.ok(!kinds.includes("['client',"), 'the address matcher must be called "device"');
  });

  it('shows one pill per matcher, not one per config list', () => {
    // A rule matching a user AND a dashboard is both; a single pill naming the list it lives in
    // cannot say that, and the list is an implementation detail anyway.
    const src = panel.match(/const tags = document\.createElement\('div'\);[\s\S]*?el\.append\(tags\);/)?.[0];
    assert.ok(src, 'the row must render a pill per matcher');
    assert.match(src, /for \(const \[name\] of pairs\)/,
      'the pills must come from the rule\'s matchers');
    assert.match(src, /tags\.title = row\.key/,
      'which config list the rule came from belongs in the tooltip, not a pill');
  });
});
