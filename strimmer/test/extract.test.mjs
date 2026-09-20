// Unit tests for lovelace_extract.mjs — pure, no network.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities, isEntityId } from '../lovelace_extract.mjs';
import { STATES } from './fixtures.mjs';

const setOf = (cfg, states = STATES, opts) => new Set(extractEntities(cfg, states, opts).entities);
const view = (cards) => ({ views: [{ path: 'main', cards }] });

test('isEntityId accepts valid ids, rejects junk', () => {
  assert.ok(isEntityId('light.kitchen'));
  assert.ok(isEntityId('binary_sensor.front_door'));
  assert.ok(!isEntityId('Light.Kitchen'));   // uppercase
  assert.ok(!isEntityId('kitchen'));          // no domain
  assert.ok(!isEntityId('light.'));           // no object id
  assert.ok(!isEntityId(42));
});

test('standard entity-bearing keys', () => {
  const got = setOf(view([
    { type: 'entity', entity: 'light.living_room' },
    { type: 'entities', entities: ['sensor.temperature', 'sensor.humidity'] },
    { type: 'picture-glance', camera_image: 'camera.front', camera_entity: 'camera.front' },
    { type: 'x', entity_id: 'switch.fan' },
    { type: 'y', entity_id: ['light.kitchen', 'light.bedroom'] },
  ]));
  assert.deepEqual(got, new Set([
    'light.living_room', 'sensor.temperature', 'sensor.humidity',
    'camera.front', 'switch.fan', 'light.kitchen', 'light.bedroom',
  ]));
});

test('entities[] of objects recurses (entity: key inside)', () => {
  const got = setOf(view([
    { type: 'entities', entities: [{ entity: 'light.living_room' }, { entity: 'switch.fan', name: 'Fan' }] },
  ]));
  assert.deepEqual(got, new Set(['light.living_room', 'switch.fan']));
});

test('deeply nested stacks / grid / sections are walked', () => {
  const got = setOf(view([
    { type: 'vertical-stack', cards: [
      { type: 'horizontal-stack', cards: [
        { type: 'grid', cards: [ { type: 'entity', entity: 'sensor.temperature' } ] },
      ] },
    ] },
    { type: 'custom:mushroom-something', entity: 'light.bedroom' },
  ]));
  assert.deepEqual(got, new Set(['sensor.temperature', 'light.bedroom']));
});

test('picture-elements: entities inside elements[] are found', () => {
  const got = setOf(view([
    { type: 'picture-elements', image: '/x.png', elements: [
      { type: 'state-icon', entity: 'binary_sensor.front_door' },
      { type: 'state-label', entity: 'sensor.humidity' },
    ] },
  ]));
  assert.deepEqual(got, new Set(['binary_sensor.front_door', 'sensor.humidity']));
});

test('auto-entities: include by domain expands against live states', () => {
  const got = setOf(view([
    { type: 'custom:auto-entities', card: { type: 'entities' }, filter: { include: [{ domain: 'binary_sensor' }] } },
  ]));
  assert.deepEqual(got, new Set(['binary_sensor.front_door', 'binary_sensor.back_door']));
});

test('auto-entities: include by entity_id glob', () => {
  const got = setOf(view([
    { type: 'custom:auto-entities', card: { type: 'entities' }, filter: { include: [{ entity_id: 'sensor.decoy_*' }] } },
  ]));
  assert.deepEqual(got, new Set(['sensor.decoy_power', 'sensor.decoy_energy']));
});

test('auto-entities: exclude wins over include', () => {
  const got = setOf(view([
    { type: 'custom:auto-entities', card: { type: 'entities' }, filter: {
      include: [{ domain: 'light' }],
      exclude: [{ entity_id: 'light.decoy' }],
    } },
  ]));
  assert.ok(got.has('light.living_room'));
  assert.ok(!got.has('light.decoy'));
});

test('auto-entities: explicit entity in include (not a filter)', () => {
  const got = setOf(view([
    { type: 'custom:auto-entities', card: { type: 'entities' }, filter: { include: [{ entity_id: 'switch.fan' }] } },
  ]));
  assert.deepEqual(got, new Set(['switch.fan']));
});

test('viewPath restricts extraction to a single view', () => {
  const cfg = { views: [
    { path: 'a', cards: [{ type: 'entity', entity: 'light.living_room' }] },
    { path: 'b', cards: [{ type: 'entity', entity: 'light.kitchen' }] },
  ] };
  assert.deepEqual(setOf(cfg, STATES, { viewPath: 'b' }), new Set(['light.kitchen']));
});

test('malformed auto-entities keys (e.g. "domain 1") do not throw', () => {
  // The home-status Home view has keys like "domain 1" from the visual editor.
  const cfg = view([
    { type: 'custom:auto-entities', card: { type: 'entities' }, filter: {
      include: [{ 'domain 1': 'light', domain: 'switch' }],
    } },
  ]);
  let res;
  assert.doesNotThrow(() => { res = extractEntities(cfg, STATES); });
  // the valid `domain: switch` part still resolves
  assert.ok(new Set(res.entities).has('switch.fan'));
});

test('label/area/device/integration are recognized keys (not flagged unsupported)', () => {
  // Post-#4: these resolve against registries; without registries they simply match
  // nothing, but they are no longer reported as unsupported.
  const cfg = view([
    { type: 'custom:auto-entities', card: { type: 'entities' }, filter: {
      include: [{ options: {}, label: { label: '1st_floor', active_choice: 'label' } }],
    } },
  ]);
  const res = extractEntities(cfg, STATES);   // no registries
  assert.deepEqual(res.entities, []);
  assert.ok(!res.unsupported.some((u) => u.includes('label')));
});

test('exact (non-overInclude) state filter still yields only current-state matches', () => {
  const got = setOf(view([
    { type: 'custom:auto-entities', card: { type: 'entities' }, filter: { include: [{ domain: 'light', state: 'on' }] } },
  ]));
  assert.ok(got.has('light.living_room'));   // on
  assert.ok(!got.has('light.kitchen'));       // off
});

test('overInclude ignores volatile state, so an off light is still forwarded', () => {
  const got = setOf(view([
    { type: 'custom:auto-entities', card: { type: 'entities' }, filter: { include: [{ domain: 'light', state: 'on' }] } },
  ]), STATES, { overInclude: true });
  assert.ok(got.has('light.living_room'));   // on
  assert.ok(got.has('light.kitchen'));        // off -> still forwarded (card shows it when on)
});

test('overInclude exclude never drops on a volatile-only condition', () => {
  const got = setOf(view([
    { type: 'custom:auto-entities', card: { type: 'entities' }, filter: {
      include: [{ domain: 'light' }],
      exclude: [{ state: 'off' }],   // volatile-only exclude must NOT remove kitchen
    } },
  ]), STATES, { overInclude: true });
  assert.ok(got.has('light.kitchen'));   // off now, but might turn on -> keep it
});
