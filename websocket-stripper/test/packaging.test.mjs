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

  it('the add-on version and the proxy version agree', () => {
    // They are set in two places by hand. When they drift, the panel and the update entity
    // disagree about what is running, which is exactly the confusion the panel exists to end.
    const config = fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8');
    const proxy = fs.readFileSync(path.join(ROOT, 'ha_ws_trim_proxy.mjs'), 'utf8');
    const inConfig = config.match(/^version:\s*"([^"]+)"/m)?.[1];
    const inProxy = proxy.match(/^const VERSION = '([^']+)';/m)?.[1];
    assert.ok(inConfig, 'config.yaml has a version');
    assert.equal(inProxy, inConfig, 'config.yaml and ha_ws_trim_proxy.mjs must state the same version');
  });
});
