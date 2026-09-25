// Every button in the console is an icon, named by a tooltip — the rule Spatial Context set and
// Sextant shares.
//
// This is a source-level check on purpose. The failure it guards against is not a broken page:
// it is a new feature arriving with `btn.textContent = 'Do the thing'`, which renders perfectly
// well and quietly breaks the one visual rule the whole console is built on. That happened
// twelve times over before this rework; the test is what stops a thirteenth.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const panel = fs.readFileSync(path.join(DIR, '..', 'panel.html'), 'utf8');
const script = panel.slice(panel.indexOf('<script>'), panel.lastIndexOf('</script>'));
const markup = panel.slice(panel.indexOf('<body'), panel.indexOf('<script>'));

describe('buttons are icons with tooltips', () => {
  it('builds buttons in exactly three sanctioned places', () => {
    // iconBtn() for every action; a menu row, whose text is the menu; and a config tile, which is
    // a labelled toggle rather than an action. Anything else is a text button in the making.
    const sites = [...script.matchAll(/createElement\('button'\)/g)].map((m) => {
      const before = script.slice(0, m.index);
      const fn = [...before.matchAll(/(?:function\s+(\w+)|const\s+(\w+)\s*=\s*\()/g)].pop();
      return fn ? (fn[1] || fn[2]) : '?';
    });
    assert.deepEqual(sites.sort(), ['configTile', 'iconBtn', 'item'].sort(),
      `a button is being built outside iconBtn(): ${sites.join(', ')} — use iconBtn(icon, tip, onclick)`);
  });

  it('never writes text into a button', () => {
    // The old pattern, in every form it took: a label set on creation, or progress text written
    // into the button while a request ran ("pinning…", "resuming…").
    const offenders = [...script.matchAll(/\b(btn|b|x|yes|no|del|add)\.textContent\s*=\s*['`]/g)]
      .map((m) => script.slice(m.index, script.indexOf('\n', m.index)).trim());
    assert.deepEqual(offenders, [], `text written into a button:\n  ${offenders.join('\n  ')}`);
  });

  it('gives every static button a tooltip, unless it is a tab or a menu row', () => {
    const buttons = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    assert.ok(buttons.length >= 10, `expected the header and heading buttons, found ${buttons.length}`);
    for (const [, attrs, inner] of buttons) {
      if (/data-tab=/.test(attrs) || /menu-item/.test(attrs)) continue;
      assert.match(attrs, /data-tip="[^"]+"/, `a button with no tooltip: <button${attrs}>`);
      const text = inner.replace(/<[^>]+>/g, '').trim();
      assert.equal(text, '', `a button with visible text "${text}": <button${attrs}>`);
    }
  });

  it('names every icon button for a screen reader as well as the pointer', () => {
    // A tooltip is a hover affordance. aria-label is what is announced; without it a button with
    // no text is read out as "button".
    const setTip = script.slice(script.indexOf('function setTip('), script.indexOf('function iconBtn('));
    assert.match(setTip, /aria-label/, 'setTip() must set aria-label beside the tooltip');
    assert.match(script, /querySelectorAll\('\[data-tip\]'\)[\s\S]{0,200}aria-label/,
      'static [data-tip] markup must get an aria-label too');
  });

  it('declares the tooltip state before anything can read it', () => {
    // setTip() reads tipFor; a `let` read before its line runs throws. The same mistake took the
    // add-on down in 2026.09.25.3, so it is worth one assertion here.
    const decl = script.indexOf('let tipFor');
    assert.ok(decl > 0, 'tipFor is gone');
    assert.ok(decl < script.indexOf('function setTip('), 'tipFor must be declared above setTip()');
  });
});
