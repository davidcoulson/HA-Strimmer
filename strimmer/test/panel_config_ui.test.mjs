// The Settings tab's ownership affordances.
//
// Source-level: the failure pinned is not a wrong pixel. When booleans moved out of rows into a
// separate renderer, the "use add-on setting" button stayed behind, so an option could be adopted
// by the console with a click and never handed back — the add-on's Configuration tab then went on
// being shadowed silently.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const panel = fs.readFileSync(path.join(DIR, '..', 'panel.html'), 'utf8');

function fn(name) {
  const i = panel.indexOf(`function ${name}(`);
  assert.ok(i > 0, `${name}() is gone — this test is about it`);
  return panel.slice(i, panel.indexOf('\n}', i));
}

describe('a setting the console owns can be handed back', () => {
  it('offers a release control for switches, which have no row of their own', () => {
    assert.match(fn('handBack'), /save\(o, 'release'\)/,
      'a boolean adopted by a click has no way back to the add-on Configuration tab');
  });

  it('only offers it when the console owns something, and can write', () => {
    const b = fn('handBack');
    assert.match(b, /o\.source === 'console'/, 'the hand-back line must be conditional');
    assert.match(b, /d\.editableHere && d\.writable/, 'a read-only console must not offer a refused button');
  });

  it('marks an owned switch, so it says what a row said with its "set here" tag', () => {
    const s = fn('configSwitch');
    assert.match(s, /o\.source === 'console'/);
    assert.match(s, /classList\.add\('owned'\)/);
    assert.match(panel, /\.owned-dot\s*\{/, 'the marker needs a style or it shows nothing');
  });
});

// Issue #13: the Settings lists offer what the instance has instead of asking for ids from memory.
describe('a Settings list searches the instance', () => {
  const c = fn('chipList');

  it('puts the search menu on the add box when the server says what to offer', () => {
    assert.match(c, /if \(o\.suggest\) \{/);
    assert.match(c, /suggestMenu\(add, o\.suggest, fixed, \(v\) => \{ add\.value = v; commit\(\); \}\)/,
      'a chosen suggestion must be saved like a typed value');
  });

  it('does not save half-typed search text when the box loses focus', () => {
    const [searching, plain] = c.slice(c.indexOf('if (o.suggest) {')).split('} else {');
    assert.doesNotMatch(searching, /onblur/, 'a search box abandoned mid-word must not become an entry');
    assert.match(plain, /add\.onblur = commit;/, 'a plain box still keeps what was typed');
  });

  it('still takes a value no list could offer', () => {
    // suggestMenu's Enter falls back to the raw text; overrides_ui.test.mjs pins that handler.
    assert.match(fn('suggestMenu'), /else add\(input\.value\)/);
  });
});
