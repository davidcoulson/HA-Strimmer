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
export const BOOTSTRAP_KEYS = new Set([
  'log_level', 'port', 'stats_port', 'ha_base', 'allow_ws_url',
]);

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
