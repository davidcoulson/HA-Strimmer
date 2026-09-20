// Registry-backed auto-entities resolution — the #4 fix (area/label/device/integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities, buildRegistryCtx, splitDeviceEntities } from '../lovelace_extract.mjs';
import { STATES, REGISTRIES } from './fixtures.mjs';

const view = (cards) => ({ views: [{ path: 'main', cards }] });
const auto = (filter) => view([{ type: 'custom:auto-entities', card: { type: 'entities' }, filter }]);
const setOf = (filter) => new Set(extractEntities(auto(filter), STATES, { registries: REGISTRIES, overInclude: true }).entities);

test('label filter (the #4 repro: visual-editor object form) resolves to labeled entities', () => {
  // {label: {label: "1st_floor", active_choice: "label"}} — living_room + bedroom carry it.
  const got = setOf({ include: [{ options: {}, label: { label: '1st_floor', active_choice: 'label' } }] });
  assert.deepEqual(got, new Set(['light.living_room', 'light.bedroom']));
});

test('label filter accepts a plain string value and the label id', () => {
  assert.deepEqual(setOf({ include: [{ label: '1st_floor' }] }), new Set(['light.living_room', 'light.bedroom']));
  assert.deepEqual(setOf({ include: [{ label: 'lbl_1st' }] }), new Set(['light.living_room', 'light.bedroom']));
});

test('area filter resolves by area name and area id', () => {
  // living_room area: light.living_room (explicit) + sensor.temperature (via its device).
  assert.deepEqual(setOf({ include: [{ area: 'Living Room' }] }), new Set(['light.living_room', 'sensor.temperature']));
  assert.deepEqual(setOf({ include: [{ area: 'living_room' }] }), new Set(['light.living_room', 'sensor.temperature']));
});

test('area is inherited from the entity device when the entity has no explicit area', () => {
  // light.kitchen has no area_id but its device dev_kitchen_light is in the kitchen area.
  assert.deepEqual(setOf({ include: [{ area: 'kitchen' }] }), new Set(['light.kitchen']));
});

test('integration filter resolves by platform', () => {
  assert.deepEqual(setOf({ include: [{ integration: 'esphome' }] }), new Set(['switch.fan']));
  assert.deepEqual(setOf({ include: [{ integration: 'hue' }] }), new Set(['light.living_room', 'light.kitchen', 'light.bedroom']));
});

test('device filter resolves by device id', () => {
  assert.deepEqual(setOf({ include: [{ device: 'dev_thermo' }] }), new Set(['sensor.temperature']));
});

test('exclude by area removes structural matches', () => {
  const got = setOf({ include: [{ integration: 'hue' }], exclude: [{ area: 'kitchen' }] });
  assert.ok(got.has('light.living_room'));
  assert.ok(!got.has('light.kitchen'));   // excluded by area
});

test('label + state together: overInclude keeps the label set regardless of state', () => {
  // include entities labeled 1st_floor AND currently on -> overInclude drops the state test.
  const got = setOf({ include: [{ label: '1st_floor', state: 'on' }] });
  assert.deepEqual(got, new Set(['light.living_room', 'light.bedroom']));   // bedroom on, living_room on; state ignored anyway
});

test('unresolvable filters (no registry) yield nothing but do not throw', () => {
  const res = extractEntities(auto({ include: [{ area: 'Living Room' }] }), STATES, { overInclude: true });
  assert.deepEqual(res.entities, []);
});

// A card configured with a DEVICE rather than with entities.
//
// Found on a live instance: `custom:ha-bambulab-print_status-card` carries
// `printer: <device id>` and looks up that device's entities itself, in the browser. Nothing in
// the card config is an entity_id, so the structural walk found none and the dashboard resolved
// to just its two lights — the printer's 57 entities were stripped and the card rendered empty.
// That reads as a broken card, not as a trimming problem, which is what makes it worth a test.
const DEV = '43f1e9fddd670256ced58c9fe7971e41';
const DEV_REGS = {
  areas: [], labels: [],
  devices: [{ id: DEV, name: 'H2S_0938AC572400463' }],
  entities: [
    { entity_id: 'sensor.printer_print_status', device_id: DEV, platform: 'bambu_lab' },
    { entity_id: 'sensor.printer_print_progress', device_id: DEV, platform: 'bambu_lab' },
    { entity_id: 'camera.printer_camera', device_id: DEV, platform: 'bambu_lab' },
    { entity_id: 'light.unrelated', device_id: 'a'.repeat(32), platform: 'hue' },
  ],
};
const devSetOf = (cards) => new Set(
  extractEntities(view(cards), [], { registries: DEV_REGS }).entities,
);

test('a card naming a device pulls in that device entities', () => {
  const got = devSetOf([{ type: 'custom:ha-bambulab-print_status-card', printer: DEV, style: 'simple' }]);
  assert.deepEqual(got, new Set([
    'sensor.printer_print_status', 'sensor.printer_print_progress', 'camera.printer_camera',
  ]));
});

test('the device key name is not assumed — any key holding a real device id counts', () => {
  // `printer` here, `device` elsewhere, something else in the next card. Matching on the VALUE
  // being a registered device is what makes this work for cards nobody has seen yet.
  for (const key of ['printer', 'device', 'device_id', 'target_device']) {
    assert.ok(devSetOf([{ type: 'custom:whatever', [key]: DEV }]).has('sensor.printer_print_status'),
      `key ${key} should resolve`);
  }
});

test('a list of device ids resolves too', () => {
  const got = devSetOf([{ type: 'custom:multi', devices: [DEV] }]);
  assert.ok(got.has('camera.printer_camera'));
});

test('a device id nested in a stack resolves via the normal walk', () => {
  const got = devSetOf([{ type: 'vertical-stack', cards: [{ type: 'custom:x', printer: DEV }] }]);
  assert.ok(got.has('sensor.printer_print_status'));
});

test('a 32-hex string that is NOT a registered device adds nothing', () => {
  // Shape alone must never be enough — it has to exist in the registry.
  const got = devSetOf([{ type: 'custom:x', printer: 'f'.repeat(32) }]);
  assert.deepEqual(got, new Set());
});

test('device resolution does not drag in entities of other devices', () => {
  const got = devSetOf([{ type: 'custom:x', printer: DEV }]);
  assert.ok(!got.has('light.unrelated'), 'only the named device expands');
});

// Excluding entity categories when a device is expanded.
//
// A device carries far more than a card renders — Home Assistant's own `config` and `diagnostic`
// labels mark the controls that configure it and the readings that describe its health. This is
// opt-in, never default: whether a given card renders a diagnostic sensor is not knowable from
// here, and a wrongly dropped entity blanks part of a card with no error anywhere.
const CAT_REGS = {
  areas: [], labels: [],
  devices: [{ id: DEV, name: 'Robot 1' }],
  entities: [
    { entity_id: 'vacuum.robot', device_id: DEV, platform: 'litterrobot', entity_category: null },
    { entity_id: 'sensor.robot_waste_drawer', device_id: DEV, platform: 'litterrobot', entity_category: null },
    { entity_id: 'select.robot_panel_brightness', device_id: DEV, platform: 'litterrobot', entity_category: 'config' },
    { entity_id: 'update.robot_firmware', device_id: DEV, platform: 'litterrobot', entity_category: 'config' },
    { entity_id: 'sensor.robot_last_seen', device_id: DEV, platform: 'litterrobot', entity_category: 'diagnostic' },
  ],
};
const catSetOf = (exclude) => new Set(extractEntities(
  view([{ type: 'custom:whisker-card', device_id: DEV }]), [],
  { registries: CAT_REGS, excludeDeviceCategories: exclude },
).entities);

test('by default a device expansion keeps every category', () => {
  assert.equal(catSetOf([]).size, 5, 'no filtering unless asked for — a dropped entity fails silently');
});

test('excluding config and diagnostic leaves the primary entities', () => {
  assert.deepEqual(catSetOf(['config', 'diagnostic']),
    new Set(['vacuum.robot', 'sensor.robot_waste_drawer']));
});

test('excluding only config keeps diagnostics', () => {
  const got = catSetOf(['config']);
  assert.ok(got.has('sensor.robot_last_seen'), 'diagnostic survives when only config is excluded');
  assert.ok(!got.has('update.robot_firmware'), 'config does not');
});

test('the device split is reported so the trade-off can be seen before it is taken', () => {
  const rows = buildRegistryCtx(CAT_REGS).byDevice.get(DEV);
  const split = splitDeviceEntities(rows);
  assert.equal(split.primary.length, 2);
  assert.equal(split.config.length, 2);
  assert.equal(split.diagnostic.length, 1);
});

test('extraction reports which devices a card named', () => {
  const res = extractEntities(view([{ type: 'custom:whisker-card', device_id: DEV }]), [], { registries: CAT_REGS });
  assert.deepEqual(res.devices, [DEV]);
});

// Sub-devices: a device that is PART of another, folded into its parent's entity list.
//
// The measured case is the Bambu print-status card. It is configured with the printer's device
// id, then looks for the AMS units and spool itself — devices Home Assistant links back to the
// printer with `via_device_id`. Nothing in the dashboard names them, so their entities never
// reached the allowlist and their rows were trimmed out of the device registry; the card rendered
// nothing, with no error on either side.
const ctxOf = (devices, entities) => buildRegistryCtx({ devices, entities });
const idsFor = (ctx, id) => (ctx.byDevice.get(id) || []).map((r) => r.id).sort();

test('a device expands to include its named sub-devices', () => {
  const ctx = ctxOf(
    [
      { id: 'p', name: 'H2S_0938AC572400463' },
      { id: 'a1', name: 'H2S_0938AC572400463_AMS_1', via_device_id: 'p' },
      { id: 'sp', name: 'H2S_0938AC572400463_ExternalSpool', via_device_id: 'p' },
    ],
    [
      { entity_id: 'sensor.stage', device_id: 'p' },
      { entity_id: 'sensor.ams_humidity', device_id: 'a1' },
      { entity_id: 'sensor.spool', device_id: 'sp' },
    ],
  );
  assert.deepEqual(idsFor(ctx, 'p'), ['sensor.ams_humidity', 'sensor.spool', 'sensor.stage']);
});

// The rule that makes the above safe. `via_device_id` means "routes through", which Home
// Assistant uses for hubs as well as sub-units: measured on a real instance it makes a Z-Wave
// controller the parent of 75 devices and 2,870 entities. Following it on its own would hand a
// wall panel an entire Z-Wave network.
test('a hub does not adopt the devices that merely route through it', () => {
  const ctx = ctxOf(
    [
      { id: 'hub', name: 'Zigbee2MQTT Bridge' },
      { id: 'z1', name: 'Kitchen Motion', via_device_id: 'hub' },
      { id: 'z2', name: 'Hall Motion', via_device_id: 'hub' },
    ],
    [
      { entity_id: 'sensor.bridge_state', device_id: 'hub' },
      { entity_id: 'binary_sensor.kitchen_motion', device_id: 'z1' },
      { entity_id: 'binary_sensor.hall_motion', device_id: 'z2' },
    ],
  );
  assert.deepEqual(idsFor(ctx, 'hub'), ['sensor.bridge_state'],
    'a hub must expand to its own entities only');
});

// The prefix has to end at a separator, or a device called "Office" adopts everything in the
// house whose name happens to start with those letters.
test('the name prefix must end at a separator, not mid-word', () => {
  const ctx = ctxOf(
    [
      { id: 'o', name: 'Office' },
      { id: 'sub', name: 'Office_Fan', via_device_id: 'o' },
      { id: 'other', name: 'Officeblock Heater', via_device_id: 'o' },
    ],
    [
      { entity_id: 'sensor.office', device_id: 'o' },
      { entity_id: 'fan.office_fan', device_id: 'sub' },
      { entity_id: 'climate.officeblock', device_id: 'other' },
    ],
  );
  assert.deepEqual(idsFor(ctx, 'o'), ['fan.office_fan', 'sensor.office'],
    'only the separator-delimited sub-device is folded in');
});

// A backstop for naming schemes this was never measured against: no device may silently become
// a network's worth of entities, however it is named.
test('an implausibly large sub-device set is refused rather than folded in', () => {
  const devices = [{ id: 'p', name: 'Mega' }];
  const entities = [{ entity_id: 'sensor.mega', device_id: 'p' }];
  for (let i = 0; i < 40; i++) {
    devices.push({ id: `c${i}`, name: `Mega_Child_${i}`, via_device_id: 'p' });
    for (let j = 0; j < 5; j++) entities.push({ entity_id: `sensor.c${i}_${j}`, device_id: `c${i}` });
  }
  const ctx = ctxOf(devices, entities);   // 200 child entities, over the cap
  assert.deepEqual(idsFor(ctx, 'p'), ['sensor.mega'],
    '200 entities behind one device is a hub by any other name');
});

// Folding must not cascade: a grandchild is reached through its own parent, not piled onto the
// top of the tree, or one badly-named level would drag the whole subtree up.
test('folding is one level deep', () => {
  const ctx = ctxOf(
    // Deepest link declared FIRST on purpose. The fold walks parents in the order their first
    // child is seen, so this arrangement folds the shelf before the rack — which is the only
    // order in which a cascading implementation actually shows itself.
    [
      { id: 'c', name: 'Rack_Shelf_Drive', via_device_id: 'b' },
      { id: 'b', name: 'Rack_Shelf', via_device_id: 'a' },
      { id: 'a', name: 'Rack' },
    ],
    [
      { entity_id: 'sensor.rack', device_id: 'a' },
      { entity_id: 'sensor.shelf', device_id: 'b' },
      { entity_id: 'sensor.drive', device_id: 'c' },
    ],
  );
  assert.deepEqual(idsFor(ctx, 'a'), ['sensor.rack', 'sensor.shelf']);
  assert.deepEqual(idsFor(ctx, 'b'), ['sensor.drive', 'sensor.shelf']);
});
