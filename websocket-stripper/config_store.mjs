// Configuration the panel owns, kept beside Supervisor's own options.
//
// The add-on's options have outgrown what a Supervisor schema can express. Nested groups do not
// render in the Configuration tab at all (measured: Supervisor parses a documented depth-2 dict,
// registers its translation, and the frontend draws nothing), sub-options cannot carry
// descriptions, and there is no validation beyond types — no "this rule matches none of your
// dashboards", no preview, no conditional fields. Everything behavioural is heading for the
// panel, which has none of those limits and, unlike a YAML file, knows what is connected right
// now.
//
// PER-KEY OWNERSHIP, not a wholesale takeover. This file records only the keys the panel has
// actually been used to change. Everything else falls through to `/data/options.json` exactly as
// before. That matters for two reasons:
//
//   * Nothing is stranded. Ship this before the panel can edit a given option and that option
//     still comes from YAML, still renders in the Configuration tab, still works.
//   * Nothing is silently ignored. The failure mode of a wholesale switch is a user editing the
//     Configuration tab and watching it do nothing, with no indication why. Here, an option is
//     owned here only because someone deliberately changed it here.
//
// A key adopted here is SEEDED from its YAML value, so taking ownership never changes behaviour
// on its own — the first save writes what was already in effect.
//
// BOOTSTRAP KEYS ARE NEVER ADOPTED. How the process binds and finds Home Assistant has to be
// answerable before any of this is readable, and has to stay fixable from the Configuration tab
// when the panel is the thing that is broken.

import fs from 'node:fs';
import path from 'node:path';

export const STORE_VERSION = 1;

// Setup, not functionality. These stay in add-on options forever.
// Both spellings of each port, deliberately: the rename to proxy_port/mgmt_port would otherwise
// leave the canonical names adoptable while only the legacy aliases were protected — and adopting
// the port the console is served on is the one change that can make the console unreachable.
export const BOOTSTRAP_KEYS = new Set([
  'log_level', 'proxy_port', 'port', 'mgmt_port', 'stats_port', 'ha_base', 'allow_ws_url',
]);

// Option names that were renamed. Each is still READ, so an existing config keeps working, but
// none of them gets a row in the console: listing both spellings showed two rows for one setting,
// with the value on whichever row the config happened to use and `null` on the other.
//
// They stay in the schema deliberately. Removing a key from the schema makes Supervisor discard
// it on upgrade, silently, which would cost someone a setting they had deliberately changed.
// Old name -> the name that replaced it. The mapping matters as well as the membership: a config
// still using the old spelling has nothing under the new one, so the canonical row would render
// empty while the setting was plainly in effect. The console reads through this to show the value
// that is actually being used.
export const LEGACY_ALIASES = {
  port: 'proxy_port',
  stats_port: 'mgmt_port',
  strip_entities: 'trim_entities',
};

export const LEGACY_KEYS = new Set(Object.keys(LEGACY_ALIASES));

// The old spelling for a canonical key, if it has one.
export function legacyNameFor(key) {
  return Object.keys(LEGACY_ALIASES).find((old) => LEGACY_ALIASES[old] === key);
}

// Every option the console may take over, and what shape it is.
//
// This is declared rather than derived from whatever happens to be in /data/options.json, because
// an option nobody has set yet is exactly the one someone came to the console to set. Deriving
// the list from the options file shows only settings that already exist, so a default-valued
// option is invisible — the console would appear to be missing the very toggle being looked for.
//
// Kept honest by a test that compares it against config.yaml's schema, the same way the stats
// options block is pinned: a new option added to the schema and not listed here fails the suite.
//
// `objects` are the list-of-dicts options. They are listed so the console can show what is set
// and say where it comes from, but editing them needs a real editor rather than a text box —
// that arrives with the unified overrides work.
export const EDITABLE_KEYS = {
  dashboards: 'list',
  always_forward: 'list',
  never_forward: 'list',
  trim_entities: 'bool',
  per_dashboard: 'bool',
  trim_registries: 'bool',
  compress_websocket: 'bool',
  trim_resources: 'bool',
  trim_extra_modules: 'bool',
  trim_services: 'bool',
  trim_repairs: 'bool',
  trim_themes: 'bool',
  trim_translations: 'bool',
  mqtt_sensors: 'bool',
  mdns_discovery: 'bool',
  cert_monitor_host: 'str',
  mdns_services: 'list',
  exclude_device_categories: 'list',
  resources_always_forward: 'list',
  resources_never_forward: 'list',
  user_agent_dashboards: 'objects',
  user_overrides: 'objects',
  dashboard_overrides: 'objects',
  client_overrides: 'objects',
};

const emptyStore = () => ({ version: STORE_VERSION, managed: {}, history: [] });

export function storePath(dataDir) {
  return path.join(dataDir, 'config.json');
}

// Read the panel-owned config. A missing file is the normal first-run state, not an error; an
// unreadable or malformed one must NOT take the add-on down, because then a bad write here would
// cost you the proxy as well as the panel. Either way the answer is "own nothing", which falls
// through to the add-on options that were working before this file existed.
export function readStore(dataDir, onWarn = () => {}) {
  if (!dataDir) return emptyStore();
  const p = storePath(dataDir);
  try {
    if (!fs.existsSync(p)) return emptyStore();
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object' || typeof raw.managed !== 'object' || raw.managed === null) {
      onWarn(`${p} is not a config store — ignoring it and using add-on options`);
      return emptyStore();
    }
    // A store written by a NEWER version may use keys this build does not understand. Ignoring it
    // wholesale is safer than half-applying it, and a downgrade is the one time that can happen.
    if (Number(raw.version) > STORE_VERSION) {
      onWarn(`${p} was written by a newer version (${raw.version} > ${STORE_VERSION}) — using add-on options instead`);
      return emptyStore();
    }
    const managed = {};
    for (const [k, v] of Object.entries(raw.managed)) {
      if (BOOTSTRAP_KEYS.has(k)) {
        onWarn(`ignoring managed "${k}": setup options are always read from add-on options`);
        continue;
      }
      managed[k] = v;
    }
    return { version: Number(raw.version) || STORE_VERSION, managed, history: raw.history || [] };
  } catch (e) {
    onWarn(`could not read ${p} (${e.message}) — using add-on options`);
    return emptyStore();
  }
}

// Whole-file rewrite through a temp file and rename, so a crash mid-write cannot leave a
// half-written config that fails to parse on the next boot. Same approach as history.mjs, and for
// the same reason: this file is read once at startup and a corrupt one is expensive.
export function writeStore(dataDir, store) {
  const p = storePath(dataDir);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, p);
  return p;
}

// Adopt one key, seeded from whatever is in effect today when no value is supplied. Seeding is
// what makes adoption safe: taking ownership of an option must not change what it does.
export function adopt(store, key, value, yamlOptions = {}) {
  if (BOOTSTRAP_KEYS.has(key)) {
    throw new Error(`"${key}" is a setup option and is always read from add-on options`);
  }
  const next = { ...store, managed: { ...store.managed, [key]: value !== undefined ? value : yamlOptions[key] } };
  next.history = [...(store.history || []), { at: new Date().toISOString(), key, action: 'adopt' }].slice(-50);
  return next;
}

// Hand a key back to add-on options. The escape hatch: whatever the panel did, the Configuration
// tab can always be made authoritative again.
export function release(store, key) {
  const managed = { ...store.managed };
  delete managed[key];
  return {
    ...store,
    managed,
    history: [...(store.history || []), { at: new Date().toISOString(), key, action: 'release' }].slice(-50),
  };
}

// What the rest of the add-on reads. Panel-owned keys win; everything else is the add-on option.
// Bootstrap keys can never be shadowed, which readStore already enforces — this is belt and
// braces for a store handed in directly by a test or a future caller.
export function effectiveOptions(yamlOptions = {}, store = emptyStore()) {
  const out = { ...yamlOptions };
  for (const [k, v] of Object.entries(store.managed || {})) {
    if (BOOTSTRAP_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// Which keys each source is answering for, so the panel and the log can say so plainly rather
// than leaving someone to guess why the Configuration tab appears to do nothing.
export function ownership(yamlOptions = {}, store = emptyStore()) {
  const managed = Object.keys(store.managed || {}).filter((k) => !BOOTSTRAP_KEYS.has(k)).sort();
  const fromYaml = Object.keys(yamlOptions).filter((k) => !managed.includes(k)).sort();
  return { managed, fromYaml };
}
