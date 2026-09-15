// Configuration the panel owns, alongside Supervisor's own options.
//
// The property that matters most here is that adopting a key does not change what it does, and
// that nothing the panel writes can shadow the options needed to fix a broken panel.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readStore, writeStore, adopt, release, effectiveOptions, ownership, BOOTSTRAP_KEYS, STORE_VERSION,
} from '../config_store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfgstore-'));
const YAML = { dashboards: ['lovelace'], trim_themes: false, log_level: 'info', port: 9123 };

describe('config store', () => {
  it('owns nothing until something is adopted, so a fresh install behaves exactly as before', () => {
    const d = tmp();
    const s = readStore(d);
    assert.deepEqual(s.managed, {});
    assert.deepEqual(effectiveOptions(YAML, s), YAML, 'every option still comes from add-on options');
  });

  // Adoption seeds from the value already in effect. If it did not, taking ownership of an option
  // would silently change what the add-on does — the panel would appear to have "reset" it.
  it('seeds an adopted key from its current add-on value', () => {
    const s = adopt(readStore(tmp()), 'trim_themes', undefined, YAML);
    assert.equal(s.managed.trim_themes, false, 'seeded from YAML, not from a default');
    assert.equal(effectiveOptions(YAML, s).trim_themes, false, 'and behaviour is unchanged');
  });

  it('lets a managed value win, and hands it back on release', () => {
    let s = adopt(readStore(tmp()), 'trim_themes', true, YAML);
    assert.equal(effectiveOptions(YAML, s).trim_themes, true, 'panel value wins');
    s = release(s, 'trim_themes');
    assert.equal(effectiveOptions(YAML, s).trim_themes, false, 'add-on option is authoritative again');
    assert.ok(!('trim_themes' in s.managed));
  });

  // The panel must never be able to shadow the options that decide how the process binds and
  // reaches Home Assistant — those have to stay fixable from the Configuration tab precisely when
  // the panel is the thing that is broken.
  it('refuses to adopt a setup option', () => {
    for (const k of BOOTSTRAP_KEYS) {
      assert.throws(() => adopt(readStore(tmp()), k, 'x', YAML), /setup option/,
        `${k} must not be adoptable`);
    }
  });

  it('ignores a setup option smuggled into the file on disk', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({
      version: STORE_VERSION, managed: { port: 1234, trim_themes: true },
    }));
    const warns = [];
    const s = readStore(d, (m) => warns.push(m));
    assert.ok(!('port' in s.managed), 'a hand-edited file must not be able to move the listen port');
    assert.equal(s.managed.trim_themes, true, 'but a normal key is still honoured');
    assert.equal(effectiveOptions(YAML, s).port, 9123);
    assert.match(warns.join(' '), /port/);
  });

  // A bad store must cost the panel, never the proxy.
  it('falls back to add-on options when the file is corrupt, rather than failing', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'config.json'), '{ this is not json');
    const warns = [];
    assert.deepEqual(effectiveOptions(YAML, readStore(d, (m) => warns.push(m))), YAML);
    assert.match(warns.join(' '), /could not read/);
  });

  it('refuses a store written by a newer version instead of half-applying it', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({
      version: STORE_VERSION + 1, managed: { trim_themes: true },
    }));
    const warns = [];
    const s = readStore(d, (m) => warns.push(m));
    assert.deepEqual(s.managed, {}, 'a downgrade must not act on config it may not understand');
    assert.match(warns.join(' '), /newer version/);
  });

  it('survives a round trip through the file', () => {
    const d = tmp();
    writeStore(d, adopt(readStore(d), 'trim_themes', true, YAML));
    assert.equal(readStore(d).managed.trim_themes, true);
  });

  it('reports which source answers for what', () => {
    const s = adopt(readStore(tmp()), 'trim_themes', true, YAML);
    const o = ownership(YAML, s);
    assert.deepEqual(o.managed, ['trim_themes']);
    assert.ok(o.fromYaml.includes('dashboards') && o.fromYaml.includes('port'));
    assert.ok(!o.fromYaml.includes('trim_themes'), 'a key cannot be claimed by both');
  });
});
