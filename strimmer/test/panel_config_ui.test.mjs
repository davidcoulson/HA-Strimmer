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
    // Closed BEFORE the commit: left open, a second click saves again from the same captured
    // list and replaces the first entry.
    assert.match(c, /suggestMenu\(add, o\.suggest, fixed, \(v\) => \{ sm\.close\(\); add\.value = v; commit\(\); \}\)/,
      'a chosen suggestion must close the menu, then be saved like a typed value');
  });

  it('cannot be reopened by a search that was still pending when a choice was made', () => {
    // The debounce timer and any in-flight answer outlive the click. Either one reopening the
    // menu during a slow save puts back rows that save from the list as it was before.
    const close = fn('suggestMenu').match(/const close = \(\) => \{[\s\S]*?\n  \};/)?.[0];
    assert.ok(close, 'the menu must have a close');
    assert.match(close, /clearTimeout\(timer\);/, 'a debounced search must be cancelled');
    assert.match(close, /seq\+\+;/, 'an answer in flight must be made stale');
  });

  it('keeps unsaved text when another setting is saved', () => {
    // Every save redraws the tab. A box that does not save on blur must get its text back.
    assert.match(c, /add\.value = LIST_DRAFTS\[o\.key\] \|\| '';/);
    assert.match(c, /save\(o, 'adopt', \[\.\.\.values, v\], \(\) => \{ delete LIST_DRAFTS\[o\.key\]; \}\)/,
      'the draft is dropped only when its own save succeeds');
    assert.match(panel, /if \(r\.ok\) \{\n\s+onOk\?\.\(\);/, 'save must call back on success only');
  });

  it('tells a screen reader about the menu and the highlighted row', () => {
    const m = fn('suggestMenu');
    for (const want of [/'role', 'listbox'/, /'role', 'combobox'/, /'role', 'option'/, /'aria-controls', menu\.id/,
      /'aria-expanded', 'true'/, /'aria-activedescendant', opts\[cursor\]\.id/]) assert.match(m, want);
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
