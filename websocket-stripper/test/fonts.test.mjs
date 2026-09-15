// Keeping a font stylesheet for the dashboards that actually use the font.
//
// A CSS resource names no custom element, so the card matcher had nothing to match on and every
// stylesheet was dropped for every dashboard. That is right by accident when nothing uses the
// font, and WRONG SILENTLY when something does: a missing @font-face throws nothing and logs
// nothing — the dashboard just renders in the fallback face, and the first report is a person
// saying "it looks different". So the bias here is explicit: keep unless we can see it is unused.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(DIR, '..', 'ha_ws_trim_proxy.mjs'), 'utf8');

// The two pure functions, lifted out so they can be exercised directly.
function load() {
  const grab = (re, name) => {
    const m = src.match(re);
    if (!m) throw new Error(`could not find ${name}`);
    return m[0];
  };
  const code = [
    grab(/function fontsDeclaredIn\(body\) \{[\s\S]*?\n\}/, 'fontsDeclaredIn'),
    grab(/function fontTextFor\(cfg, themeNames, themeBlobs\) \{[\s\S]*?\n\}/, 'fontTextFor'),
  ].join('\n');
  const ctx = {};
  vm.createContext(ctx);
  new vm.Script(code).runInContext(ctx);
  return new vm.Script('({ fontsDeclaredIn, fontTextFor })').runInContext(ctx);
}

const { fontsDeclaredIn, fontTextFor } = load();

describe('what a stylesheet declares', () => {
  it('reads the family out of every @font-face block', () => {
    const css = `
      @font-face { font-family: 'Quicksand'; src: url(/local/a.woff2) format('woff2'); }
      @font-face { font-family: "Inter"; font-weight: 300 700; src: url(/local/b.woff2); }
      @font-face { font-family: Roboto; src: url(/local/c.woff2); }
    `;
    const got = [...fontsDeclaredIn(css)].sort();
    assert.deepEqual(got, ['inter', 'quicksand', 'roboto'],
      'quoted, double-quoted and bare families all count, lowercased');
  });

  it('ignores a font-family that is merely USED, not provided', () => {
    // A card bundle styling itself with a font does not provide that font. Treating this as a
    // declaration would keep almost every resource, since bundles set fonts constantly.
    const css = `.my-card { font-family: Quicksand, sans-serif; } h1 { font-family: Inter; }`;
    assert.deepEqual([...fontsDeclaredIn(css)], [],
      'only @font-face declares a font');
  });

  it('finds nothing in a JavaScript bundle', () => {
    assert.deepEqual([...fontsDeclaredIn('class Foo extends HTMLElement {}')], []);
  });
});

describe('where a dashboard can ask for a font', () => {
  it('sees a font named in the dashboard config', () => {
    const cfg = { views: [{ cards: [{ type: 'custom:x', style: 'font-family: Quicksand;' }] }] };
    const text = fontTextFor(cfg, new Set(), new Map([['__defaults__', '']]));
    assert.ok(text.includes('quicksand'));
  });

  it('sees a font set by a theme the dashboard asks for', () => {
    // The case that matters. A font is far more often set by a theme than by a card, so scanning
    // only the config would drop the stylesheet the theme depends on.
    const cfg = { views: [{ theme: 'my-theme', cards: [] }] };
    const themes = new Map([['my-theme', '{"primary-font-family":"quicksand, sans-serif"}']]);
    const text = fontTextFor(cfg, new Set(['my-theme']), themes);
    assert.ok(text.includes('quicksand'),
      'a font set by a theme must be visible to the resource trim');
  });

  it('sees a font set by the instance default theme, which applies everywhere', () => {
    const cfg = { views: [{ cards: [] }] };   // names no theme at all
    const themes = new Map([['__defaults__', '{"primary-font-family":"quicksand"}']]);
    const text = fontTextFor(cfg, new Set(), themes);
    assert.ok(text.includes('quicksand'),
      'a dashboard naming no theme still gets the default one');
  });

  it('does not invent a font from an unrelated theme', () => {
    const cfg = { views: [{ theme: 'mine', cards: [] }] };
    const themes = new Map([
      ['mine', '{"primary-font-family":"inter"}'],
      ['someone-elses', '{"primary-font-family":"quicksand"}'],
    ]);
    const text = fontTextFor(cfg, new Set(['mine']), themes);
    assert.ok(text.includes('inter'));
    assert.ok(!text.includes('quicksand'),
      'a theme this dashboard does not use must not keep a font for it');
  });
});

describe('the keep rule', () => {
  const rule = src.match(/if \(c\.fonts\?\.size\) \{[\s\S]*?\n  \}/)?.[0];

  it('keeps a font stylesheet when the font cannot be checked', () => {
    assert.ok(rule, 'the font branch must exist in keepResource');
    assert.match(rule, /if \(keys\.fontText == null\) return true;/,
      'unknown must mean keep — a wrongly dropped font changes the typeface with no error. '
      + 'Tested against null specifically: an empty string means "checked, no fonts named", '
      + 'and treating that as unknown keeps every bundle carrying an @font-face.');
  });

  it('is consulted before a stylesheet can fall through to the card tests', () => {
    const keep = src.match(/function keepResource\([\s\S]*?\n\}/)[0];
    const iFont = keep.indexOf('c.fonts?.size');
    const iCards = keep.indexOf('for (const k of keys.cards)');
    assert.ok(iFont !== -1 && iCards !== -1);
    assert.ok(iFont < iCards,
      'a font stylesheet has no card names, so it can only ever be dropped if the card tests run first');
  });
});

// The false positive that a whole-config search creates.
//
// Card bundles really do declare fonts with names like `inter` — voice-satellite-card.js on a
// live instance declares `google sans`, `vt323` and `inter`. Searching the raw config for "inter"
// finds it inside "printer", "interval" and "winter", so a dashboard mentioning a printer would
// have kept a 663KB bundle. That is not a small inefficiency: it is the add-on failing at the one
// job it has, triggered by an ordinary word.
describe('font matching does not fire on ordinary words', () => {
  const { fontTextFor } = load();
  const themes = new Map([['__defaults__', '']]);

  it('ignores a short family name appearing inside an unrelated word', () => {
    const cfg = { views: [{ cards: [
      { type: 'tile', entity: 'sensor.printer_status', name: 'Printer' },
      { type: 'tile', entity: 'sensor.winter_mode' },
      { type: 'history-graph', hours_to_show: 24, name: 'interval' },
    ] }] };
    const text = fontTextFor(cfg, new Set(), themes);
    assert.ok(!text.includes('inter'),
      'a printer, a winter mode and an interval must not keep a bundle that declares "inter"');
  });

  it('still matches when the font is genuinely named', () => {
    const cfg = { views: [{ cards: [{ type: 'custom:x',
      card_mod: { style: "ha-card { font-family: 'Inter', sans-serif !important; }" } }] }] };
    const text = fontTextFor(cfg, new Set(), themes);
    assert.ok(text.includes('inter'), 'a real font-family declaration must still match');
  });

  it('reads a font out of a theme variable, which is punctuated differently', () => {
    // A theme is JSON: "primary-font-family":"quicksand, sans-serif" — no CSS colon-space.
    const cfg = { views: [] };
    const t = new Map([['mine', '{"primary-font-family":"quicksand, sans-serif"}']]);
    const text = fontTextFor(cfg, new Set(['mine']), t);
    assert.ok(text.includes('quicksand'), 'theme font variables must still be read');
  });

  it('does not let one declaration bleed into the next', () => {
    // Values are joined with a separator so two adjacent declarations cannot form a family name
    // that neither of them contains.
    const cfg = { views: [{ cards: [
      { card_mod: { style: 'ha-card { font-family: noto; }' } },
      { card_mod: { style: 'ha-card { font-family: sans; }' } },
    ] }] };
    const text = fontTextFor(cfg, new Set(), themes);
    assert.ok(!text.includes('noto sans'),
      '"noto" followed by "sans" must not be read as the family "noto sans"');
  });
});

// "We could not check" and "we checked and found none" are different answers.
//
// Conflating them cost 1,940KB per dashboard on a live instance: a dashboard that simply does not
// style fonts produced an empty string, the keep rule read empty as falsy, treated it as "cannot
// check", and kept every bundle carrying an @font-face — mass-player-card (1092KB),
// voice-satellite-card (663KB) and swipe-card (183KB) restored to five dashboards that reference
// none of them. The regression was invisible in the unit tests and obvious in the byte counts.
describe('unknown fonts versus no fonts', () => {
  const rule = src.match(/if \(c\.fonts\?\.size\) \{[\s\S]*?\n  \}/)?.[0];

  it('keeps only when the answer is genuinely unknown, not when it is empty', () => {
    assert.ok(rule, 'the font branch must exist');
    assert.match(rule, /keys\.fontText == null/,
      'null (themes unreadable) means keep; an empty string means the dashboard names no font');
    assert.ok(!/if \(!keys\.fontText\)/.test(rule),
      'a falsy test treats "no fonts declared" as "cannot check" and keeps everything');
  });

  it('produces an empty string, not null, when a dashboard names no font', () => {
    const { fontTextFor } = load();
    const text = fontTextFor({ views: [{ cards: [{ type: 'tile', entity: 'light.x' }] }] },
      new Set(), new Map([['__defaults__', '']]));
    assert.equal(text, '', 'a checked dashboard with no fonts yields empty, which must drop');
    assert.notEqual(text, null);
  });
});
