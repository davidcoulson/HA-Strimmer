// The Dockerfile COPYs a hand-written list of files, so adding a module and forgetting to add
// it there produces an image that builds cleanly, passes every test, deploys, and then dies on
// startup with ERR_MODULE_NOT_FOUND. Nothing else in the suite can see that, because the tests
// run against the source tree where the file obviously exists.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');

// Every relative import reachable from the entrypoint, followed transitively — a module that
// only imports another module still has to be in the image.
function localImports(entry, seen = new Set()) {
  const abs = path.resolve(ROOT, entry);
  if (seen.has(abs)) return seen;
  seen.add(abs);
  const src = fs.readFileSync(abs, 'utf8');
  for (const m of src.matchAll(/^\s*import\s[^'"]*['"](\.\.?\/[^'"]+)['"]/gm)) {
    localImports(path.resolve(path.dirname(abs), m[1]), seen);
  }
  return seen;
}

describe('the image contains everything the proxy imports', () => {
  it('every local module the entrypoint reaches is COPYed into the image', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const copied = new Set(
      dockerfile.split('\n')
        .filter((l) => /^COPY\s/.test(l))
        .flatMap((l) => l.replace(/^COPY\s+/, '').split(/\s+/))
        .filter((f) => f && f !== './' && f !== '.'),
    );

    const needed = [...localImports('ha_ws_trim_proxy.mjs')].map((p) => path.relative(ROOT, p));
    const missing = needed.filter((f) => !copied.has(f));
    assert.deepEqual(missing, [],
      `these modules are imported but never COPYed, so the add-on will start and immediately `
      + `exit with ERR_MODULE_NOT_FOUND: ${missing.join(', ')}`);
  });

  it('the panel the stats server reads is in the image too', () => {
    // Not an import, so the walk above cannot see it: it is read at runtime by path, and its
    // absence degrades to a broken panel rather than a crash — quieter, and easier to miss.
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    assert.ok(/^COPY\s.*\bpanel\.html\b/m.test(dockerfile), 'panel.html must be COPYed');
  });

  // Version agreement across config.yaml / package.json / VERSION is already covered by
  // config.test.mjs; deliberately not repeated here.
});

// panel.html is the one shipped file nothing else in the suite executes: it is served as a blob
// and only ever runs in a browser. A syntax error in it therefore survives a fully green suite
// and a successful deploy, and shows up as a console that renders its shell and then sits blank —
// which reads as "the add-on is broken", not "the panel has a typo". Parsing it is cheap.
describe('the panel', () => {
  it('parses as JavaScript', async () => {
    const vm = await import('node:vm');
    const html = fs.readFileSync(path.join(ROOT, 'panel.html'), 'utf8');
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(blocks.length, 'panel.html must contain a script block');
    for (const [, code] of blocks) {
      assert.doesNotThrow(() => new vm.Script(code), 'panel.html has a syntax error');
    }
  });

  it('renders every table cell as text rather than markup', () => {
    // Hostnames, user agents and dashboard names all come from whatever connected, so the panel
    // treats them as hostile. rows() is the single chokepoint that enforces it; innerHTML on a
    // value anywhere else would quietly reopen the hole.
    const html = fs.readFileSync(path.join(ROOT, 'panel.html'), 'utf8');
    const script = html.slice(html.indexOf('<script>'));
    const lines = script.split('\n');
    const bad = [];
    lines.forEach((line, i) => {
      const m = line.match(/\.innerHTML\s*=\s*(.+)/);
      if (!m) return;
      const rhs = m[1].trim();
      // Clearing a container is not injection.
      if (/^(''|""|``)\s*;/.test(rhs)) return;
      // A deliberate exception must say so on the preceding lines and explain why it is safe.
      if (lines.slice(Math.max(0, i - 4), i).some((l) => l.includes('safe-html:'))) return;
      bad.push(`line ${i + 1}: ${rhs}`);
    });
    assert.deepEqual(bad, [],
      `assign text, not innerHTML (or justify it with a "safe-html:" comment): ${bad.join(' | ')}`);
  });
});
