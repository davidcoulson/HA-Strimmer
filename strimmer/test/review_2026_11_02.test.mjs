// Extractor gaps found in the 2026-11-02 review (issue #19 investigation).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities } from '../lovelace_extract.mjs';
import { STATES, REGISTRIES } from './fixtures.mjs';

// Allowlist mode, exactly how ha_ws_trim_proxy.mjs calls the extractor.
const run = (card) => extractEntities(
  { views: [{ cards: [card] }] },
  STATES,
  { registries: REGISTRIES, overInclude: true },
).entities;

test('an exclude with a live state test does not drop every entity of its domain',
  () => {
    // "every sensor except the unavailable ones". The state half is volatile, so an allowlist
    // cannot apply it; applying only the domain half removes every sensor, healthy ones included.
    const got = run({
      type: 'custom:auto-entities',
      filter: { include: [{ domain: 'sensor' }], exclude: [{ domain: 'sensor', state: 'unavailable' }] },
    });
    assert.ok(got.includes('sensor.temperature'), 'sensor.temperature was excluded by a state-only condition');
  });

test('an area card forwards the entities in its area',
  () => {
    // light.kitchen is in the kitchen area through its device and appears nowhere else.
    const got = run({ type: 'area', area: 'kitchen' });
    assert.ok(got.includes('light.kitchen'), 'area card named kitchen but light.kitchen was not forwarded');
  });
