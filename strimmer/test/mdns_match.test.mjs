// Matching what a device says it IS, over mDNS.
//
// A panel here advertises itself TWICE — as a Kiosk Satellite and as ESPHome, same name, different
// versions. 3 of 24 discovered addresses on the live instance do this. So a matcher that tested
// only the first record would answer "is this ESPHome?" with whichever announcement happened to
// arrive first, and the rule would work or not depending on multicast timing. Every record for the
// address has to be tested.
//
// An mDNS name is also a label a device chose for itself — unverified and trivially spoofable by
// anything on the network. That is fine for "serve this panel more entities" and is not a security
// boundary, which is why discovery is observational everywhere else in this add-on too.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(DIR, '..', 'ha_ws_trim_proxy.mjs'), 'utf8');

// matchesConnection, with a stub discovery so the multi-record case can be driven directly.
function load(rowsByIp) {
  const fn = src.match(/function matchesConnection\(r, ctx\) \{[\s\S]*?\n\}/)?.[0];
  if (!fn) throw new Error('matchesConnection not found');
  const ctx = { discovery: { lookup: (ip) => rowsByIp[ip] || null } };
  vm.createContext(ctx);
  new vm.Script(fn).runInContext(ctx);
  return new vm.Script('matchesConnection').runInContext(ctx);
}

const PANEL = {
  '10.2.4.145': [
    { kind: 'Kiosk Satellite', name: 'Office Panel', version: '2026.9.53' },
    { kind: 'ESPHome', name: 'Office Panel', version: '2026.8.0' },
  ],
  '10.2.4.9': [{ kind: 'Google Cast', name: 'Kitchen display' }],
};
const rule = (over) => ({ dashboard: null, user: null, role: null, authProvider: null,
  client: null, userAgent: null, mdnsKind: null, entrypoint: null, ...over });

describe('matching a device kind over mDNS', () => {
  const matches = load(PANEL);

  it('matches the SECOND record as readily as the first', () => {
    // The whole point. This panel announces Kiosk Satellite first and ESPHome second.
    assert.equal(matches(rule({ mdnsKind: 'kiosk satellite' }), { ip: '10.2.4.145' }), true,
      'the first record matches');
    assert.equal(matches(rule({ mdnsKind: 'esphome' }), { ip: '10.2.4.145' }), true,
      'and so does the second — a device advertising twice is ordinary, not an edge case');
  });

  it('does not match a kind the device never announced', () => {
    assert.equal(matches(rule({ mdnsKind: 'ha-paneld' }), { ip: '10.2.4.145' }), false);
  });

  it('does not match an address that announced nothing', () => {
    // Unknown must mean "no", not "yes": this matcher widens what a client is served, so an
    // unknown device silently matching would hand entities to anything on the network.
    assert.equal(matches(rule({ mdnsKind: 'esphome' }), { ip: '10.9.9.9' }), false);
    assert.equal(matches(rule({ mdnsKind: 'esphome' }), { ip: null }), false);
  });

  it('is case-insensitive, because a person types the label they see', () => {
    assert.equal(matches(rule({ mdnsKind: 'kiosk satellite' }), { ip: '10.2.4.145' }), true);
  });
});

describe('matching the entry point a client arrived through', () => {
  const matches = load(PANEL);

  it('matches the entry point actually used', () => {
    assert.equal(matches(rule({ entrypoint: 'home-iot.coulson.io' }),
      { ip: '10.2.4.145', host: 'home-iot.coulson.io' }), true);
    assert.equal(matches(rule({ entrypoint: 'home-iot.coulson.io' }),
      { ip: '10.2.4.145', host: '10-2-3-6.coulson.io' }), false,
      'a different entry point on the same instance must not match');
  });

  it('does not match when the hostname is unknown', () => {
    assert.equal(matches(rule({ entrypoint: 'home-iot.coulson.io' }), { ip: '10.2.4.145' }), false);
  });

  it('is case-insensitive, as hostnames are', () => {
    assert.equal(matches(rule({ entrypoint: 'home-iot.coulson.io' }),
      { ip: '10.2.4.145', host: 'HOME-IOT.Coulson.IO' }), true);
  });
});

// `host` was the name `entrypoint` had for one release (2026.09.15.30).
//
// It is accepted for the same reason every other renamed key here is: a config written against a
// published release must not quietly stop working. "host" was replaced because it is ambiguous in
// this codebase — it already means the Home Assistant being proxied TO, the machine this runs on,
// and the hop in front of it.
describe('the entry point matcher under its old name', () => {
  it('still accepts a rule written as host', () => {
    const src2 = fs.readFileSync(path.join(DIR, '..', 'ha_ws_trim_proxy.mjs'), 'utf8');
    const compiled = src2.match(/entrypoint: \(\(\) => \{[\s\S]*?\}\)\(\),/)?.[0];
    assert.ok(compiled, 'entrypoint must be compiled from the rule');
    assert.match(compiled, /o\.entrypoint/, 'the new name is read');
    assert.match(compiled, /o\.host/, 'and the old one still is');
    assert.ok(compiled.indexOf('o.entrypoint') < compiled.indexOf('o.host'),
      'the new name wins when a config carries both');
  });
});
