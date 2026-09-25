// The Config tab's ownership affordances.
//
// This is a source-level check rather than a rendering one, because the failure it pins is not a
// wrong pixel: when booleans moved from rows into the tile grid, the "Use add-on config" button
// stayed behind in the row renderer. An option could then be adopted by the console with a click
// and never handed back, and the add-on's own Configuration tab went on being shadowed silently —
// which is exactly how an ESPHome switch that read "on" in the add-on did nothing at all.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const panel = fs.readFileSync(path.join(DIR, '..', 'panel.html'), 'utf8');

// The block that draws the grid of switches, from the filter that collects them to the line that
// puts the section on the page.
function tileSection() {
  const start = panel.indexOf("const bools = d.options.filter((o) => o.type === 'bool');");
  assert.ok(start > 0, 'the tile grid is gone — this test is about it');
  const end = panel.indexOf('host.appendChild(box);', start);
  assert.ok(end > start);
  return panel.slice(start, end);
}

describe('a setting the console owns can be handed back', () => {
  it('offers a release control for booleans, which are tiles and have no row', () => {
    const block = tileSection();
    assert.match(block, /save\(o, 'release'\)/,
      'a boolean adopted by a click has no way back to the add-on Configuration tab');
  });

  it('only offers it when the console actually owns something, and can write', () => {
    const block = tileSection();
    assert.match(block, /o\.source === 'console'/, 'the hand-back line must be conditional');
    assert.match(block, /d\.editableHere && d\.writable/,
      'a read-only console must not offer a button that will be refused');
  });

  it('marks an owned tile, so the grid can say what a row said with its "set here" tag', () => {
    const i = panel.indexOf('function configTile(');
    const tile = panel.slice(i, panel.indexOf('\n}', i));
    assert.match(tile, /o\.source === 'console'/);
    assert.match(tile, /classList\.add\('owned'\)/);
    assert.match(panel, /\.cfgtile\.owned::after/, 'the marker needs a style or it shows nothing');
  });
});
