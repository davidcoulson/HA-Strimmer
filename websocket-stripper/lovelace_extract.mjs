// lovelace_extract.mjs — extract the entity-id allowlist from a Lovelace config.
//
// Walks the card tree collecting entities from the standard keys, and expands
// `auto-entities` filter cards against the live entity list (and, when provided, the
// area/device/entity/label registries so `area`/`label`/`device`/`integration` filters
// resolve too — see issue #4).
//
// extractEntities(config, allStates, opts) -> { entities:[...], unsupported:[...] }
//   config     : the lovelace dashboard config (from `lovelace/config`)
//   allStates  : array of HA state objects [{entity_id, state, attributes}, ...]
//   opts.viewPath    : optional view `path` to restrict extraction to a single view
//   opts.registries  : { areas, devices, entities, labels } from HA's config/*_registry/list
//   opts.overInclude : when true (allowlist mode), don't let volatile conditions
//                      (state/attributes) shrink the set — an entity that doesn't match a
//                      `state:` filter right now must still be forwarded so the card can
//                      show it when it later does.
//   opts.renderedTemplates : Map<templateString, renderedText> for `filter.template` cards.
//                      Collect the templates with collectTemplates(), render them through
//                      HA, and pass the results back in (this module can't render itself).

import vm from 'node:vm';

const ID_RE = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/;
export const isEntityId = (s) => typeof s === 'string' && ID_RE.test(s);

// Port of auto-entities' own `matcher()` (src/match.ts). EVERY filter key upstream runs its
// value through this — not just entity_id — so globs and regexes work on domain/area/label/
// device/integration/name alike. The two forms differ in anchoring, which matters:
//   "/^sensor\.pv_.*_power$/"  -> RegExp("^sensor\.pv_.*_power$")   UNanchored by us; the
//                                 user supplies their own anchors inside the slashes.
//   "sensor.pv_*"              -> RegExp("^sensor\.pv_.*$")         globs are anchored.
//   "sensor.foo"               -> exact string equality.
// Previously only the glob form existed, and a /regex/ was escaped as literal text — so
// `/^sensor\.pv_.*_power$/` compiled to `^/\^sensor\\\.pv_.*_power\$/$` and matched nothing
// (issue #10). Upstream ORs the regex against exact equality, so we do too.
//
// The rest of upstream's matcher is ported too, in upstream's order, because a value that is not
// understood does not fail loudly — it falls through to exact equality and matches NOTHING. That
// is how `state: "< 20"` on a low-battery card resolved to zero entities: the string "< 20" was
// compared with `===` against each state. Ported:
//   "$$…"        match against JSON.stringify(value) — for attributes that are objects/lists
//   "… m|h|d ago" the value is a timestamp; compare its age in minutes / hours / days
//   <= >= == != < > ! =   numeric comparison via parseFloat, exactly as upstream spells them
// Upstream quirks are kept rather than corrected — `"! on"` parses NaN and so matches everything —
// because the card in the browser behaves that way, and the allowlist has to cover what the card
// will actually show. Every one of those quirks errs toward including.
//
// `note(msg)` is optional and receives anything worth telling a person — see guardedTest.
const AGO_SUFFIX_RE = /([mhd])\s+ago\s*$/i;
const COMPARISONS = [
  ['<=', (a, b) => a <= b], ['>=', (a, b) => a >= b], ['==', (a, b) => a == b],   // eslint-disable-line eqeqeq
  ['!=', (a, b) => a != b], ['<', (a, b) => a < b], ['>', (a, b) => a > b],       // eslint-disable-line eqeqeq
  ['!', (a, b) => a != b], ['=', (a, b) => a == b],                               // eslint-disable-line eqeqeq
];

export function toMatcher(pattern, note = null) {
  if (typeof pattern !== 'string') return (v) => v === pattern;
  const tests = [];
  const transforms = [];
  if (pattern.startsWith('$$')) {
    pattern = pattern.substring(2);
    transforms.push(JSON.stringify);
  }
  if ((pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 1) || pattern.includes('*')) {
    let p = pattern;
    const authored = p.startsWith('/');
    // Glob -> anchored regex. Escape regex metacharacters EXCEPT `*`, which becomes `.*`.
    // (Upstream's own glob branch forgets to escape `.`; we escape it, which is stricter but
    // only ever in the safe direction for an allowlist.)
    if (!authored) p = `/^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$/`;
    try {
      const src = p.slice(1, -1);
      const re = new RegExp(src);
      // Only a regex somebody WROTE can backtrack catastrophically; a converted glob cannot nest
      // a quantifier. Everything else keeps the plain, free `re.test`.
      const test = authored && looksCatastrophic(src) ? guardedTest(re, src, note) : (v) => re.test(v);
      tests.push((v) => typeof v === 'string' && test(v));
    } catch { /* an unparseable regex simply contributes no matches */ }
  }
  const ago = AGO_SUFFIX_RE.exec(pattern);
  if (ago) {
    pattern = pattern.replace(ago[0], '');
    const now = Date.now();
    const per = ago[1].toLowerCase() === 'h' ? 60 : ago[1].toLowerCase() === 'd' ? 60 * 24 : 1;
    transforms.push((v) => (now - new Date(v).getTime()) / 60000 / per);
  }
  // Not else-if: upstream tests every prefix, so "<= 5" registers both `<=` and `<`. The second
  // parses NaN and never matches, which is harmless — and keeping the shape keeps this a port.
  for (const [op, cmp] of COMPARISONS) {
    if (!pattern.startsWith(op)) continue;
    const want = parseFloat(pattern.substring(op.length));
    tests.push((v) => cmp(parseFloat(v), want));
  }
  const exact = pattern;
  tests.push((v) => v === exact);
  return (v) => {
    const t = transforms.reduce((acc, f) => f(acc), v);
    if (t === undefined) return false;
    return tests.some((f) => f(t));
  };
}

// ---- catastrophic-backtracking guard ----
//
// A `/regex/` in a dashboard is run here against every entity id and friendly name on the
// instance, synchronously, on the one event loop that also relays every panel's websocket — and
// again on every rebuild. Upstream runs the same pattern in the browser tab showing the card, so
// a pathological one hangs that tab. Here it hangs EVERY panel: measured, `/^(a+)+$/` against one
// 29-character string held the loop for 12.3 seconds.
//
// Rejecting suspicious patterns outright would be the wrong trade — a rejected filter matches
// nothing, and under-including is the harmful direction — and most nested quantifiers are
// harmless on real input. So a suspicious pattern is still RUN, just under a deadline: `vm` can
// interrupt a regex mid-backtrack, which nothing else in JavaScript can (verified: cut off at
// 51ms where the bare call took 12s). That costs ~40µs a call, which is why only patterns the
// static check flags take this path, and why results are memoised — ids and names barely change
// between rebuilds, so the second rebuild onwards pays nothing.
//
// A pattern that does hit the deadline is switched off for the life of the process and says so.
// The stall is therefore bounded at one deadline per bad pattern, ever, instead of one per
// entity per rebuild.
const REGEX_DEADLINE_MS = 50;
const REGEX_MEMO_MAX = 20000;
const REGEX_KILLED = new Set();            // regex source
const REGEX_MEMO = new Map();              // regex source -> Map(value -> boolean)
let guardCtx = null, guardScript = null;

// A quantified group whose body itself contains a quantifier: (a+)+, (\w+\s?)*, (x{2,})+.
// Innermost groups only, escapes skipped. Deliberately loose — a false positive costs the guarded
// path's microseconds, never a match.
export function looksCatastrophic(src) {
  return /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/.test(src);
}

function guardedTest(re, src, note) {
  const killedMsg = `auto-entities regex /${src}/ disabled: it exceeded ${REGEX_DEADLINE_MS}ms on one value `
    + '(catastrophic backtracking) and would stall every panel — rewrite it without a nested quantifier';
  return (v) => {
    if (REGEX_KILLED.has(src)) { note?.(killedMsg); return false; }
    let memo = REGEX_MEMO.get(src);
    if (!memo) { memo = new Map(); REGEX_MEMO.set(src, memo); }
    const seen = memo.get(v);
    if (seen !== undefined) return seen;
    if (!guardScript) {
      guardCtx = vm.createContext(Object.create(null));
      guardScript = new vm.Script('re.test(v)');
    }
    guardCtx.re = re; guardCtx.v = v;
    let out;
    try { out = Boolean(guardScript.runInContext(guardCtx, { timeout: REGEX_DEADLINE_MS })); }
    catch {
      REGEX_KILLED.add(src);
      REGEX_MEMO.delete(src);
      note?.(killedMsg);
      return false;
    }
    if (memo.size >= REGEX_MEMO_MAX) memo.clear();
    memo.set(v, out);
    return out;
  };
}

const asArray = (v) => (Array.isArray(v) ? v : [v]);

// A filter value may be a plain string, an array, or — from HA's selector UI — an object
// that records which input mode was used, e.g. `{ label: "1st_floor", active_choice: "label" }`
// or `{ custom: "input_boolean.bypass_*", active_choice: "custom" }`. `active_choice` names
// the key holding the real value, so prefer it; fall back to the filter key itself.
// Without this an object stringifies to "[object Object]" and matches nothing.
function coerceVal(v, key) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap((x) => coerceVal(x, key));
  if (typeof v === 'object') {
    const pick = typeof v.active_choice === 'string' && v.active_choice in v ? v.active_choice
      : key in v ? key : null;
    return pick ? coerceVal(v[pick], key) : [];
  }
  return [v];
}

// Build a predicate for filter key `key` from its (possibly editor-wrapped) value: the value
// matches if ANY of its alternatives matches, via the auto-entities matcher.
function valMatcher(v, key, note = null) {
  const ms = coerceVal(v, key).map((x) => toMatcher(typeof x === 'string' ? x : String(x), note));
  return (s) => ms.some((m) => m(s));
}

// Build entity -> {area, labels, device, integration} lookups from the registries.
// area is inherited from the entity's device when the entity has no explicit area.
//
// Memoised on the registries OBJECT. One allowlist rebuild asked for this 3 + one-per-dashboard
// times over the same ~10MB of registry rows; the answer depends on nothing else, and the rebuild
// fetches a fresh object each time, so identity is exactly the right cache key and a WeakMap lets
// the old one go with its registries. The result is shared, so it is treated as read-only —
// extractEntities copies before hanging its per-call state off it.
const REGISTRY_CTX = new WeakMap();
export function buildRegistryCtx(registries = {}) {
  const cacheable = registries && typeof registries === 'object';
  const hit = cacheable ? REGISTRY_CTX.get(registries) : null;
  if (hit) return hit;
  const built = computeRegistryCtx(registries);
  if (cacheable) REGISTRY_CTX.set(registries, built);
  return built;
}

function computeRegistryCtx(registries = {}) {
  const areas = registries.areas || [];
  const labels = registries.labels || [];
  const devices = registries.devices || [];
  const entities = registries.entities || [];
  const areaName = new Map(areas.map((a) => [a.area_id, a.name]));
  const labelName = new Map(labels.map((l) => [l.label_id, l.name]));
  const deviceArea = new Map(devices.map((d) => [d.id, d.area_id]));
  const deviceName = new Map(devices.map((d) => [d.id, d.name_by_user || d.name]));
  const ent = new Map();
  for (const e of entities) {
    const areaId = e.area_id || (e.device_id ? deviceArea.get(e.device_id) : null) || null;
    const labelIds = e.labels || [];
    ent.set(e.entity_id, {
      areaId,
      areaName: areaId ? areaName.get(areaId) ?? null : null,
      labelIds,
      labelNames: labelIds.map((id) => labelName.get(id)).filter(Boolean),
      deviceId: e.device_id || null,
      deviceName: e.device_id ? deviceName.get(e.device_id) ?? null : null,
      platform: e.platform || null,
    });
  }
  // device id -> its entity ids. Needed because some cards are configured with a DEVICE
  // rather than with entities, and resolve the device's entities themselves in the browser.
  // See resolveDeviceIds() for why that breaks and how this fixes it.
  const byDevice = new Map();
  for (const e of entities) {
    if (!e.device_id || !e.entity_id) continue;
    if (!byDevice.has(e.device_id)) byDevice.set(e.device_id, []);
    // The category comes along because it is the only authoritative signal for "this entity is
    // not the device's primary function". Home Assistant sets it; we never infer it.
    byDevice.get(e.device_id).push({ id: e.entity_id, cat: e.entity_category || null });
  }

  // Sub-devices: a device that IS part of another one, folded into its parent's entity list.
  //
  // A card handed a device id renders the whole thing. The Bambu print-status card is the
  // measured case: it is configured with the printer's device id, and then goes looking for the
  // AMS units and spool — which Home Assistant models as SEPARATE devices linked back to the
  // printer by `via_device_id`. The card does this itself, in as many words:
  //
  //     Object.values(hass.devices).filter((d) => d.via_device_id === printerId)
  //
  // Nothing in the dashboard config names those devices, so their entities were never in the
  // allowlist and their rows were trimmed out of the device registry — and the card rendered
  // nothing, with no error anywhere.
  //
  // `via_device_id` ALONE cannot be the rule. Home Assistant uses it for "routes through", which
  // covers both sub-units and hubs: measured on the instance this was written against, it makes a
  // Z-Wave controller the parent of 75 devices carrying 2,870 entities, and a Zigbee2MQTT bridge
  // the parent of 62 more. Following it blindly would quietly hand a panel the entire Z-Wave
  // network — the exact opposite of this add-on's job.
  //
  // So the rule is via_device_id AND a naming test: the child's name must begin with the
  // parent's, followed by a separator. That is the convention integrations use when a device is
  // a PART of another (`H2S_0938AC572400463_AMS_1`), and hubs never match it — their children are
  // independent things with their own names. Measured across 1,233 devices: every hub scored
  // zero, and the largest addition to any device was the printer's own 22 entities.
  //
  // The entity cap is a backstop for naming schemes this was not measured against, so that no
  // install can have a device silently explode into a network's worth of entities.
  const SUB_DEVICE_ENTITY_CAP = 100;
  const MIN_PARENT_NAME = 3;
  const devById = new Map(devices.map((d) => [d.id, d]));
  const nameOf = (d) => String((d && (d.name_by_user || d.name)) || '');
  const subDevices = new Map();      // parent id -> [child id]
  for (const d of devices) {
    const parent = d.via_device_id ? devById.get(d.via_device_id) : null;
    if (!parent || parent.id === d.id) continue;
    const pn = nameOf(parent), cn = nameOf(d);
    if (pn.length < MIN_PARENT_NAME || !cn.startsWith(pn)) continue;
    // The character after the prefix must be a separator, so a parent called "Office" does not
    // adopt "Office Building" — only "Office_AMS_1" and its kind.
    const next = cn.charAt(pn.length);
    if (next && !/[\s_\-.:#]/.test(next)) continue;
    if (!subDevices.has(parent.id)) subDevices.set(parent.id, []);
    subDevices.get(parent.id).push(d.id);
  }
  // One level, resolved against the ORIGINAL lists so a fold can never feed another fold.
  const ownRows = new Map([...byDevice].map(([k, v]) => [k, v]));
  for (const [parentId, childIds] of subDevices) {
    const rows = childIds.flatMap((cid) => ownRows.get(cid) || []);
    if (!rows.length || rows.length > SUB_DEVICE_ENTITY_CAP) continue;
    byDevice.set(parentId, [...(ownRows.get(parentId) || []), ...rows]);
  }

  return { ent, byDevice, subDevices };
}

// Split a device's entities by entity_category. `config` and `diagnostic` are Home Assistant's
// own labels for controls that configure the device and readings that describe its health —
// panel brightness, firmware, last-seen — as opposed to what the device is FOR.
//
// A litter robot measured here carries 21 entities and a card that renders a fill percentage
// needs a handful of them. But this is not filtered by default, and deliberately so: whether a
// given card renders `status_code` is not knowable from here, and a wrongly dropped entity blanks
// part of a card with no error anywhere. Opt in once you have seen the breakdown in the log.
export function splitDeviceEntities(rows = []) {
  const out = { primary: [], config: [], diagnostic: [] };
  for (const r of rows) {
    const bucket = r.cat === 'config' ? 'config' : r.cat === 'diagnostic' ? 'diagnostic' : 'primary';
    out[bucket].push(r.id);
  }
  return out;
}

// Which entity ids of a device survive the configured category exclusions.
export function deviceEntityIds(rows = [], exclude = []) {
  if (!exclude.length) return rows.map((r) => r.id);
  const drop = new Set(exclude);
  return rows.filter((r) => !drop.has(r.cat || 'primary')).map((r) => r.id);
}

// Home Assistant device ids are 32 lowercase hex characters. Matching the shape alone would be
// reckless, so a candidate only counts when it is ALSO a device that actually exists in the
// registry — which makes a false positive essentially impossible.
const DEVICE_ID_RE = /^[0-9a-f]{32}$/;

// Split one auto-entities condition into structural tests (domain/entity_id/area/label/
// device/integration — stable identity) and volatile tests (state/attributes — change at
// runtime). Callers decide which to apply. Registry-backed keys need `ctx`; without it
// they simply match nothing (degrades to pre-#4 behavior).
// Is this pattern a statement about a value RIGHT NOW — a numeric comparison or an "… ago" age —
// rather than about what the entity is? `device_class: battery` describes the entity; `"< 20"`
// describes this minute.
const isLivePattern = (v) => typeof v === 'string'
  && (/^(?:\$\$)?\s*[<>=!]/.test(v) || AGO_SUFFIX_RE.test(v));

function condTests(cond, unsupported, ctx) {
  const structural = [];
  const volatile = [];
  // The subset of `volatile` that describes what an entity IS rather than how it is doing: an
  // attribute compared for equality or by pattern. See makeMatcher for what this buys.
  const descriptive = [];
  const reg = (s) => ctx.ent && ctx.ent.get(s.entity_id);
  const note = (msg) => unsupported.push(msg);

  // Each key matches via the auto-entities matcher, so globs and regexes work everywhere
  // (issue #10). Registry-backed keys match against BOTH the id and the human name, the way
  // upstream does — `area: Kitchen` and `area: kitchen_area_id` both resolve.
  if (cond.domain != null) {
    const m = valMatcher(cond.domain, 'domain', note);
    structural.push((s) => m(s.entity_id.split('.')[0]));
  }
  if (cond.entity_id != null) {
    const m = valMatcher(cond.entity_id, 'entity_id', note);
    structural.push((s) => m(s.entity_id));
  }
  if (cond.area != null) {
    const m = valMatcher(cond.area, 'area', note);
    structural.push((s) => { const r = reg(s); return !!r && (m(r.areaId) || m(r.areaName)); });
  }
  if (cond.label != null) {
    const m = valMatcher(cond.label, 'label', note);
    structural.push((s) => { const r = reg(s); return !!r && (r.labelIds.some(m) || r.labelNames.some(m)); });
  }
  if (cond.device != null) {
    const m = valMatcher(cond.device, 'device', note);
    structural.push((s) => { const r = reg(s); return !!r && (m(r.deviceId) || m(r.deviceName)); });
  }
  if (cond.integration != null) {
    const m = valMatcher(cond.integration, 'integration', note);
    structural.push((s) => { const r = reg(s); return !!r && m(r.platform); });
  }
  // Upstream matches `name` against friendly_name. Structural, not volatile: a friendly name
  // is stable identity, unlike state — treating it as volatile would forward the whole
  // instance for any card whose only filter is a name.
  if (cond.name != null) {
    const m = valMatcher(cond.name, 'name', note);
    structural.push((s) => m(s.attributes?.friendly_name));
  }
  // `group: group.foo` -> the members listed in that group's entity_id attribute.
  if (cond.group != null) {
    const want = coerceVal(cond.group, 'group').map(String);
    const members = new Set();
    for (const g of want) {
      const st = ctx.byId?.get(g);
      for (const e of asArray(st?.attributes?.entity_id ?? [])) if (isEntityId(e)) members.add(e);
    }
    structural.push((s) => members.has(s.entity_id));
  }
  if (cond.state != null) { const m = toMatcher(cond.state, note); volatile.push((s) => m(s.state)); }
  if (cond.attributes && typeof cond.attributes === 'object') {
    for (const [k, v] of Object.entries(cond.attributes)) {
      const m = toMatcher(v, note);
      const t = (s) => s.attributes && m(s.attributes[k]);
      volatile.push(t);
      if (!isLivePattern(v)) descriptive.push(t);
    }
  }

  // Flag conditions we don't evaluate (not/and/or/last_changed/floor/device_model/…).
  const known = ['domain', 'entity_id', 'area', 'label', 'device', 'integration', 'name',
    'group', 'state', 'attributes', 'options', 'type', 'active_choice', 'sort'];
  for (const k of Object.keys(cond)) {
    if (!known.includes(k)) unsupported.push('auto-entities filter key: ' + k);
  }
  return { structural, volatile, descriptive };
}

// Turn a condition into a predicate. `role` + `overInclude` decide how volatile tests are
// treated (see extractEntities opts.overInclude):
//   include, overInclude : structural only. With no structural test, fall back to the
//                          DESCRIPTIVE attribute tests alone, and only then to everything.
//
//                          That middle step is the low-battery card: `attributes: {device_class:
//                          battery}` + `state: "< 20"` has no structural key, so it used to be
//                          evaluated against current state — and a battery that drops below 20
//                          TOMORROW was never forwarded, because no state change rebuilds an
//                          allowlist. Matching on `device_class` alone forwards every battery and
//                          lets the card do the comparing, which is the whole over-include idea
//                          applied to the one place it was missing. It is a strict superset of
//                          the old result (fewer tests ANDed), so nothing a card had is lost.
//                          A condition that is ONLY live (`state: on` and nothing else) is still
//                          resolved against current state: ignoring it would match the instance.
//   exclude, overInclude : structural only, and never exclude on a volatile-only condition
//                          (dropping an entity we might need later is the harmful direction).
//   otherwise            : all tests (exact, current-state semantics).
function makeMatcher(cond, unsupported, ctx, role, overInclude) {
  const { structural, volatile, descriptive } = condTests(cond, unsupported, ctx);
  let tests;
  if (overInclude && role === 'exclude') {
    if (!structural.length) return () => false;
    tests = structural;
  } else if (overInclude) {
    tests = structural.length ? structural : descriptive.length ? descriptive : volatile;
  } else {
    tests = [...structural, ...volatile];
  }
  if (!tests.length) return () => false;
  return (s) => tests.every((t) => t(s));
}

// `filter.template` is a Jinja template that HA renders into the card list, so its entity
// ids only exist after rendering — a structural walk can never see them (issue #4). We can't
// render here (this module is sync and has no HA connection), so the caller pre-renders via
// HA's `render_template` and passes the results in as opts.renderedTemplates. We then scrape
// real entity ids out of the rendered text, which works whether the template returns a list
// of ids or a list of card objects.
export function collectTemplates(config) {
  const out = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.filter?.template === 'string') out.add(node.filter.template);
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  walk(Array.isArray(config?.views) ? config.views : []);
  return [...out];
}

// Groups (and group-expanding cards like enhanced-shutter-card's `show_group_members`) name
// only the group entity in the config; the members live in the group's `entity_id` attribute
// at runtime and appear nowhere in the dashboard (issue #4). Pull them in transitively so a
// group on the allowlist brings its members with it. Bounded in case a group cycles.
export function expandGroupMembers(ids, allStates = [], maxDepth = 5) {
  const byId = new Map(allStates.map((s) => [s.entity_id, s]));
  const out = new Set(ids);
  let frontier = [...out];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const id of frontier) {
      const members = byId.get(id)?.attributes?.entity_id;
      if (!Array.isArray(members)) continue;
      for (const e of members) if (isEntityId(e) && !out.has(e)) { out.add(e); next.push(e); }
    }
    frontier = next;
  }
  return out;
}

function expandAutoEntities(node, allStates, add, unsupported, ctx, overInclude) {
  const f = node.filter || {};
  // A rendered template contributes every real entity id in its output.
  if (typeof f.template === 'string') {
    const rendered = ctx.templates?.get(f.template);
    if (rendered == null) unsupported.push('auto-entities filter key: template (not rendered)');
    // Only REAL ids: rendered output can contain incidental dotted words, and a template is
    // free-form text rather than a structured filter.
    else for (const m of String(rendered).matchAll(/[a-z_][a-z0-9_]*\.[a-z0-9_]+/g)) {
      if (ctx.byId.has(m[0])) add(m[0]);
    }
  }
  // A condition must be a plain object. The YAML editor leaves a bare `-` behind as `null`, and
  // condTests dereferenced it — so ONE empty list item threw out of extractEntities, the caller
  // marked the whole dashboard FAILED, and with a single dashboard configured every rebuild then
  // died with "HA not ready". An entry that says nothing is skipped and named instead.
  const isCond = (c, role) => {
    if (c && typeof c === 'object' && !Array.isArray(c)) return true;
    unsupported.push(`auto-entities ${role} entry that is not a filter (${c === null ? 'empty' : typeof c}) — skipped`);
    return false;
  };
  const inc = Array.isArray(f.include) ? f.include : [];
  const exc = (Array.isArray(f.exclude) ? f.exclude : []).filter((c) => isCond(c, 'exclude'));
  const excMatchers = exc.map((c) => makeMatcher(c, unsupported, ctx, 'exclude', overInclude));
  for (const cond of inc) {
    // A bare entity id is not a filter upstream either, but if it names a real-looking entity
    // then forwarding it is free and dropping it is not.
    if (typeof cond === 'string' && isEntityId(cond)) add(cond);
    if (!isCond(cond, 'include')) continue;
    // An include entry can be an explicit entity rather than a filter.
    if (cond && isEntityId(cond.entity_id) && !String(cond.entity_id).includes('*')) {
      if (!excMatchers.some((m) => m({ entity_id: cond.entity_id, state: '', attributes: {} }))) add(cond.entity_id);
      continue;
    }
    const match = makeMatcher(cond, unsupported, ctx, 'include', overInclude);
    for (const s of allStates) {
      if (match(s) && !excMatchers.some((m) => m(s))) add(s.entity_id);
    }
  }
}

// Add every entity of any device this card names, for the card-configured-with-a-device case.
//
// Only the node's OWN scalar values are considered — no recursion — because the walk already
// visits every node, and a device id nested deeper belongs to whichever card actually holds it.
// Arrays of device ids are handled too: several cards take `devices: [...]`.
//
// This deliberately admits the device's whole entity set rather than guessing which subset the
// card renders. The card's internals are not knowable from here, and the failure modes are not
// symmetric: including a few entities too many costs bandwidth, while missing one silently
// empties a card on a wall panel with no error anywhere.
function resolveDeviceIds(node, ctx, add) {
  const byDevice = ctx.byDevice;
  if (!byDevice || !byDevice.size) return;
  const consider = (v) => {
    if (typeof v !== 'string' || !DEVICE_ID_RE.test(v)) return;
    const rows = byDevice.get(v);
    if (!rows) return;
    ctx.devicesSeen?.add(v);
    deviceEntityIds(rows, ctx.excludeDeviceCategories || []).forEach(add);
  };
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach(consider);
    else consider(v);
  }
}

export function extractEntities(config, allStates = [], opts = {}) {
  const found = new Set();
  const unsupported = [];
  const add = (id) => { if (isEntityId(id)) found.add(id); };
  const ctx = { ...buildRegistryCtx(opts.registries) };
  // Live state by id: needed for `group:` membership and to validate ids scraped out of a
  // rendered template. Templates come pre-rendered from the caller (see collectTemplates).
  ctx.byId = new Map(allStates.map((s) => [s.entity_id, s]));
  ctx.templates = opts.renderedTemplates instanceof Map ? opts.renderedTemplates : new Map();
  ctx.excludeDeviceCategories = Array.isArray(opts.excludeDeviceCategories) ? opts.excludeDeviceCategories : [];
  ctx.devicesSeen = new Set();
  const overInclude = !!opts.overInclude;

  function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;

    // auto-entities (and similar filter cards) need live expansion.
    if (typeof node.type === 'string' && node.type.includes('auto-entities') && node.filter) {
      expandAutoEntities(node, allStates, add, unsupported, ctx, overInclude);
    }

    // Cards configured with a DEVICE instead of with entities.
    //
    // Found on a live instance: `custom:ha-bambulab-print_status-card` is configured as
    // `printer: 43f1e9fddd670256ced58c9fe7971e41` — a device id — and looks up that device's
    // entities itself, in the browser. A structural walk sees no entity_id anywhere, so the
    // dashboard resolved to 2 entities (its two lights) and the printer's 57 were stripped.
    // The card then renders with nothing in it, which looks like a broken card rather than a
    // trimming problem.
    //
    // The key name cannot be predicted — `printer` here, something else in the next card — so
    // match on the VALUE being a real device id rather than on where it appears.
    resolveDeviceIds(node, ctx, add);

    // Standard entity-bearing keys.
    if (typeof node.entity === 'string') add(node.entity);
    if (typeof node.camera_image === 'string') add(node.camera_image);
    if (typeof node.camera_entity === 'string') add(node.camera_entity);
    if (typeof node.entity_id === 'string') add(node.entity_id);
    else if (Array.isArray(node.entity_id)) node.entity_id.forEach(add);

    if (Array.isArray(node.entities)) {
      for (const it of node.entities) {
        if (typeof it === 'string') add(it);
        // objects fall through to generic recursion below (covers {entity:...},
        // fold-entity-row {head, entities:[...]}, etc.)
      }
    }

    // Generic recursion over every value (covers cards/card/elements/head/stack/badges/…).
    // Skip `filter`: it holds auto-entities match conditions (incl. `exclude`), not
    // entity widgets — recursing would re-add excluded entities.
    for (const [k, v] of Object.entries(node)) {
      if (k === 'filter') continue;
      if (v && typeof v === 'object') walk(v);
    }
  }

  let views = Array.isArray(config?.views) ? config.views : [];
  if (opts.viewPath) views = views.filter((v) => v.path === opts.viewPath);
  views.forEach(walk);

  return { entities: [...found].sort(), unsupported: [...new Set(unsupported)], devices: [...ctx.devicesSeen] };
}
