#!/usr/bin/env node
// ha_ws_trim_proxy.mjs — reverse proxy that serves the REAL Home Assistant frontend
// but trims the entity firehose so a kiosk dashboard loads fast with full fidelity.
//
// It proxies all HTTP straight through to HA (frontend bundles, auth, registries,
// lovelace config, custom-card resources — untouched). All websocket upgrades also pass
// through EXCEPT /api/websocket, which is the only connection it intercepts:
//   * subscribe_entities (no filter)  -> inject entity_ids = the dashboards' allowlist,
//                                         so HA streams only those entities.
//   * get_states result               -> filtered to the allowlist.
// Everything else (auth handshake, registries, config, events) passes through, so the
// real frontend renders your real cards — just without the all-entities firehose.
//
// The allowlist is computed at startup from each dashboard's lovelace/config (walked by
// ./lovelace_extract.mjs), unioned across all configured dashboards, then rebuilt live
// whenever HA fires `lovelace_updated` (a dashboard was edited) — no restart needed.
//
// Runs in two modes (auto-detected):
//   * HA add-on  — reads /data/options.json, uses SUPERVISOR_TOKEN via the supervisor
//                  proxy for the allowlist precompute, proxies to http://homeassistant:8123.
//   * dev/CLI    — reads env vars, uses HA_TOKEN against HA_BASE directly.
//
// Env (dev): HA_TOKEN, HA_BASE (default http://homeassistant.mgmt:8123), PORT (9123),
//   DASH_PATHS (comma/newline list), ALWAYS_FORWARD, NEVER_FORWARD (literals or /regex/),
//   STRIP_ENTITIES (default 1; 0 = passthrough for A/B compare),
//   ALLOW_WS_URL / ALLOW_TOKEN (override the allowlist-precompute connection).

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import httpProxy from 'http-proxy';
import { WebSocketServer, WebSocket } from 'ws';
import { extractEntities, collectTemplates, expandGroupMembers, buildRegistryCtx, splitDeviceEntities, deviceEntityIds } from './lovelace_extract.mjs';
import * as stats from './stats.mjs';
import * as history from './history.mjs';
import { classify, normalizeIp } from './route.mjs';

// ---- config (add-on options.json or env) ----
function loadOptions() {
  try { if (fs.existsSync('/data/options.json')) return JSON.parse(fs.readFileSync('/data/options.json', 'utf8')); }
  catch (e) { console.error('could not read /data/options.json:', e.message); }
  return {};
}
const OPT = loadOptions();
const inAddon = !!process.env.SUPERVISOR_TOKEN;
// Bump together with config.yaml `version`. Logged at boot so the add-on log shows exactly
// which code is running — the only reliable way to tell a Rebuild actually picked up changes
// (a local add-on bakes in whatever files are in the host's /addons folder, not GitHub).
const VERSION = '2026.09.13.17';

const toList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/))
  .map((s) => String(s).trim()).filter(Boolean);

const HA_BASE = process.env.HA_BASE || OPT.ha_base || (inAddon ? 'http://homeassistant:8123' : 'http://homeassistant.mgmt:8123');
const HA_WS = HA_BASE.replace(/^http/, 'ws') + '/api/websocket';     // browser ws relay target
// Port precedence: PORT env (dev) > `port` add-on option > 9123. Under host_network the
// add-on binds this directly on the host, so the option is the only way to move it off
// 9123 (the Network tab can't remap a host-network port) — see issue #6.
const PORT = parseInt(process.env.PORT || OPT.port || '9123', 10);
// The Ingress panel + JSON API live on their own port, deliberately NOT on PORT: everything
// on PORT is the proxied Home Assistant namespace, and a dashboard whose url_path collided
// with a stats path would be a genuinely confusing failure. Fixed rather than an option
// because Supervisor reads `ingress_port` from config.yaml at install time — an option the
// user could change would silently break the sidebar panel.
const STATS_PORT = parseInt(process.env.STATS_PORT || '8100', 10);
const DASH_PATHS = toList(OPT.dashboards ?? (process.env.DASH_PATHS || process.env.DASH_PATH));
// strip_entities: true (default) = inject the allowlist so HA streams only needed entities.
//   false = pass the websocket straight through (full firehose) for A/B comparison.
const STRIP = OPT.strip_entities !== undefined ? !!OPT.strip_entities
  : (process.env.STRIP_ENTITIES ?? process.env.TRIM) !== '0';
// HA's own websocket negotiates permessage-deflate. `ws` does NOT enable it server-side by
// default, so simply putting this proxy in front of HA silently REMOVED compression from the
// browser leg — the kiosk went from deflated frames to plaintext JSON over wifi. Default on
// to restore what clients had before the proxy existed; the cost is deflate CPU on the HA
// host, which is why it can be turned off on very weak hardware.
const COMPRESS_WS = OPT.compress_websocket !== undefined ? !!OPT.compress_websocket
  : (process.env.COMPRESS_WS ?? '1') !== '0';

// `get_services` is every service of every integration, and it is sent on every page load:
// 193KB across 115 domains on the instance this was built against, of which only 45 domains
// had any entity at all. The frontend needs it for service pickers and the automation
// editor, so trimming it to the domains a connection can see is the same trade as
// trim_resources — fine for a kiosk, visibly lossy in the admin UI. Off by default.
const TRIM_SERVICES = OPT.trim_services !== undefined ? !!OPT.trim_services
  : (process.env.TRIM_SERVICES ?? '0') !== '0';

// Lovelace resources are instance-wide: HA has no per-dashboard scoping, so every kiosk
// downloads, parses and compiles EVERY custom card in the install. Measured on the instance
// this was built against: 45 resources, 21MB of JavaScript, for a wall panel that uses four
// custom card types. With states and registries already trimmed, this is what the load time
// actually consists of — ~73% of the main thread's busy time is module parse/compile, not
// script execution, style or layout.
//
// Off by default. Unlike entity trimming, a wrongly dropped resource is *visible* — a card
// renders as "Custom element doesn't exist" — so this is opt-in, and every drop is logged.
const TRIM_RESOURCES = OPT.trim_resources !== undefined ? !!OPT.trim_resources
  : (process.env.TRIM_RESOURCES ?? '0') !== '0';
const RES_ALWAYS = parseRules(OPT.resources_always_forward ?? process.env.RESOURCES_ALWAYS_FORWARD);
const RES_NEVER = parseRules(OPT.resources_never_forward ?? process.env.RESOURCES_NEVER_FORWARD);

// allowlist-precompute connection (add-on: supervisor proxy + SUPERVISOR_TOKEN)
const ALLOW_WS_URL = process.env.ALLOW_WS_URL || OPT.allow_ws_url || (inAddon ? 'ws://supervisor/core/websocket' : HA_WS);
const ALLOW_TOKEN = process.env.ALLOW_TOKEN || process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN;

// allow/deny overrides — each entry is a literal entity_id or a /regex/ (optional flags).
function parseRules(v) {
  return toList(v).map((tok) => {
    const m = tok.match(/^\/(.*)\/([a-z]*)$/);
    return m ? { re: new RegExp(m[1], m[2] || undefined) } : { literal: tok };
  });
}
const ALWAYS = parseRules(OPT.always_forward ?? process.env.ALWAYS_FORWARD);
const NEVER = parseRules(OPT.never_forward ?? process.env.NEVER_FORWARD);
// Per-dashboard always/never, on top of the global lists above.
//
// The global lists are the right shape for something every dashboard needs (a clock, an
// Assist pipeline). They are the wrong shape for something ONE dashboard needs: forcing
// `update.*` in globally to fix a sidebar counter on the admin dashboard added 252 entities
// to a wall panel that shows four lights, which is most of the trimming given back.
// User-Agent patterns that name a dashboard, used ONLY as a last-resort attribution fallback.
//
// The companion app's native connection never fetches a dashboard page, so it has neither a
// cookie nor an IP hint and lands on the union — 390 entities where the app actually shows one
// dashboard. Its User-Agent does identify it (`io.robbie.HomeAssistant`), so it can stand in
// for the missing page GET. Deliberately last: a real signal always wins, and a UA is
// trivially spoofed, so it may only ever pick between dashboards the add-on already serves.
const UA_DASHBOARDS = (() => {
  const raw = OPT.user_agent_dashboards
    ?? (process.env.UA_DASHBOARDS ? JSON.parse(process.env.UA_DASHBOARDS) : []);
  return (Array.isArray(raw) ? raw : [])
    .filter((o) => o && typeof o.match === 'string' && typeof o.dashboard === 'string')
    .map((o) => ({ ...parseRules([o.match])[0], dashboard: o.dashboard }));
})();

// user (lower-cased name, or id) -> { always: rules, never: rules }
//
// Per-USER rules, because per-dashboard cannot express "David sees update.* on lovelace but
// Michelle does not" — they load the same dashboard. The identity comes from the browser's own
// auth token, resolved once per session against HA's `auth/current_user`.
// A list, not a map: a user may have several rules, and each may be scoped to one dashboard.
// `dashboard` omitted means "any dashboard this user opens".
const USER_RULES = (() => {
  const raw = OPT.user_overrides
    ?? (process.env.USER_OVERRIDES ? JSON.parse(process.env.USER_OVERRIDES) : []);
  return (Array.isArray(raw) ? raw : [])
    .filter((o) => o && typeof o.user === 'string')
    .map((o) => ({
      user: o.user.toLowerCase(),
      dashboard: typeof o.dashboard === 'string' && o.dashboard ? o.dashboard : null,
      always: parseRules(o.always_forward),
      never: parseRules(o.never_forward),
    }));
})();

// dash -> { always: rules, never: rules }
const PER_DASH_RULES = new Map(
  (() => {
    const raw = OPT.dashboard_overrides
      ?? (process.env.DASHBOARD_OVERRIDES ? JSON.parse(process.env.DASHBOARD_OVERRIDES) : []);
    return Array.isArray(raw) ? raw : [];
  })()
    .filter((o) => o && typeof o.dashboard === 'string')
    .map((o) => [o.dashboard, {
      always: parseRules(o.always_forward),
      never: parseRules(o.never_forward),
    }]),
);
// Rules pinned to a physical CLIENT rather than to a dashboard or a user.
//
// Some entities belong to the device in front of you, not to whatever page it happens to be
// showing. A browser-based voice satellite is the clearest case: `assist_satellite.office_panel`
// and its twenty siblings are only ever useful to the one panel that IS that satellite, and a
// dashboard-scoped rule gets this wrong in both directions — the panel loses them the moment it
// navigates elsewhere, and every other client opening that dashboard pays for them.
//
// `client` is an IP, a CIDR, or a hostname. Hostnames are resolved when the allowlist is built
// (see resolveClientRules): a DHCP lease can move, and a name that resolves through your own DNS
// keeps working when it does. Note mDNS/`.local` names generally do NOT resolve from inside the
// container — use a real DNS record, which a UniFi client reservation can provide.
//
// `devices` names whole DEVICES, by registry name or id, and expands to every entity that device
// owns. That is deliberately coarser than listing entity ids: a voice satellite integration adds
// entities between releases, and a rule that has to be re-edited to keep working is a rule that
// silently stops working.
const CLIENT_RULES = (() => {
  const raw = OPT.client_overrides
    ?? (process.env.CLIENT_OVERRIDES ? JSON.parse(process.env.CLIENT_OVERRIDES) : []);
  return (Array.isArray(raw) ? raw : [])
    .filter((o) => o && typeof o.client === 'string' && o.client.trim())
    .map((o) => ({
      client: o.client.trim(),
      devices: toList(o.devices),
      always: parseRules(o.always_forward),
      never: parseRules(o.never_forward),
      // Filled in by resolveClientRules once DNS and the device registry are available.
      ips: new Set(), cidr: null, deviceEntities: [],
    }));
})();

// Which entity_category buckets to drop when a DEVICE is expanded — by a card that names one,
// or by a client rule. Home Assistant labels entities `config` (controls that configure the
// device: panel brightness, a reset button) and `diagnostic` (readings about its health: last
// seen, firmware, signal). A litter robot carries 21 entities and a card rendering a fill level
// needs a handful.
//
// Empty by DEFAULT, deliberately. Whether a given card renders `status_code` is not knowable
// from here, and a wrongly dropped entity blanks part of a card with no error anywhere — the
// same silent failure this add-on keeps having to fix. The breakdown is logged on every expansion
// so the saving can be seen BEFORE it is taken.
const EXCLUDE_DEVICE_CATEGORIES = toList(
  OPT.exclude_device_categories ?? process.env.EXCLUDE_DEVICE_CATEGORIES,
).filter((c) => ['config', 'diagnostic'].includes(c));

const matchesAny = (rules, id) => rules.some((r) => (r.re ? r.re.test(id) : r.literal === id));

if (!ALLOW_TOKEN) {
  console.error('ERROR: need a token (SUPERVISOR_TOKEN / HA_TOKEN / ALLOW_TOKEN).');
  process.exit(1);
}
// No dashboards is a config error, but exiting would just hand the Supervisor a restart loop
// (and a fresh install starts here). Stay up and say what to set; with an empty allowlist the
// upgrade gate refuses /api/websocket, so we never fall back to relaying the firehose.
if (!DASH_PATHS.length) {
  console.error('ERROR: no dashboards configured — set the `dashboards` option to your dashboard url_path values (Settings -> Dashboards). Until then /api/websocket is refused.');
}
const log = (...a) => console.log(new Date().toISOString(), ...a);

// While HA is down (a restart, or a host boot where core isn't up yet) every kiosk retry and
// every in-flight stream produces the SAME error, hundreds of times a second — that flood is
// what made the old logs unreadable. Collapse repeats: log the first occurrence of a key
// immediately, then at most one summary line per window with the suppressed count.
const THROTTLE_MS = 10000;
const throttleState = new Map();
function logThrottled(key, msg) {
  const t = throttleState.get(key);
  if (t) { t.n++; t.msg = msg; return; }
  log(msg);
  const timer = setTimeout(() => {
    const s = throttleState.get(key);
    throttleState.delete(key);
    if (s?.n) log(`${s.msg} (repeated ${s.n}x in the last ${THROTTLE_MS / 1000}s)`);
  }, THROTTLE_MS);
  timer.unref?.();                       // never hold the process open just to flush a log
  throttleState.set(key, { n: 0, msg, timer });
}

// Last-resort safety net. An HA restart resets every in-flight socket at once (camera
// streams, Assist pipelines, the browser's own connections), and a socket that errors before
// http-proxy has attached its handlers reaches Node as an unhandled 'error' event — which
// killed the whole add-on (`throw er` / `read ECONNRESET`), turning an HA reboot into a
// crash-restart loop. Transient network errnos are logged and swallowed; anything else is a
// real bug and still exits loudly.
// Socket-level errnos ONLY. DNS failures (ENOTFOUND/EAI_AGAIN) are deliberately excluded:
// under host_network the internal `homeassistant`/`supervisor` names may genuinely not
// resolve, and that misconfiguration should stay loud rather than be swallowed.
const NET_ERRNOS = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']);
const survivable = (e, what) => {
  if (!NET_ERRNOS.has(e?.code)) return false;
  logThrottled(`${what}:${e.code}`, `ignored ${what} (${e.code}): ${e.message}`);
  return true;
};
process.on('uncaughtException', (e) => {
  if (survivable(e, 'socket error')) return;
  console.error('fatal uncaught exception:', e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  if (survivable(e, 'rejection')) return;
  console.error('fatal unhandled rejection:', e);
  process.exit(1);
});

// ALLOW is the UNION across every configured dashboard. It stays the fallback for any
// connection we can't attribute to one dashboard, so behaviour never regresses below
// "what this add-on did before per-dashboard trimming existed".
let ALLOW = new Set();
// url_path -> that dashboard's own allowlist (overrides already applied). A kiosk that only
// ever shows one dashboard has no business receiving the other dashboards' entities: on the
// instance this was built against the union was 388 entities while the kiosk's own dashboard
// needed 60, so the union costs a small panel ~6x more state than it can display.
let ALLOW_BY_DASH = new Map();
// per_dashboard: serve each connection only its own dashboard's entities. Off => every
// connection gets the union (the pre-2026.09 behaviour), which is also the automatic
// fallback whenever a connection can't be attributed.
const PER_DASH = OPT.per_dashboard !== undefined ? !!OPT.per_dashboard
  : (process.env.PER_DASHBOARD ?? '1') !== '0';
// trim_registries: also cut the entity/device/area registries to what the connection can
// see. Separate from strip_entities because it is the more invasive of the two — states are
// self-describing, whereas a registry row missing here makes the frontend treat the entity as
// unregistered. Default on; turn it off first if something renders oddly.
const TRIM_REGISTRIES = OPT.trim_registries !== undefined ? !!OPT.trim_registries
  : (process.env.TRIM_REGISTRIES ?? '1') !== '0';
// Every live browser <-> HA bridge, so a grown allowlist can reach already-open pages
// (issue #7). See refreshOpenConnections().
const openBridges = new Set();
// False until the first allowlist lands. HA may still be booting when we start, and injecting
// an EMPTY allowlist would render every card "unavailable" until a manual reload — so until
// this flips we refuse /api/websocket upgrades instead (the frontend just keeps retrying).
let ALLOW_READY = false;
// Every entity_id on the instance, from the last allowlist build. User rules are applied per
// connection, long after buildAllow has returned, so a /regex/ needs something to expand over.
let REAL_IDS = [];

// HA events that can change the computed allowlist: a dashboard edit, or a registry change
// that alters what an area/label/device/integration auto-entities filter resolves to.
// Registry fields a rebuild can safely ignore.
//
// `entity_registry_updated` fires for far more than the allowlist depends on. Measured on a
// live instance: 24 full rebuilds in 14 minutes, EVERY one reporting "+0 -0" — a full
// get_states over 9,592 entities plus all four registries, roughly 20MB pulled from Home
// Assistant each time, to change nothing.
//
// Listed here are fields that cannot move an allowlist. Everything else — including anything
// unrecognised — still rebuilds, because the asymmetry runs the usual way: a wasted rebuild
// costs bandwidth, a skipped one serves a dashboard entities it no longer has.
const IGNORABLE_REGISTRY_FIELDS = new Set([
  'options',                 // per-domain display settings, e.g. sensor precision
  'capabilities',
  'supported_features',
  'unit_of_measurement',
  'previous_unique_id',
  'suggested_object_id',
]);

// Does this registry event plausibly change what a dashboard resolves to?
function registryEventMatters(eventType, data) {
  if (eventType !== 'entity_registry_updated') return true;
  // create/remove always matter: a new entity can match a filter, a removed one must go.
  if (data?.action !== 'update') return true;
  const changed = data?.changes && typeof data.changes === 'object' ? Object.keys(data.changes) : null;
  if (!changed || !changed.length) return true;       // shape we don't understand -> rebuild
  if (changed.some((k) => !IGNORABLE_REGISTRY_FIELDS.has(k))) return true;
  logThrottled('reg-noop', `entity_registry_updated ignored (only ${changed.join(', ')} changed)`);
  return false;
}

const WATCH_EVENTS = ['lovelace_updated', 'entity_registry_updated', 'device_registry_updated', 'area_registry_updated', 'label_registry_updated'];

// Allowlist for one dashboard = entities used across ALL its views. Two passes unioned:
//  1) structured walk (explicit cards + auto-entities filter expansion)
//  2) every REAL entity id appearing anywhere in the config text (catches ids inside
//     button-card / mushroom-template / decluttering templates the walker can't parse).
// Over-including is harmless (still tiny vs the instance); under-including breaks cards.
// "21 entities (12 primary, 6 config, 3 diagnostic)" — the number next to the trade-off, so a
// person can decide whether excluding a bucket is worth it instead of guessing.
function describeDeviceSplit(rows = []) {
  const s = splitDeviceEntities(rows);
  return `(${s.primary.length} primary, ${s.config.length} config, ${s.diagnostic.length} diagnostic)`;
}

function allowlistFor(cfg, states, registries, renderedTemplates) {
  const real = new Set(states.map((s) => s.entity_id));
  // overInclude: forward every entity a card COULD show (don't shrink on volatile
  // state/attributes filters); registries resolve area/label/device/integration filters.
  const extracted = extractEntities(cfg, states, {
    registries, overInclude: true, renderedTemplates,
    excludeDeviceCategories: EXCLUDE_DEVICE_CATEGORIES,
  });
  const out = new Set(extracted.entities);
  // Cards configured with a device are the single biggest source of entities nobody asked for,
  // so name them and show what each costs. Silence here would hide the whole trade-off.
  if (extracted.devices?.length) {
    const byDev = buildRegistryCtx(registries).byDevice;
    const names = new Map((registries?.devices || []).map((d) => [d.id, d.name_by_user || d.name || d.id]));
    for (const id of extracted.devices) {
      const rows = byDev.get(id) || [];
      log(`    card names device "${names.get(id) ?? id}": +${deviceEntityIds(rows, EXCLUDE_DEVICE_CATEGORIES).length} entities ${describeDeviceSplit(rows)}`);
    }
  }
  const text = JSON.stringify(cfg);
  const re = /[a-z_][a-z0-9_]*\.[a-z0-9_]+/g;
  let m;
  while ((m = re.exec(text))) if (real.has(m[0])) out.add(m[0]);
  // Finally pull in group members: a card can name only the group (or expand it client-side
  // via `show_group_members`) while the members appear nowhere in the config text (issue #4).
  return expandGroupMembers(out, states);
}

// Fetch the area/device/entity/label registries so auto-entities `area`/`label`/`device`/
// `integration` filters resolve (issue #4). Each is optional — on older HA or a permission
// error we degrade to the pre-registry behavior (those filters just match nothing) rather
// than failing the whole allowlist build.
async function fetchRegistries(rpc) {
  const get = async (type) => { try { return await rpc({ type }); } catch (e) { log(`  registry ${type} unavailable: ${e.message}`); return []; } };
  const [areas, devices, entities, labels] = await Promise.all([
    get('config/area_registry/list'),
    get('config/device_registry/list'),
    get('config/entity_registry/list'),
    get('config/label_registry/list'),
  ]);
  return { areas, devices, entities, labels };
}

// When a dashboard can't be fetched, the single most useful thing to print is the list of
// url_paths that DO exist — otherwise the log just repeats `config_not_found` forever and the
// user has no way to tell a typo from an HA that isn't ready. Throttled, because a failing
// dashboard re-fails on every registry event. Best-effort: never let this break a build.
async function logAvailableDashboards(rpc) {
  try {
    const list = await rpc({ type: 'lovelace/dashboards/list' });
    const paths = (Array.isArray(list) ? list : []).map((d) => d.url_path).filter(Boolean);
    // The default dashboard has a null url_path and is reachable as `lovelace`.
    logThrottled('dash-list', `  dashboards on this HA: ${['lovelace', ...paths].join(', ')}`);
    logThrottled('dash-hint', '  set the `dashboards` option to the url_path values above (Settings -> Dashboards)');
  } catch (e) {
    logThrottled('dash-list-fail', `  (could not list available dashboards: ${e.message})`);
  }
}

// Render every `filter.template` in a dashboard config through HA, so auto-entities cards
// whose entity list only exists after Jinja evaluation resolve too (issue #4). Best-effort
// per template: a template that errors or times out just contributes nothing, exactly as
// before, rather than failing the whole dashboard.
async function renderTemplates(cfg, renderTemplate) {
  const out = new Map();
  if (!renderTemplate) return out;
  const tpls = collectTemplates(cfg);
  if (!tpls.length) return out;
  const results = await Promise.all(tpls.map(async (t) => {
    try { return [t, await renderTemplate(t)]; }
    catch (e) { logThrottled(`tpl:${e.message}`, `  auto-entities template not rendered (${e.message})`); return null; }
  }));
  results.filter(Boolean).forEach(([t, r]) => out.set(t, r));
  if (out.size) log(`  rendered ${out.size}/${tpls.length} auto-entities template filter(s)`);
  return out;
}

// Apply the always/never overrides to one dashboard's set. Done PER DASHBOARD, not just to
// the union: `always_forward` exists for entities no card names — the Assist pipeline and
// wake-word entities a Voice Satellite card drives, say — and those are needed on whichever
// dashboard the kiosk actually has open, not merely somewhere in the union.
// `dash` is the dashboard this set belongs to, or null for the union. Per-dashboard rules are
// applied ON TOP of the global ones, and the never list still wins last — a global `never` is
// a statement about the whole instance, so a per-dashboard `always` must not override it.
function applyOverrides(set, realIds, dash = null) {
  const extra = (dash && PER_DASH_RULES.get(dash)) || { always: [], never: [] };
  const out = new Set(set);
  [...ALWAYS, ...extra.always].forEach((r) => {
    if (r.literal) out.add(r.literal);
    else realIds.forEach((eid) => { if (r.re.test(eid)) out.add(eid); });
  });
  [...out].forEach((eid) => {
    if (matchesAny(NEVER, eid) || matchesAny(extra.never, eid)) out.delete(eid);
  });
  return out;
}

// Build the per-dashboard allowlists (and their union) using an authed rpc().
async function buildAllow(rpc, renderTemplate) {
  const states = await rpc({ type: 'get_states' });
  const realIds = states.map((s) => s.entity_id);
  REAL_IDS = realIds;
  // The control connection asks for every state by definition, so this is the instance size.
  // Do NOT learn it from a browser's get_states instead: the modern frontend subscribes
  // rather than polling, so that path can go a whole uptime without ever firing.
  INSTANCE_ENTITIES = states.length;
  const byId = new Map(states.map((st) => [st.entity_id, st]));
  const registries = await fetchRegistries(rpc);
  // Resolve client-pinned rules here: the device registry has just been fetched, and doing it
  // on every rebuild means a renamed device or a moved DHCP lease is picked up without a restart.
  await resolveClientRules(registries);
  const union = new Set();
  const perDash = new Map();
  const keysByDash = new Map();
  let failed = 0;
  for (const p of DASH_PATHS) {
    try {
      const cfg = await rpc({ type: 'lovelace/config', url_path: p });
      const tpls = await renderTemplates(cfg, renderTemplate);
      const set = allowlistFor(cfg, states, registries, tpls);
      log(`  ${p}: ${set.size} entities`);
      perDash.set(p, set);
      // Resource keys come from the dashboard config AND from the icons of the entities
      // this dashboard shows. The second half matters: an entity's icon usually lives in
      // the entity registry, not in any dashboard's YAML, so a config-only scan misses it
      // and drops the icon pack that renders it. Measured here: 20 entities carry `phu:`
      // icons set in the registry, and the string "phu" appears in no dashboard config.
      keysByDash.set(p, resourceKeys(cfg, set, byId));
      set.forEach((e) => union.add(e));
    } catch (e) { failed++; log(`  ${p}: FAILED ${e.message}`); }
  }
  // Any failure at all is worth naming the alternatives for: `config_not_found` means the
  // url_path simply isn't a dashboard on this instance, and the fix is always "look at what
  // is actually there". Cheap, and it turns a repeating FAILED line into a self-answering one.
  if (failed) await logAvailableDashboards(rpc);
  // A single dashboard failing is a config error (a typo'd url_path) and must not stop the
  // others from being served. EVERY dashboard failing is something else: an HA that is up
  // enough to authenticate but not yet to serve lovelace — precisely what a core restart
  // looks like from here. Bail so the caller retries, rather than committing an empty
  // allowlist that nothing would rebuild (no dashboard edit follows a restart).
  if (DASH_PATHS.length && failed === DASH_PATHS.length) {
    throw new Error(`no dashboard config available yet (all ${failed} failed) — HA not ready, or none of these url_paths exist`);
  }
  const baseN = union.size;
  for (const [p, set] of perDash) perDash.set(p, applyOverrides(set, realIds, p));
  // The union takes every per-dashboard set after ITS own overrides, so an unattributed
  // connection is never served less than the dashboard it might actually be showing.
  for (const set of perDash.values()) set.forEach((e) => union.add(e));
  const withOverrides = applyOverrides(union, realIds);
  // Registry reachability is computed against the UNION deliberately: a connection served a
  // single dashboard's entities may still legitimately name a device or area belonging to
  // another, and a device row wrongly dropped costs a name with no bandwidth saving worth it.
  if (TRIM_REGISTRIES) {
    rebuildRegCache(registries, withOverrides);
    log(`  registry reach: ${REG_CACHE.devices.size} device(s), ${REG_CACHE.areas.size} area(s)`);
  }
  await buildResources(rpc, keysByDash);
  const afterAlways = new Set([...union, ...withOverrides]).size;
  log(`overrides: base ${baseN}, +always ${afterAlways - baseN}, -never ${afterAlways - withOverrides.size}`);
  if (PER_DASH) log(`  per-dashboard: ${[...perDash].map(([p, s]) => `${p}=${s.size}`).join(', ')} (union ${withOverrides.size})`);
  return { union: withOverrides, perDash };
}

// Swap in a freshly-computed allowlist and log exactly what changed — the entity ids
// added and removed, not just the new total (issue #7). This makes it visible from the
// add-on log whether a dashboard edit's recompute actually picked up the entities you
// expect. Remember: the new list only affects NEW ws connections — an already-open kiosk
// page must be reloaded to use it.
// `merge` unions with the current list instead of replacing it, and is used for the rebuild
// after a reconnect. A core that has just restarted can answer with a partially-loaded state
// machine, so the rebuild legitimately comes back SHORT — and since no dashboard edit follows
// a restart, nothing would ever rebuild it, leaving cards permanently "unavailable". Over-
// including is harmless here by design (see allowlistFor); under-including breaks cards. An
// actual dashboard/registry edit still replaces, so removals take effect.
function applyAllow(built, why, { merge = false } = {}) {
  let next = built.union;
  let nextByDash = built.perDash;
  if (merge) {
    next = new Set([...ALLOW, ...next]);
    // Merge per dashboard too, for the same reason the union is merged: a core that has just
    // restarted can answer a rebuild with a partial state machine, and a dashboard that came
    // back short would otherwise permanently lose entities nothing will rebuild.
    const merged = new Map(ALLOW_BY_DASH);
    for (const [p, s] of nextByDash) merged.set(p, new Set([...(ALLOW_BY_DASH.get(p) ?? []), ...s]));
    nextByDash = merged;
  }
  const added = [...next].filter((e) => !ALLOW.has(e)).sort();
  const removed = [...ALLOW].filter((e) => !next.has(e)).sort();
  ALLOW = next;
  ALLOW_BY_DASH = nextByDash;
  // Retire the cached registry answers whenever the allowlist actually moved. Without this
  // the cache key (which embeds ALLOW_VERSION) is unchanged by a recompute, so a dashboard
  // edit keeps being answered from registries trimmed to the PREVIOUS allowlist. The growth
  // case is the damaging one: refreshOpenConnections() below recycles every open kiosk
  // precisely so it picks up the new entities, and a stale cache would then hand those
  // reconnections registry rows that omit them — names and areas silently failing to resolve
  // on exactly the entities that were just added. Only the reconnect path used to bump this.
  if (added.length || removed.length) { ALLOW_VERSION++; REG_RESPONSE_CACHE.clear(); }
  const fmt = (a) => (a.length > 25 ? `${a.slice(0, 25).join(', ')} …(+${a.length - 25} more)` : a.join(', '));
  log(`allowlist ${why}: ${ALLOW.size} entities (+${added.length} -${removed.length})`);
  if (added.length) log(`  +added: ${fmt(added)}`);
  if (removed.length) log(`  -removed: ${fmt(removed)}`);
  if (!added.length && !removed.length) log('  (no change)');
  if (added.length) refreshOpenConnections();
}

// `subscribe_entities` is sent ONCE per connection and HA has no way to amend a live
// subscription, so a recompute only ever affected NEW connections — an already-open kiosk
// kept streaming its original entity list until someone reloaded the tab (issue #7).
// Dropping the browser socket fixes that: the HA frontend treats it as an ordinary
// disconnect, reconnects on its own, and re-subscribes against the current allowlist.
// Only on GROWTH. A shrink means the open page is carrying entities it no longer needs,
// which is harmless — and churning every kiosk over a removal would be a bad trade.
function refreshOpenConnections() {
  if (!STRIP || !openBridges.size) return;
  log(`  reconnecting ${openBridges.size} open dashboard connection(s) to pick up the new entities`);
  for (const close of [...openBridges]) { try { close(); } catch {} }
}

// ---- persistent control connection: compute the allowlist + watch for dashboard edits ----
// One long-lived HA ws (the supervisor proxy in add-on mode). After auth it builds the
// allowlist once (resolving boot), then subscribes to `lovelace_updated` and rebuilds on
// every dashboard save — so card edits take effect without an add-on restart. Reconnects
// with backoff on drop so live updates keep working for the life of the add-on.
// Resolves with the first allowlist and NEVER rejects: a failure *before* the first allowlist
// (HA restarting, core still booting, the supervisor proxy answering 502) is retried with the
// same backoff as any later drop. It used to reject, and boot turned that into `process.exit(2)`
// — so an HA reboot put the add-on into a ~300ms crash/restart loop instead of just waiting.
function startController() {
  return new Promise((resolve) => {
    let settled = false;
    let backoff = 1000;
    let recomputeTimer = null;
    let attempts = 0;

    const connect = () => {
      // handshakeTimeout: an HA that WEDGES mid-restart (accepts the TCP connection, never
      // completes the ws handshake) would otherwise never fire 'close' or 'error', so nothing
      // would ever schedule a reconnect and the add-on would sit at 503 forever looking healthy.
      const ws = new WebSocket(ALLOW_WS_URL, { handshakeTimeout: 15000 });
      let id = 1; const pending = {}; let gone = false;
      const rpc = (o) => { o.id = id++; return new Promise((res, rej) => { pending[o.id] = [res, rej]; ws.send(JSON.stringify(o)); }); };

      // `render_template` is a SUBSCRIPTION, not a one-shot: HA answers `result` (null)
      // immediately and then pushes an `event` carrying the rendered text, re-pushing it
      // whenever a referenced entity changes. We want a single snapshot, so we take the
      // first event and unsubscribe. Kept separate from rpc() precisely because rpc()
      // resolves on `result`, which for this command carries no output. (issue #4)
      const tplWaiters = new Map();
      const settleTpl = (tplId, err, value) => {
        const w = tplWaiters.get(tplId);
        if (!w) return;
        clearTimeout(w.timer);
        tplWaiters.delete(tplId);
        try { ws.send(JSON.stringify({ id: id++, type: 'unsubscribe_events', subscription: tplId })); } catch {}
        err ? w.rej(err) : w.res(value);
      };
      const renderTemplate = (template) => new Promise((res, rej) => {
        const tplId = id++;
        // A template referencing a slow or missing entity must not stall the whole rebuild.
        const timer = setTimeout(() => settleTpl(tplId, new Error('render_template timed out')), 10000);
        timer.unref?.();
        tplWaiters.set(tplId, { res, rej, timer });
        try { ws.send(JSON.stringify({ id: tplId, type: 'render_template', template, report_errors: false })); }
        catch (e) { settleTpl(tplId, e); }
      });

      // Debounce bursts of edits (the editor can fire several saves) into one rebuild.
      //
      // The debounce alone is not enough. It guards SCHEDULING, not execution: once the timer
      // fires, buildAllow() is awaited, and any event arriving during that await schedules a
      // fresh timer that fires while the first rebuild is still running. Measured on a live
      // instance, three rebuilds completed inside one second. So a rebuild in flight sets a
      // flag instead, and exactly one follow-up runs when it finishes.
      let rebuilding = false;
      let rebuildAgain = null;
      const runRecompute = async (why) => {
        if (rebuilding) { rebuildAgain = why; return; }
        rebuilding = true;
        try { applyAllow(await buildAllow(rpc, renderTemplate), `recomputed (${why})`); }
        catch (e) { log('recompute failed:', e.message); }
        finally {
          rebuilding = false;
          const next = rebuildAgain;
          rebuildAgain = null;
          if (next !== null) scheduleRecompute(next);
        }
      };
      const scheduleRecompute = (why) => {
        clearTimeout(recomputeTimer);
        recomputeTimer = setTimeout(() => runRecompute(why), 1500);
      };

      ws.on('message', async (raw) => {
        // Guarded: this handler is async, so a throw here becomes an unhandled rejection —
        // i.e. a process-level crash — and a restarting HA/supervisor can answer with
        // something that isn't JSON.
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: ALLOW_TOKEN }));
        // A bad token is a config error, not a transient one — but exiting would just hand the
        // Supervisor a restart loop, so say so loudly and keep retrying. Retry SLOWLY though:
        // in dev mode the control ws authenticates against HA directly, and a failed auth
        // every few seconds would walk into HA's login_attempts_threshold / ip_ban.
        if (m.type === 'auth_invalid') {
          logThrottled('auth_invalid', `ERROR: HA rejected the token (auth_invalid) — check the add-on's ${inAddon ? 'homeassistant_api permission' : 'HA_TOKEN'}`);
          backoff = Math.max(backoff, 60000);
          try { ws.close(); } catch {}
          return;
        }
        if (m.type === 'auth_ok') {
          try {
            backoff = 1000; attempts = 0;
            const next = await buildAllow(rpc, renderTemplate);
            if (!settled) {
              ALLOW = next.union; ALLOW_BY_DASH = next.perDash; ALLOW_VERSION++; REG_RESPONSE_CACHE.clear();
              settled = true; ALLOW_READY = true; resolve(ALLOW);
            }
            else applyAllow(next, 'recomputed (reconnect)', { merge: true });
            // lovelace_updated -> a dashboard's cards changed. The *_registry_updated
            // events -> a device moved area, a label was (un)assigned, etc., which can
            // change what an area/label/device/integration auto-entities filter resolves
            // to (issue #4). Rebuild (debounced) on any of them.
            for (const ev of WATCH_EVENTS) await rpc({ type: 'subscribe_events', event_type: ev });
            log(`watching ${WATCH_EVENTS.join(', ')} for live allowlist updates`);
          } catch (e) {
            // HA answered the handshake but died mid-build (a restart in progress). Drop the
            // socket so onGone() schedules a retry — never leave a half-set-up control ws.
            log('post-auth setup failed:', e.message);
            try { ws.close(); } catch {}
          }
          return;
        }
        // First render of a template subscription -> hand it back and unsubscribe.
        if (m.type === 'event' && tplWaiters.has(m.id)) {
          settleTpl(m.id, null, m.event?.result ?? '');
          return;
        }
        // An invalid template fails at `result` time and never emits an event.
        if (m.type === 'result' && tplWaiters.has(m.id) && !m.success) {
          settleTpl(m.id, new Error(m.error?.message || 'render_template failed'));
          return;
        }
        if (m.type === 'event' && WATCH_EVENTS.includes(m.event?.event_type)) {
          const ev = m.event.event_type;
          if (!registryEventMatters(ev, m.event.data)) return;
          const why = ev === 'lovelace_updated' ? (m.event.data?.url_path ?? '(default)') : ev;
          log(`${ev}: ${ev === 'lovelace_updated' ? why : ''}`.trim());
          scheduleRecompute(why);
          return;
        }
        if (m.type === 'result' && pending[m.id]) { const p = pending[m.id]; m.success ? p[0](m.result) : p[1](new Error(JSON.stringify(m.error))); delete pending[m.id]; }
      });

      const onGone = (e) => {
        if (gone) return; gone = true;
        if (e) logThrottled(`ctrl:${e.code || e.message}`, `control ws error: ${e.message}`);
        Object.values(pending).forEach(([, rej]) => rej(new Error('control ws closed')));
        [...tplWaiters.keys()].forEach((k) => settleTpl(k, new Error('control ws closed')));
        const state = settled ? `serving last allowlist: ${ALLOW.size}` : 'waiting for HA to come up';
        logThrottled('ctrl-down', `control ws down; reconnecting in ${backoff}ms (${state})`);
        // Never exiting means a genuine misconfiguration (a host that doesn't resolve, a
        // wrong ha_base) now looks like a healthy add-on that is merely waiting. Say the
        // quiet part out loud once we've clearly waited longer than a restart would take.
        if (!settled && ++attempts === 6) {
          log(`WARNING: still no allowlist after ${attempts} attempts to reach ${ALLOW_WS_URL}.`);
          log('  If HA is actually running, this add-on may not be able to resolve that name');
          log('  (common under host_network) — pin it with the `ha_base` / `allow_ws_url` options.');
        }
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
      ws.on('close', () => onGone());
      ws.on('error', (e) => onGone(e));
    };

    connect();
  });
}

// ---- HTTP passthrough to HA ----
// xfwd:true adds X-Forwarded-For/Proto/Host so HA's trusted_networks auth provider
// sees the real browser IP (needs http.use_x_forwarded_for + trusted_proxies on HA side).
// autoRewrite is deliberately OFF: it rewrites a redirect's HOST but never its SCHEME, which
// is an infinite redirect loop behind TLS termination (see rewriteLocation below). We do the
// whole job in a proxyRes handler instead — same condition, plus scheme and query params.
const proxy = httpProxy.createProxyServer({ target: HA_BASE, changeOrigin: true, ws: false, xfwd: true });

// The origin as the BROWSER sees it, which is not necessarily the one we were reached on.
// Note xfwd APPENDS our own hop to x-forwarded-proto (so Caddy's "https" becomes
// "https,http"), hence first-entry-wins. x-forwarded-host is not appended, so it keeps the
// outermost value. With no upstream proxy this yields exactly our own scheme/host.
function clientOrigin(req) {
  const first = (v) => String(v || '').split(',')[0].trim();
  return {
    proto: first(req.headers['x-forwarded-proto']) || 'http',
    host: first(req.headers['x-forwarded-host']) || req.headers.host || '',
  };
}

const TARGET_HOST = (() => { try { return new URL(HA_BASE).host; } catch { return ''; } })();

// Set scheme + authority on a URL. Deliberately NOT `url.host = host`: the WHATWG host setter
// keeps the existing port when the value it's given has none, so rewriting HA's
// `http://10.0.0.5:8123/...` to a port-less public host left `https://example.org:8123/...`.
// hostname/port must be set separately. The `]` check keeps IPv6 literals (`[::1]:8123`) intact.
function setOrigin(url, proto, host) {
  const i = host.lastIndexOf(':');
  const hasPort = i > host.lastIndexOf(']');
  url.protocol = `${proto}:`;
  url.hostname = hasPort ? host.slice(0, i) : host;
  url.port = hasPort ? host.slice(i + 1) : '';
}

// Point a redirect back at the origin the browser actually used.
//
// `changeOrigin` makes HA see the request as arriving at HA_BASE, so its absolute redirects
// come back naming HA's own address. http-proxy's `autoRewrite` fixed the host but left the
// scheme alone, so behind an HTTPS terminator the browser was sent from
// `https://ha.example.org/...` to `http://ha.example.org/...`; the edge proxy bounced it
// straight back to HTTPS, HA reissued the same redirect, and the page never loaded —
// `.../:8123./:8123./:8123./...` (issue #9).
//
// Query params matter just as much: HA's auth flow carries absolute URLs in `redirect_uri`,
// and autoRewrite never touched those, so login bounced the browser to HA's internal address
// — unreachable from outside the LAN.
function rewriteLocation(raw, proto, host, targetHost = TARGET_HOST) {
  if (!raw || !host) return raw;
  const base = `${proto}://${host}`;
  let u;
  try { u = new URL(raw, base); } catch { return raw; }
  // Rewrite when it points at HA itself, or already at the browser's host but on the wrong
  // scheme. Anything genuinely third-party is left alone.
  if (u.host === targetHost || u.host === host) setOrigin(u, proto, host);
  for (const key of ['redirect_uri', 'hass_url']) {
    const v = u.searchParams.get(key);
    if (!v) continue;
    try {
      const q = new URL(v);
      if (q.host === targetHost || q.host === host) {
        setOrigin(q, proto, host);
        u.searchParams.set(key, q.toString());
      }
    } catch { /* not an absolute URL — leave it */ }
  }
  // A relative Location stays relative; making it absolute would be a gratuitous change.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? u.toString() : u.pathname + u.search + u.hash;
}

proxy.on('proxyRes', (proxyRes, req) => {
  const loc = proxyRes.headers.location;
  if (!loc || proxyRes.statusCode < 300 || proxyRes.statusCode >= 400) return;
  const { proto, host } = clientOrigin(req);
  const next = rewriteLocation(loc, proto, host);
  if (next !== loc) {
    logThrottled(`redirect:${proto}:${host}`, `rewrote redirect for ${proto}://${host}: ${loc} -> ${next}`);
    proxyRes.headers.location = next;
  }
});
// Node reports dual-stack client IPs as IPv4-mapped IPv6 (e.g. ::ffff:192.168.5.247).
// HA's trusted_networks auth provider matches plain IPv4 subnets, and a mapped address
// won't match an IPv4 network — so normalize X-Forwarded-For to bare IPv4, or
// trusted-network (password-less) kiosk login silently falls through to a password prompt.
//
// Normalize IN PLACE, preserving the chain. This used to `setHeader('x-forwarded-for', ip)`,
// replacing the whole chain with our immediate peer — which broke every setup with another
// reverse proxy in front (issue #9). http-proxy's xfwd APPENDS our hop to all three headers,
// so behind e.g. Caddy HA received:
//     X-Forwarded-For:   <client>,<caddy>      (2 entries — then flattened by us to 1)
//     X-Forwarded-Proto: https,http            (2 entries)
// and HA's forwarded middleware raises HTTPBadRequest on
//     `len(forwarded_proto) not in (1, len(forwarded_for))`
// -> a hard 400 on every request. Keeping the chain intact keeps the counts in step, and
// preserves the real client IP through the upstream proxy instead of hiding it behind Caddy.
const normalizeXff = (v) => String(v).split(',').map((s) => s.trim().replace(/^::ffff:/, '')).filter(Boolean).join(', ');
// Stamp the dashboard onto the browser itself.
//
// The IP hint below is coarse by construction: every device behind one NAT shares it, so a
// phone and a laptop on the same WAN address overwrite each other's attribution and the
// loser is served another dashboard's allowlist until it reloads. A cookie is per-browser,
// which is the granularity actually wanted.
//
// The VALUE is the dashboard path, not an opaque id, so attribution stays stateless: there
// is no server-side map to lose on restart, and the proxy can be restarted mid-session
// without any client losing its scope. A tampered value can only name another configured
// dashboard, which is a set the client could already reach, so it grants nothing.
proxy.on('proxyRes', (proxyRes, req) => {
  if (!PER_DASH) return;
  const dash = dashFromUrl(req.url);
  if (!dash) return;
  const existing = proxyRes.headers['set-cookie'];
  const prior = Array.isArray(existing) ? existing : existing ? [existing] : [];
  proxyRes.headers['set-cookie'] = [
    ...prior,
    `${DASH_COOKIE}=${encodeURIComponent(dash)}; Path=/; Max-Age=31536000; SameSite=Lax`,
  ];
});

proxy.on('proxyReq', (proxyReq, req) => {
  const xff = proxyReq.getHeader('x-forwarded-for') ?? req.headers['x-forwarded-for'];
  if (xff) proxyReq.setHeader('x-forwarded-for', normalizeXff(xff));
});
// proxy.ws() never fires 'proxyReq' — it has its own event — so without this the websocket
// upgrade would carry the un-normalized IPv4-mapped form that HTTP no longer does.
proxy.on('proxyReqWs', (proxyReq, req) => {
  const xff = proxyReq.getHeader('x-forwarded-for') ?? req.headers['x-forwarded-for'];
  if (xff) proxyReq.setHeader('x-forwarded-for', normalizeXff(xff));
});
// Error arg is an http res for proxy.web() but a raw socket for proxy.ws() — handle both.
proxy.on('error', (e, req, res) => {
  logThrottled(`proxy:${e.code || e.message}`, `proxy error ${e.message}`);
  try {
    if (res && typeof res.writeHead === 'function') { res.writeHead(502); res.end('proxy error'); }
    else if (res && typeof res.destroy === 'function') res.destroy();   // ws upgrade socket
  } catch {}
});
// ---- registry trimming ----
// The frontend asks for these three registries on every load, and each is instance-wide.
// The entity registry in particular is one row per entity — the single largest payload left
// once states are trimmed, and the one that scales with instance size rather than with what
// the dashboard shows.
// A trimmed registry answer, reusable across connections.
//
// The registries are per-INSTANCE, not per-connection: for a given allowlist every client
// gets byte-identical rows. Without this, each connection that asks makes Home Assistant
// serialise the whole registry again — 16k rows and ~10MB for the entity registry here —
// and makes this proxy parse it again. A single kiosk load opens several websockets, and a
// handful of panels multiplies that into real CPU on the HA host for no new information.
//
// Keyed by allowlist VERSION as well as kind and dashboard, so a rebuild retires every
// entry rather than needing them hunted down; the rebuild also clears the map outright so
// stale generations cannot accumulate.
let ALLOW_VERSION = 0;
const REG_RESPONSE_CACHE = new Map();
const regCacheKey = (kind, dash) => `${kind}|${dash ?? '(union)'}|${ALLOW_VERSION}`;

const REGISTRY_TYPES = new Map([
  ['config/entity_registry/list', 'entity'],
  ['config/entity_registry/list_for_display', 'entity_display'],
  ['config/device_registry/list', 'device'],
  ['config/area_registry/list', 'area'],
]);

// Trim one registry result to what `allow` can reach. Entity rows are filtered directly;
// device and area rows are kept only when a surviving entity still points at them, so a
// card's "Kitchen / Ceiling Light" secondary text keeps resolving. Rows we don't understand
// are kept — over-including is harmless, under-including breaks names.
function trimRegistry(kind, rows, allow) {
  // `list_for_display` is NOT a list. It answers with an object — `{entity_categories,
  // entities}` — whose rows use two-letter keys (`ei` entity_id, `di` device_id, `ai`
  // area_id, `en` name, `pl` platform...). Measured on a 9,553-entity instance it is
  // 1.44MB, and it was the single largest thing the kiosk still downloaded: 58% of the
  // whole websocket load, because the array-shaped guard below passed it straight through.
  // Filter `entities` and leave `entity_categories` (a tiny id->name map) alone.
  if (kind === 'entity_display') {
    const list = rows?.entities;
    if (!Array.isArray(list) || !list.every((r) => r && typeof r === 'object' && 'ei' in r)) return rows;
    return { ...rows, entities: list.filter((r) => allow.has(r.ei)) };
  }
  if (kind === 'entity') {
    // Rows we don't understand are kept: over-including is harmless, under-including
    // breaks names.
    if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === 'object' && 'entity_id' in r)) return rows;
    return rows.filter((r) => allow.has(r.entity_id));
  }
  if (!Array.isArray(rows)) return rows;
  // Devices and areas are kept only where a surviving entity still reaches them, so a tile's
  // "Kitchen — Ceiling Light" secondary text still resolves. The reachable sets come from
  // REG_CACHE, built alongside the allowlist; if it's empty we haven't got a registry yet and
  // pass everything through rather than blanking names.
  const keep = kind === 'device' ? REG_CACHE.devices : REG_CACHE.areas;
  if (!keep.size) return rows;
  const idOf = (r) => (kind === 'device' ? r?.id : (r?.area_id ?? r?.id));
  return rows.filter((r) => keep.has(idOf(r)));
}

// Which devices/areas the current allowlist still reaches. Built from the control
// connection's own registry fetch, so a browser asking for devices before entities still
// gets a correct answer. Areas come from the entities directly AND from the devices those
// entities belong to, because an entity with no area_id of its own inherits its device's.
const REG_CACHE = { devices: new Set(), areas: new Set() };
function rebuildRegCache(registries, allow) {
  const devices = new Set();
  const areas = new Set();
  for (const r of registries?.entities ?? []) {
    if (!allow.has(r.entity_id)) continue;
    if (r.device_id) devices.add(r.device_id);
    if (r.area_id) areas.add(r.area_id);
  }
  for (const d of registries?.devices ?? []) {
    if (devices.has(d.id) && d.area_id) areas.add(d.area_id);
  }
  REG_CACHE.devices = devices;
  REG_CACHE.areas = areas;
}

// ---- per-dashboard Lovelace resources ----
// Namespaces the frontend resolves itself; an `mdi:` icon needs no custom resource.
const BUILTIN_ICON_NS = new Set(['mdi', 'hass', 'hassio', 'homeassistant', 'custom']);

const RESOURCE_CACHE = new Map();     // url -> { tested:Set, present:Set|null, bytes }
let RESOURCES_BY_DASH = new Map();    // dash -> Set(url) to keep
// Per-dashboard resource figures for the stats panel. Populated by buildResources().
let RESOURCE_STATS = new Map();       // dash -> { kept, dropped, keptKB, droppedKB }
// How big the instance actually is, taken from the control connection's own get_states —
// which asks for everything by definition. Lets the panel say "104 of 9,751", not just "104".
let INSTANCE_ENTITIES = 0;

// Every token a dashboard might need a resource FOR: `custom:x` card/row/badge/feature types,
// and icon-pack prefixes (`foo:bar` where foo isn't built in).
//
// These are matched as plain substrings against each resource's body rather than by scanning
// for `customElements.define(...)`. That looks like the rigorous approach and is in fact the
// broken one: big bundles (mushroom, 639KB) construct element names at runtime, so a define()
// scan finds almost nothing and would drop a resource the dashboard needs. The literal name
// is still present in the bundle, so a substring test finds it. Errs toward keeping — a false
// positive costs bytes, a false negative breaks a card.
// Both halves of the icon pattern must START WITH A LETTER, and keys shorter than
// MIN_KEY are discarded. That is not fussiness — a loose pattern here silently disables the
// whole feature. `16:9` (a picture card's aspect_ratio) and `06:00` (any schedule) match a
// digit-tolerant pattern and yield the keys "16" and "06", and a two-character string occurs
// in every minified bundle ever written, so every resource "matches" and nothing is dropped.
// Observed exactly that: 45 resources, 39 kept, 97KB saved instead of 18MB.
const MIN_KEY = 3;
function resourceKeys(cfg, allowed = null, byId = null) {
  const cards = new Set();      // custom card/row/badge/feature types
  const icons = new Set();      // non-builtin icon namespaces
  const addIcon = (ns) => { if (ns.length >= MIN_KEY && !BUILTIN_ICON_NS.has(ns)) icons.add(ns); };
  // Icons of the entities this dashboard actually shows, which are typically registry
  // values rather than anything written in the config.
  if (allowed && byId) {
    for (const id of allowed) {
      const ic = byId.get(id)?.attributes?.icon;
      if (typeof ic !== 'string') continue;
      const m = ic.match(/^([a-z][a-z0-9_]{2,15}):[a-z]/);
      if (m) addIcon(m[1]);
    }
  }
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') return Object.values(n).forEach(walk);
    if (typeof n !== 'string') return;
    if (n.startsWith('custom:') && n.length > 7 + MIN_KEY) cards.add(n.slice(7));
    const ic = n.match(/^([a-z][a-z0-9_]{2,15}):([a-z][a-z0-9-]*)$/);
    if (ic) addIcon(ic[1]);
  })(cfg);
  return { cards, icons };
}

// A card type split into candidate identifying parts. Split on `-` only: an underscore
// usually sits inside one meaningful word (`print_status`), and breaking it would leave
// fragments generic enough to match anything.
function cardFragments(type) {
  return type.split('-').filter((p) => p.length >= 4);
}

// How many resources contain each fragment, and the cutoff above which a fragment is too
// common to identify anything. MEASURED rather than a hand-maintained stop-word list: the
// first attempt at this used one, and `grid`, `layout`, `entity` and `progress` all slipped
// through it and matched nearly every bundle on the instance — which took one panel from
// 2,998KB to 11,876KB. A fragment present in a quarter of all resources says nothing.
let FRAG_DF = new Map();
let FRAG_DF_MAX = 0;
const isDistinctive = (f) => (FRAG_DF.get(f) || 0) <= FRAG_DF_MAX;
// A fragment so rare it effectively names one bundle. Kept separate from "distinctive"
// because the evidence is much stronger: "mushroom" appears in 2 files out of 48, so a bundle
// containing it is almost certainly the Mushroom bundle, whereas "cover" tells you nothing.
let FRAG_RARE_MAX = 2;
const isRare = (f) => (FRAG_DF.get(f) || 0) <= FRAG_RARE_MAX;

// Does this bundle look like it provides `type`?
//
// The literal name is the strong signal. The fragment fallback exists for bundles that BUILD
// their element names at runtime: `ha-bambulab-cards.js` is 3.2MB, a dashboard renders
// `ha-bambulab-print_status-card`, and that string appears nowhere in the file — only
// `bambulab` and `print_status` separately.
//
// The literal check is the reliable one, but plenty of card packs never write their own card
// names down: Mushroom registers elements from template literals, so "mushroom-cover-card"
// appears nowhere in mushroom.js. That is not an edge case — it silently dropped the entire
// Mushroom family, which is one of the most widely installed card sets there is.
//
// Two rules used to make that unavoidable, and both are gone:
//   - requiring EVERY fragment to be present, so one missing generic word ("cover") discarded
//     the bundle even when a near-unique one ("mushroom") was right there;
//   - requiring TWO distinctive fragments, which no `<oneword>-<generic>-card` name can ever
//     satisfy.
//
// Now: one RARE fragment is enough on its own, otherwise fall back to two merely distinctive
// ones. Erring toward keeping is the right bias — a resource kept needlessly costs bytes, a
// resource wrongly dropped breaks a card.
function cardMatchesBody(type, cached) {
  if (cached.literal.has(type)) return true;
  const present = cardFragments(type).filter((f) => cached.frags.has(f));
  if (!present.length) return false;
  if (present.some(isRare)) return true;
  return present.filter(isDistinctive).length >= 2;
}

// An icon namespace is matched two ways, and it needs both.
//
// A *user* of the namespace writes `cbi:bulb`, so the colon form finds them. Matching the
// bare namespace instead is how the 3-character `cbi` came to keep 4.8MB of bundles that
// merely contained those letters in base64 blobs and minified identifiers — `cbi:` appeared
// in none of them.
//
// But the *provider* never writes the colon form at all: it registers the namespace as a
// key, `customIconsets["cil"]`. Matching only the colon form drops the very bundle that
// serves the icons, which is what happened to custom-icons.js, the provider of `cil:`.
const ICON_REG = (ns) => new RegExp('customIcons(?:ets)?\\s*\\[\\s*[\'"`]' + ns + '[\'"`]');
const bodyHasIcon = (body, ns) => body.includes(ns + ':') || ICON_REG(ns).test(body);

// never > always > content match > fail-open. A resource we could not read is always kept:
// being unable to check is not evidence it is unused.
// Resource rules match on a SUBSTRING of the URL, not the whole of it — unlike entity rules,
// which compare entity_ids exactly. Nobody wants to write out
// `/hacsfiles/kiosk-mode/kiosk-mode.js?hacstag=1234567890`; they want to write `kiosk-mode`.
const matchesUrl = (rules, url) => rules.some((r) => (r.re ? r.re.test(url) : url.includes(r.literal)));

function keepResource(url, keys) {
  if (matchesUrl(RES_NEVER, url)) return false;
  if (matchesUrl(RES_ALWAYS, url)) return true;
  const c = RESOURCE_CACHE.get(url);
  if (!c || c.unreadable) return true;            // cannot check, so keep
  for (const k of keys.icons) if (c.icons.has(k)) return true;
  for (const k of keys.cards) if (cardMatchesBody(k, c)) return true;
  return false;
}

async function buildResources(rpc, keysByDash) {
  if (!TRIM_RESOURCES) return;
  let rows;
  try { rows = await rpc({ type: 'lovelace/resources' }); }
  catch (e) { log(`  resources: FAILED (${e.message}) — forwarding all resources`); RESOURCES_BY_DASH = new Map(); RESOURCE_STATS = new Map(); return; }
  if (!Array.isArray(rows)) { RESOURCES_BY_DASH = new Map(); RESOURCE_STATS = new Map(); return; }

  // Every token any dashboard could match on, tagged by kind so a card type and an icon
  // namespace that happen to share a name can never be confused for one another.
  const unionCards = new Set(), unionIcons = new Set();
  for (const ks of keysByDash.values()) {
    ks.cards.forEach((k) => unionCards.add(k));
    ks.icons.forEach((k) => unionIcons.add(k));
  }
  const unionFrags = new Set();
  for (const c of unionCards) for (const f of cardFragments(c)) unionFrags.add(f);
  const unionKeys = new Set([...[...unionCards].map((k) => 'card:' + k),
                             ...[...unionIcons].map((k) => 'icon:' + k),
                             ...[...unionFrags].map((k) => 'frag:' + k)]);
  // One fetch per resource, tested against every dashboard's keys at once. Bodies are read
  // and discarded one at a time — the whole set is ~21MB on a large install and must not be
  // held in memory. The cache is keyed by URL, which carries HACS's version tag, so an
  // updated card re-fetches on its own.
  for (const r of rows) {
    const c = RESOURCE_CACHE.get(r.url);
    if (c && [...unionKeys].every((k) => c.tested.has(k))) continue;
    try {
      const abs = /^https?:/i.test(r.url) ? r.url : HA_BASE + r.url;
      const body = await (await fetch(abs, { signal: AbortSignal.timeout(20000) })).text();
      RESOURCE_CACHE.set(r.url, {
        tested: new Set(unionKeys),
        literal: new Set([...unionCards].filter((k) => body.includes(k))),
        icons: new Set([...unionIcons].filter((k) => bodyHasIcon(body, k))),
        frags: new Set([...unionFrags].filter((f) => body.includes(f))),
        unreadable: false,
        bytes: body.length,
      });
    } catch (e) {
      RESOURCE_CACHE.set(r.url, { tested: new Set(unionKeys), literal: new Set(), icons: new Set(), frags: new Set(), unreadable: true, bytes: 0 });
      logThrottled(`res:${r.url}`, `  resources: could not read ${r.url} (${e.message}) — always forwarding it`);
    }
  }

  // Document frequency across the resources we could actually read. A fragment in more than
  // a quarter of them identifies nothing, so it cannot carry a fragment match on its own.
  const readable = rows.filter((r) => !RESOURCE_CACHE.get(r.url)?.unreadable);
  FRAG_DF = new Map();
  for (const f of unionFrags) {
    FRAG_DF.set(f, readable.filter((r) => RESOURCE_CACHE.get(r.url).frags.has(f)).length);
  }
  FRAG_DF_MAX = Math.max(1, Math.floor(readable.length * 0.25));
  FRAG_RARE_MAX = Math.max(2, Math.floor(readable.length * 0.05));
  const common = [...unionFrags].filter((f) => !isDistinctive(f));
  if (common.length) {
    log(`  resources: ${common.length} fragment(s) too common to identify a card (>${FRAG_DF_MAX} of ${readable.length}): ${common.sort().join(', ')}`);
  }

  const byDash = new Map();
  RESOURCE_STATS = new Map();
  for (const [dash, keys] of keysByDash) {
    const keep = new Set();
    let keptB = 0, dropB = 0;
    for (const r of rows) {
      const bytes = RESOURCE_CACHE.get(r.url)?.bytes || 0;
      if (keepResource(r.url, keys)) { keep.add(r.url); keptB += bytes; }
      else dropB += bytes;
    }
    byDash.set(dash, keep);
    RESOURCE_STATS.set(dash, {
      kept: keep.size, dropped: rows.length - keep.size,
      keptKB: Math.round(keptB / 1024), droppedKB: Math.round(dropB / 1024),
    });
    const needs = [...[...keys.cards].sort(), ...[...keys.icons].sort().map((i) => i + ':')];
    log(`  resources ${dash} needs: ${needs.join(', ') || '(none)'}`);
    log(`  resources ${dash}: ${keep.size}/${rows.length} kept (${(keptB / 1024).toFixed(0)}KB), ${rows.length - keep.size} dropped (${(dropB / 1024).toFixed(0)}KB)`);
  }
  RESOURCES_BY_DASH = byDash;

  // Resources dropped by EVERY dashboard get their own warning, because this set is the
  // exact signature of the one failure the tuning loop cannot catch.
  //
  // The documented way to tune this option is "load the dashboard and see what looks
  // wrong". That works for a card that fails to render or an icon that goes blank. It does
  // not work for a resource that registers no element and is named by no dashboard, but
  // runs on load and subscribes to state — an idle timer, a camera pop-up, a heartbeat.
  // Drop one of those and the dashboard is pixel-identical; only the behaviour stops, and
  // nothing reports it on either side. (Reported by @ajguerre1 on upstream #15, who lost a
  // doorbell pop-up on 28 panels for three days to the same failure one level down, via
  // entities.)
  //
  // The proxy cannot tell that class apart from a genuinely unused resource — but the
  // reader can, instantly. So say which ones they are rather than burying them in the
  // per-dashboard drop lists.
  const servedAnywhere = new Set();
  for (const keep of byDash.values()) for (const u of keep) servedAnywhere.add(u);
  const droppedByAll = rows.filter((r) => !servedAnywhere.has(r.url));
  if (droppedByAll.length) {
    const kb = droppedByAll.reduce((t, r) => t + (RESOURCE_CACHE.get(r.url)?.bytes || 0), 0) / 1024;
    log(`  resources: ${droppedByAll.length} dropped by ALL dashboards (no dashboard references them), ${kb.toFixed(0)}KB.`);
    log('    If any of these run on load rather than rendering a card — an idle timer, a');
    log('    pop-up, a heartbeat — add them to resources_always_forward. Dropping one of');
    log('    those is INVISIBLE: the dashboard renders normally and only the behaviour stops.');
    for (const r of droppedByAll) {
      const b = ((RESOURCE_CACHE.get(r.url)?.bytes || 0) / 1024).toFixed(0);
      log(`      drop ${String(b).padStart(6)}KB ${r.url.split('?')[0]}`);
    }
  }
}

// ---- which USER is this connection? ----
// The browser's first websocket message carries its access token, and that token IS the
// identity — so the proxy can ask Home Assistant who it belongs to instead of guessing from
// an address. Done on a SEPARATE short-lived connection on purpose: HA enforces strictly
// increasing message ids per connection, so injecting a lookup into the browser's own socket
// risks colliding with an id the frontend uses later.
//
// Cached by a hash of the token, never the token itself, and only long enough to cover a
// session's reconnects.
const USER_CACHE = new Map();                 // sha256(token) -> { user, at }
const USER_TTL_MS = 10 * 60 * 1000;
// Generous, because the cost of timing out is silently serving the wrong allowlist, while the
// cost of waiting is a one-off delay on a connection that is already waiting on Home Assistant
// anyway. Only ever paid once per token per TTL, and never when HA is healthy.
const USER_LOOKUP_TIMEOUT_MS = 8000;

function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function resolveUser(token) {
  const key = tokenKey(token);
  const hit = USER_CACHE.get(key);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return Promise.resolve(hit.user);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (user) => {
      if (settled) return;
      settled = true;
      // Only cache a REAL answer. Caching a failure meant one slow moment from Home Assistant
      // disabled a user's rules for the full TTL — the rules silently stopped applying long
      // after HA recovered, which is exactly how "my updates disappeared" happened.
      if (user) USER_CACHE.set(key, { user, at: Date.now() });
      if (USER_CACHE.size > 200) USER_CACHE.delete(USER_CACHE.keys().next().value);
      try { ws.close(); } catch {}
      resolve(user);
    };
    const timer = setTimeout(() => finish(null), USER_LOOKUP_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    let ws;
    try { ws = new WebSocket(HA_WS, { perMessageDeflate: false }); }
    catch { clearTimeout(timer); return resolve(null); }

    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      if (m.type === 'auth_ok') return ws.send(JSON.stringify({ id: 1, type: 'auth/current_user' }));
      if (m.type === 'auth_invalid') { clearTimeout(timer); return finish(null); }
      if (m.type === 'result' && m.id === 1) {
        clearTimeout(timer);
        return finish(m.success ? (m.result ?? null) : null);
      }
    });
    // A failed lookup must never break the connection it was asked about: no user, no rules.
    ws.on('error', () => { clearTimeout(timer); finish(null); });
    ws.on('close', () => { clearTimeout(timer); finish(null); });
  });
}

// ---- client-pinned rules ----

// Parse "10.2.4.0/24" into a test. IPv4 only on purpose: a CIDR here exists to name a VLAN of
// wall panels, and anything needing IPv6 subtleties is better served by listing addresses.
function parseCidr(s) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(s);
  if (!m) return null;
  const bits = Number(m[2]);
  if (bits > 32) return null;
  const toInt = (ip) => ip.split('.').reduce((a, o) => (a << 8 >>> 0) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (toInt(m[1]) & mask) >>> 0;
  return (ip) => {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false;
    return ((toInt(ip) & mask) >>> 0) === net;
  };
}

// Resolve each rule's `client` to addresses and each `devices` entry to entity ids.
//
// Run at allowlist-build time rather than at connect time: a DNS lookup on the hot path would
// put a network round trip in front of every websocket upgrade, and a failure there would be a
// failure to serve rather than a logged warning.
async function resolveClientRules(registries) {
  if (!CLIENT_RULES.length) return;
  const devices = registries?.devices || [];
  const entities = registries?.entities || [];
  const byId = new Map(devices.map((d) => [d.id, d]));
  const idByName = new Map(devices
    .map((d) => [String(d.name_by_user || d.name || '').toLowerCase(), d.id])
    .filter(([n]) => n));
  const entsFor = buildRegistryCtx({ devices, entities }).byDevice;

  for (const r of CLIENT_RULES) {
    r.cidr = parseCidr(r.client);
    r.ips = new Set();
    if (!r.cidr) {
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(r.client) || r.client.includes(':')) {
        r.ips.add(normalizeIp(r.client));
      } else {
        // A hostname. Resolving it is best-effort by design: a panel that is powered off has no
        // lease, and that must not stop the other rules — or the whole allowlist — from building.
        try {
          const { lookup } = await import('node:dns/promises');
          const hits = await lookup(r.client, { all: true });
          hits.forEach((h) => r.ips.add(normalizeIp(h.address)));
          log(`  client rule ${r.client} -> ${[...r.ips].join(', ')}`);
        } catch (e) {
          logThrottled(`client-dns:${r.client}`,
            `  client rule ${r.client}: DNS lookup failed (${e.code || e.message}) — rule inactive until it resolves. `
            + 'mDNS/.local names usually do not resolve from a container; a real DNS record does.');
        }
      }
    }

    r.deviceEntities = [];
    for (const want of r.devices) {
      const id = byId.has(want) ? want : idByName.get(want.toLowerCase());
      if (!id) { log(`  client rule ${r.client}: no device named "${want}"`); continue; }
      const rows = entsFor.get(id) || [];
      const kept = deviceEntityIds(rows, EXCLUDE_DEVICE_CATEGORIES);
      r.deviceEntities.push(...kept);
      log(`  client rule ${r.client}: device "${byId.get(id)?.name ?? id}" -> ${kept.length} entities`
        + ` ${describeDeviceSplit(rows)}`);
    }
  }
}

// Every client rule matching this connection's address, merged. Cheap: a handful of set lookups
// on a list a user hand-wrote, evaluated once per websocket upgrade.
function rulesForClient(ip) {
  if (!ip || !CLIENT_RULES.length) return null;
  const hits = CLIENT_RULES.filter((r) => (r.cidr ? r.cidr(ip) : r.ips.has(ip)));
  if (!hits.length) return null;
  return {
    always: hits.flatMap((r) => r.always),
    never: hits.flatMap((r) => r.never),
    entities: hits.flatMap((r) => r.deviceEntities),
  };
}

// Widen/narrow one connection's allowlist by its client rules. Returns the SAME set when nothing
// changed, so the common case allocates nothing and the caller can tell whether a rule applied.
function applyClientRules(set, extra) {
  if (!extra) return set;
  const out = new Set(set);
  extra.entities.forEach((eid) => out.add(eid));
  extra.always.forEach((r) => {
    if (r.literal) out.add(r.literal);
    else REAL_IDS.forEach((eid) => { if (r.re.test(eid)) out.add(eid); });
  });
  // never wins last here too, matching every other override block.
  [...out].forEach((eid) => { if (matchesAny(extra.never, eid)) out.delete(eid); });
  return out.size === set.size ? set : out;
}

// Could ANY per-user rule apply to this connection at all?
//
// Resolving the user costs a round trip to Home Assistant, and the connection is held for its
// duration — every message after `auth` waits. That is worth paying when a rule might change the
// allowlist, and pure loss when none can.
//
// A rule scoped to a dashboard cannot apply to a connection serving a different one. Measured on
// a live instance, every per-user rule was scoped to `lovelace`, so every wall-panel connection
// paid the lookup to reach a foregone conclusion.
//
// An unattributed connection (dash === null) still gates: we do not know which dashboard it is
// showing, so we cannot rule anything out. Same asymmetry as everywhere else — a needless gate
// costs milliseconds, a skipped one serves the wrong allowlist.
function userRulesCouldApply(dash) {
  if (!USER_RULES.length) return false;
  if (dash === null || dash === undefined) return true;
  return USER_RULES.some((r) => r.dashboard === null || r.dashboard === dash);
}

// The rules for a resolved user, matched on name (case-insensitive) or id.
// Every rule matching this user AND this dashboard, merged. Scoping to a dashboard is the
// point: "David sees update.* on lovelace" should not put 252 entities on a wall panel just
// because David happens to walk past it.
function rulesForUser(user, dash) {
  if (!user || !USER_RULES.length) return null;
  const names = [String(user.name ?? '').toLowerCase(), String(user.id ?? '').toLowerCase()];
  const hits = USER_RULES.filter((r) => names.includes(r.user)
    && (r.dashboard === null || r.dashboard === dash));
  if (!hits.length) return null;
  return {
    always: hits.flatMap((r) => r.always),
    never: hits.flatMap((r) => r.never),
  };
}

// Widen (or narrow) one connection's allowlist by its user's rules. Never mutates the shared
// set the dashboard build produced — that is reused by every other connection.
function applyUserRules(set, extra) {
  const out = new Set(set);
  extra.always.forEach((r) => {
    if (r.literal) out.add(r.literal);
    else REAL_IDS.forEach((eid) => { if (r.re.test(eid)) out.add(eid); });
  });
  [...out].forEach((eid) => { if (matchesAny(extra.never, eid)) out.delete(eid); });
  return out;
}

// ---- which dashboard is this client looking at? ----
// The websocket upgrade itself carries nothing that identifies the dashboard: the frontend
// opens ONE /api/websocket for the whole SPA and only asks for `lovelace/config` later —
// after `subscribe_entities`, which is the message we have to rewrite. So the dashboard has
// to be known BEFORE the socket opens.
//
// What does arrive first is the ordinary HTTP GET for the dashboard page itself
// (`GET /basement-stairs-panel/basement`), milliseconds earlier on the same connection's
// client IP. Remembering that gives the upgrade a reliable hint without touching the
// frontend or HA. When the hint is missing or stale we fall back to the union, so the worst
// case is exactly the old behaviour.
//
// Keyed by IP, which is right for wall panels (one device, one dashboard, static address)
// and deliberately coarse: two browsers behind one NAT share a hint, so the one that loaded
// second wins and the other may see entities its dashboard doesn't cover as unavailable
// until it reloads. Per-IP because a kiosk has no cookies we can rely on and no session we
// can see; a cookie would be finer-grained but needs a response rewrite on every page load.
//
// The page GET is the ONLY signal used. `lovelace/config` looks like a better one — it names
// the dashboard explicitly — but requesting a dashboard's config does not mean displaying
// it: Kiosk Satellite enumerates every dashboard's views at startup. See the note in
// bridge() for what happened when this code tried to act on it.
const CLIENT_DASH_TTL_MS = 10 * 60 * 1000;
const clientDash = new Map();                 // ip -> { path, at }

// One implementation of "who is this", shared with the route classifier, so the IP a client
// is attributed by and the IP the panel reports about it can never disagree.
const clientIp = (req) => classify(req).ip;

// A dashboard URL is `/<url_path>` or `/<url_path>/<view>`. Match only configured
// dashboards, so ordinary frontend traffic (/api/…, /static/…, /hacsfiles/…) is ignored.
function dashFromUrl(url) {
  const first = String(url || '').split('?')[0].split('/').filter(Boolean)[0];
  if (!first) return null;
  return DASH_PATHS.includes(first) ? first : null;
}

function noteClientDash(req) {
  if (!PER_DASH) return;
  const path = dashFromUrl(req.url);
  if (!path) return;
  const ip = clientIp(req);
  if (!ip) return;
  const prev = clientDash.get(ip);
  clientDash.set(ip, { path, at: Date.now() });
  if (prev?.path !== path) log(`client ${ip} -> dashboard ${path}`);
  // Bounded: a busy instance must not accumulate an entry per client forever.
  if (clientDash.size > 500) {
    const cutoff = Date.now() - CLIENT_DASH_TTL_MS;
    for (const [k, v] of clientDash) if (v.at < cutoff) clientDash.delete(k);
  }
}

// The allowlist this connection should get: its own dashboard's if we know it and it is
// non-empty, else the union. Never returns an empty set when the union has entries — an
// empty entity_ids means "no filter" to HA, i.e. the whole firehose.
const DASH_COOKIE = 'ws_dash';

/// The dashboard this browser was last served, from its own cookie. Per-browser, so it
/// survives NAT — unlike the IP hint, which every device behind one address shares.
function dashFromCookie(req) {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== DASH_COOKIE) continue;
    let v; try { v = decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    return DASH_PATHS.includes(v) ? v : null;   // only ever a dashboard we actually serve
  }
  return null;
}

// Cookie first, then the IP hint, then the union. Never returns an empty set when the union
// has entries — an empty entity_ids means "no filter" to HA, i.e. the whole firehose.
function allowFor(req) {
  if (!PER_DASH) return { set: ALLOW, dash: null, via: null };
  for (const [path, via] of [
    [dashFromCookie(req), 'cookie'],
    [ipHint(req), 'ip'],
    [dashFromUA(req), 'user-agent'],
  ]) {
    if (!path) continue;
    const set = ALLOW_BY_DASH.get(path);
    if (set?.size) return { set, dash: path, via };
  }
  return { set: ALLOW, dash: null, via: null };
}

// Last-resort attribution from the User-Agent. Only ever returns a dashboard the add-on is
// configured to serve, so a spoofed UA can at worst select another of your own dashboards.
function dashFromUA(req) {
  const ua = req.headers?.['user-agent'];
  if (!ua || !UA_DASHBOARDS.length) return null;
  for (const r of UA_DASHBOARDS) {
    const hit = r.re ? r.re.test(ua) : ua.includes(r.literal);
    if (hit && DASH_PATHS.includes(r.dashboard)) return r.dashboard;
  }
  return null;
}

function ipHint(req) {
  const hit = clientDash.get(clientIp(req));
  if (!hit || Date.now() - hit.at > CLIENT_DASH_TTL_MS) return null;
  return hit.path;
}

const server = http.createServer((req, res) => { noteClientDash(req); proxy.web(req, res); });

// ---- websocket upgrades ----
// We intercept ONLY /api/websocket (the entity firehose) to trim it. EVERY other ws
// upgrade passes straight through to HA — notably /api/webrtc/ws (go2rtc / WebRTC & MSE
// camera-stream signaling) and Assist-pipeline sockets. Destroying them (the old default
// branch) broke camera streams with ws close code 1006.
// threshold: don't spend CPU deflating the small control chatter; the payloads that matter
// here (registries, get_states, get_services) are hundreds of KB and compress ~10x.
// concurrencyLimit caps simultaneous zlib jobs so a burst of kiosks reconnecting at once
// can't saturate the host. Context takeover is left at the default (on) because this add-on
// serves a handful of long-lived kiosk connections, where the better ratio is worth the
// per-connection zlib memory.
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: COMPRESS_WS ? { threshold: 1024, concurrencyLimit: 10 } : false,
});
server.on('upgrade', (req, socket, head) => {
  // A raw upgrade socket arrives with NO 'error' listener, and http-proxy only attaches one
  // once HA has answered 101 (see ws-incoming.js). Anything that errors in that window — an
  // HA restart resetting an in-flight camera/Assist stream, a kiosk abandoning a retry —
  // reaches Node as an unhandled 'error' event and killed the add-on outright. Claim it
  // first: this is the crash that turned "HA rebooted" into "the add-on is dead".
  socket.on('error', (e) => {
    logThrottled(`upgrade:${e.code || e.message}`, `ws upgrade socket error (${req.url}): ${e.message}`);
    socket.destroy();
  });
  if (req.url.startsWith('/api/websocket')) {
    // No USABLE allowlist — either none built yet (HA still booting) or one that came back
    // empty (every configured dashboard missing). Refusing is not just about cards showing
    // "unavailable": HA reads `set(msg["entity_ids"]) or None`, so forwarding an empty
    // entity_ids means NO filter, and the proxy would relay the entire firehose it exists to
    // prevent — enough to OOM it on a large instance. The frontend treats a refused upgrade
    // as an ordinary disconnect and retries, so kiosks heal once the allowlist is real.
    if (STRIP && (!ALLOW_READY || !ALLOW.size)) {
      logThrottled('not-ready', `refusing /api/websocket: ${ALLOW_READY ? 'allowlist is EMPTY — check the `dashboards` option' : 'allowlist not built yet (waiting for HA)'}`);
      // end(), not write()+destroy(): destroy() gives no flush guarantee, so the 503 could be
      // discarded and the client would see a bare connection drop instead.
      try {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      } catch { socket.destroy(); }
      return;
    }
    const { set: dashSet, dash, via } = allowFor(req);
    // Classified once here rather than per-field: the request object is gone by the time the
    // bridge reports anything, so the path has to be captured at the only moment it exists.
    const rt = classify(req);
    // Client-pinned rules apply on top of whichever dashboard set was chosen, and regardless of
    // whether the dashboard could be attributed at all — the point of pinning to a device is
    // that it holds even when the page changes.
    const set = applyClientRules(dashSet, rulesForClient(rt.ip));
    const pinned = set !== dashSet;
    if (dash || pinned) {
      log(`/api/websocket for ${rt.ip} (${rt.origin}, via ${rt.route}${rt.host ? ` @ ${rt.host}` : ''}): `
        + `serving ${dash ?? 'union'}${dash ? ` via ${via}` : ''}`
        + `${pinned ? ` +client rules (${dashSet.size} -> ${set.size})` : ''} `
        + `(${set.size} entities, union is ${ALLOW.size})`);
    }
    wss.handleUpgrade(req, socket, head, (browserWs) => bridge(browserWs, set, dash, {
      ip: rt.ip, via, ua: req.headers['user-agent'], clientPinned: pinned,
      origin: rt.origin, route: rt.route, host: rt.host, hop: rt.hop, hops: rt.hops,
    }));
  } else {
    // Keyed on the path, not req.url: camera stream URLs carry a per-request signature, so
    // keying on the whole thing would defeat the throttle (and grow the map) during a retry storm.
    // Name the client. Without this a passthrough that repeats forever — an add-on ingress
    // panel reconnecting on a timer, say — is unattributable: you can see it happening and
    // have no way to tell which device is doing it.
    const pt = classify(req);
    logThrottled(`passthrough:${req.url.split('?')[0]}`,
      `ws upgrade passthrough -> HA: ${req.url} (from ${pt.ip ?? '?'}${pt.origin ? `, ${pt.origin}` : ''}`
      + `${pt.route ? ` via ${pt.route}` : ''})`);
    proxy.ws(req, socket, head);
  }
});

// `allow` is THIS connection's allowlist — one dashboard's, or the union when the client
// couldn't be attributed. Captured per bridge rather than read from the global, so two
// kiosks on different dashboards get genuinely different subscriptions.
function bridge(browserWs, baseAllow = ALLOW, dash = null, meta = {}) {
  // When this connection was accepted, i.e. the moment the client started waiting. Everything
  // the timing report says is relative to this.
  const tOpen = Date.now();
  let timedInitial = false;
  const haWs = new WebSocket(HA_WS, { perMessageDeflate: true, maxPayload: 0 });
  const connId = stats.connOpen({
    ip: meta.ip, dash, via: meta.via, allowSize: baseAllow.size, ua: meta.ua,
    origin: meta.origin, route: meta.route, host: meta.host, hop: meta.hop, hops: meta.hops,
  });
  let userChecked = false;
  const getStatesIds = new Set();
  const subEntityIds = new Set();   // subscribe_entities subs we injected the allowlist into
  const registryIds = new Map();    // request id -> which registry, to trim its result
  const resourceIds = new Set();    // lovelace/resources requests, to trim their result
  const serviceIds = new Set();     // get_services requests, to trim their result
  // `subscribe_events` subscriptions that will deliver state_changed. These bypass the
  // allowlist entirely: the egress filter below only ever covered subscribe_entities, so a
  // card using the older subscribe_events path received the WHOLE firehose — the exact thing
  // this add-on exists to prevent. Measured at ~700MB/h to a single wall panel.
  const stateChangedSubs = new Set();
  // id -> the command the browser sent, so a `result` can be attributed to what asked for it.
  // Bounded: a client that never gets answers must not grow this without limit.
  const pendingTypes = new Map();
  const queue = []; let haOpen = false;
  const toHA = (s) => { if (haOpen) haWs.send(s); else queue.push(s); };

  // This connection's allowlist. Starts as the dashboard's shared set and may be replaced once
  // the user behind the token is known. Never mutated in place — other connections share it.
  let allow = baseAllow;
  // While a user lookup is in flight, browser->HA messages are held and flushed in order.
  // Order matters: Home Assistant requires strictly increasing message ids per connection, so
  // letting a later message overtake an earlier one while we wait would break the socket.
  // The gate opens after the auth message, which is the first thing the frontend sends, so in
  // practice it holds a handful of messages for one local round trip.
  //
  // Held messages are THUNKS, not finished strings. A message serialized at queue time
  // carries the allowlist as it was when the gate CLOSED — but the gate exists precisely
  // because user rules are about to change that allowlist. Stamping early therefore sent the
  // pre-rules entity list and silently discarded the rule that was being waited for, so a
  // per-user always_forward applied only when the lookup happened to win the race against the
  // frontend's first subscribe_entities. It usually did, which is what made the failure
  // intermittent: the same client, same config, and the extra entities present or missing
  // depending on how fast HA answered. Resolving the payload at FLUSH time is what makes the
  // rule apply to the first subscribe_entities, which is the only one that matters.
  let gateQueue = null;
  const flush = (thunk) => { const v = thunk(); if (v != null) toHA(v); };
  const sendOrQueue = (thunk) => { if (gateQueue) gateQueue.push(thunk); else flush(thunk); };
  const openGate = () => {
    const held = gateQueue || [];
    gateQueue = null;
    held.forEach(flush);
  };

  haWs.on('open', () => { haOpen = true; queue.forEach((s) => haWs.send(s)); queue.length = 0; });

  browserWs.on('message', (raw, isBinary) => {
    // Binary frames are forwarded byte-for-byte. They are not JSON, and running toString()
    // over them UTF-8-decodes arbitrary bytes — lossy — and then re-sends them as a TEXT
    // frame. Home Assistant uses binary frames for media, so this path carries camera data.
    if (isBinary) return toHA(raw);
    let s = raw.toString(); let m;
    try { m = JSON.parse(s); } catch { return toHA(s); }
    // The auth message carries the identity. Forward it immediately (HA is waiting for it),
    // then hold everything after it until the user is known.
    if (userRulesCouldApply(dash) && m && m.type === 'auth' && m.access_token && gateQueue === null && !userChecked) {
      userChecked = true;
      toHA(s);
      gateQueue = [];
      resolveUser(m.access_token).then((user) => {
        const extra = rulesForUser(user, dash);
        // Log the miss too. A rule that matches nothing is indistinguishable from no rule at
        // all otherwise — and the usual cause is that HA's user NAME ("David Coulson") is not
        // the first name people write in config.
        if (!extra && user) {
          logThrottled(`user-nomatch:${user.id}`, `no user rule matched ${JSON.stringify(user.name)} `
            + `(id ${user.id})${dash ? ` on ${dash}` : ''} — match on that exact name or the id`);
        }
        if (extra) {
          allow = applyUserRules(allow, extra);
          log(`user rules applied for ${user.name ?? user.id}: ${allow.size} entities`
            + `${dash ? ` on ${dash}` : ''} (was ${baseAllow.size})`);
        }
        // Tell the panel who this is and what it ended up with, so a widened connection stops
        // reporting the size it had before the rules ran.
        if (user) stats.connIdentity(connId, { allowSize: allow.size, user: user.name ?? user.id });
      }).catch(() => {}).finally(openGate);
      return;
    }
    if (m && m.id != null && m.type) {
      if (pendingTypes.size > 500) pendingTypes.clear();
      pendingTypes.set(m.id, m.type);
    }
    if (STRIP && m && m.type === 'get_states') getStatesIds.add(m.id);
    if (STRIP && TRIM_REGISTRIES && m && REGISTRY_TYPES.has(m.type)) {
      const kind = REGISTRY_TYPES.get(m.type);
      const hit = REG_RESPONSE_CACHE.get(regCacheKey(kind, dash));
      if (hit !== undefined) {
        // Answer locally and never forward: HA is not asked to build the registry again.
        // Safe against HA's increasing-id rule because nothing is sent to HA at all, and
        // the browser still sees replies in the order it asked.
        logThrottled(`regcache:${kind}`, `${kind} registry served from cache${dash ? ` (${dash})` : ''}`);
        stats.recordCacheHit(hit.length);
        safeSend(`{"id":${m.id},"type":"result","success":true,"result":${hit}}`);
        return;
      }
      registryIds.set(m.id, kind);
    }
    if (STRIP && TRIM_RESOURCES && m && m.type === 'lovelace/resources') resourceIds.add(m.id);
    if (STRIP && TRIM_SERVICES && m && m.type === 'get_services') serviceIds.add(m.id);
    // No event_type means "every event", which includes state_changed.
    if (STRIP && m && m.type === 'subscribe_events'
        && (!m.event_type || m.event_type === 'state_changed')) {
      stateChangedSubs.add(m.id);
      log(`subscribe_events(${m.event_type ?? 'ALL EVENTS'}) id=${m.id} from ${meta.ip ?? '?'} dash=${dash ?? '(union)'}`);
    }
    // Deferred to send time rather than done here — see the gate note above for why stamping
    // at this point silently dropped per-user rules.
    let stampAllow = false;
    if (STRIP && m && m.type === 'subscribe_entities' && !m.entity_ids) {
      subEntityIds.add(m.id);              // remember it, to defensively re-filter its events
      stampAllow = true;
    }
    // NB: `lovelace/config` is deliberately NOT used to re-attribute a live connection.
    //
    // It looks like the perfect signal — the frontend naming the dashboard it is about to
    // render — but a client fetching a dashboard's config does not mean it is DISPLAYING
    // that dashboard. Kiosk Satellite, for one, enumerates every dashboard's views at
    // startup, so a panel showing `basement-stairs-panel` requests the config of all five.
    // Acting on that flipped the stored hint to whichever dashboard was enumerated last and
    // recycled the socket to "follow" it, which produced a reconnect storm and then served
    // the panel the wrong dashboard's allowlist. Observed live, 2026-09-11.
    //
    // The page GET that precedes the websocket is the only signal that actually means "this
    // client is displaying this dashboard", so it is the only one used. The cost is that a
    // client-side navigation to a DIFFERENT dashboard keeps the old allowlist until the page
    // reloads; set `per_dashboard: false` if that matters more than the trimming does.
    if (m && m.type === 'unsubscribe_events' && m.subscription != null) {
      subEntityIds.delete(m.subscription);
      stateChangedSubs.delete(m.subscription);
    }
    sendOrQueue(stampAllow
      ? () => {
        // Belt-and-braces to the upgrade gate: an empty entity_ids is NOT "subscribe to
        // nothing", it's "no filter" (HA: `set(msg["entity_ids"]) or None`). Sending one
        // would invert the add-on's entire purpose, so drop the connection instead.
        // Re-checked here rather than at queue time because a never_forward user rule can
        // narrow the allowlist while this message is held.
        if (!allow.size) {
          logThrottled('empty-allow', 'ERROR: refusing subscribe_entities — the allowlist is empty, and forwarding that would stream EVERY entity. Check the `dashboards` option.');
          close();
          return null;
        }
        m.entity_ids = [...allow];         // HA now streams only this connection's allowlist
        return JSON.stringify(m);
      }
      : () => s);
  });

  haWs.on('message', (raw, isBinary) => {
    // Same on the way back, and this is the direction that carries the volume: on the
    // instance this was built against, binary frames were 90% of everything a wall panel
    // received — 12MB in 68 seconds — while being silently corrupted in transit.
    if (isBinary) {
      const n = raw.length;
      stats.recordTraffic('binary (media/camera)', n);
      stats.connTraffic(connId, n, n, false);
      return safeSend(raw);
    }
    // Does this frame carry the connection's initial entity state?
    //
    // `a` is HA's "added" block — the full state of every subscribed entity, sent once when a
    // subscribe_entities subscription opens. `c` ("changed") is every diff after it. Checked
    // through batched arrays too: HA packs messages together, and the initial payload is
    // routinely bundled with other replies, so testing only the top-level object would miss it
    // on exactly the connections that are busiest at startup.
    const isInitialState = (x) => Boolean(
      x && x.type === 'event' && subEntityIds.has(x.id)
      && x.event && x.event.a && Object.keys(x.event.a).length,
    );
    const carriesInitialState = (msg) => (Array.isArray(msg) ? msg.some(isInitialState) : isInitialState(msg));
    // Measure the `a` BLOCK, not the frame it arrived in.
    //
    // This used to be `Buffer.byteLength(s)` — the whole frame. HA batches messages into an
    // array, so that number silently included whatever else was bundled alongside: sometimes
    // lovelace/config and the registries, sometimes nothing. Measured live it varied by 164x
    // between two clients on the SAME dashboard with the SAME 149-entity allowlist (246KB vs
    // 1.5KB), which makes it useless as a payload figure and actively misleading next to a
    // column header that says "Payload".
    //
    // The entity count is reported beside it deliberately. Bytes alone cannot be sanity-checked
    // by a reader, but "447 bytes / 3 entities" against a 104-entity allowlist is visibly a
    // partial first block rather than a mystery, and the panel stops being able to imply a
    // cold-start payload it did not actually observe.
    const initialStateSize = (msg) => {
      let bytes = 0, entities = 0;
      for (const x of (Array.isArray(msg) ? msg : [msg])) {
        if (!isInitialState(x)) continue;
        bytes += Buffer.byteLength(JSON.stringify(x.event.a));
        entities += Object.keys(x.event.a).length;
      }
      return { bytes, entities };
    };

    let s = raw.toString(); let m;
    // Sizes are measured on the decoded JSON, i.e. what the browser has to parse. The wire is
    // smaller when permessage-deflate is on, and deliberately not what the panel reports.
    const inBytes = Buffer.byteLength(s);
    let cat = null;
    // Set for a BATCHED (array) frame, so done() labels it once, after trimming. Home Assistant
    // packs messages into arrays; `m.type` is undefined on those, so without this they fall
    // through every branch in done() and land in the "(no type field)" bucket — on top of the
    // label the array branch already recorded. Measured live: 165 batched frames produced 165
    // phantom "(no type field)" entries carrying 2.78MB that was never a separate payload.
    let batchedKinds = null;
    let isEvent = false;
    const done = () => {
      const outBytes = Buffer.byteLength(s);
      if (cat) stats.recordTrim(cat, inBytes, outBytes);
      // Strictly `type === "event"`. This used to be `cat === null`, i.e. "not one of the
      // four trimmed categories", which swept up lovelace/config and every other untrimmed
      // reply and reported the lot as live update traffic.
      stats.connTraffic(connId, inBytes, outBytes, isEvent);
      // Label by kind so nothing can flow unexplained. Events carry their event_type;
      // results are attributed to the command that asked for them.
      if (batchedKinds !== null) {
        // One row per frame, sized like every other row: what actually went to the browser.
        stats.recordTraffic(`batched ${batchedKinds}`, outBytes);
      } else if (m && m.type === 'event') {
        stats.recordTraffic(`event:${m.event?.event_type ?? 'entity-diff'}`, outBytes);
      } else if (m && m.type === 'result') {
        stats.recordTraffic(`result:${pendingTypes.get(m.id) ?? 'unknown'}`, outBytes);
        pendingTypes.delete(m.id);
      } else if (m && m.type) {
        stats.recordTraffic(m.type, outBytes);
      } else {
        // Valid JSON with no `type`. This is where the volume actually is, and the shape is
        // unknown — so dump the keys and a sample rather than filing it under a label that
        // says nothing. Throttled to one line.
        stats.recordTraffic('(no type field)', outBytes);
      }
      // The first full entity payload is the one a dashboard cannot render without, so it is
      // the honest "time to useful". HA sends the initial state as an `a` (added) block on the
      // subscribe_entities subscription; every later one is `c` (changed) and is not this.
      // Measured once per connection — see stats.connTiming.
      if (!timedInitial && carriesInitialState(m)) {
        timedInitial = true;
        const queuedAt = Date.now();
        const { bytes, entities } = initialStateSize(m);
        return safeSend(s, () => {
          const sentAt = Date.now();
          stats.connTiming(connId, {
            msToEntityData: sentAt - tOpen,
            initialPayloadBytes: bytes,
            initialEntityCount: entities,
            initialDrainMs: sentAt - queuedAt,
          });
          log(`entity payload delivered to ${meta.ip ?? '?'}${dash ? ` (${dash})` : ''}: `
            + `${(bytes / 1024).toFixed(1)}KB / ${entities} entities in ${sentAt - tOpen}ms from connect `
            + `(${sentAt - queuedAt}ms to the network stack)`);
        });
      }
      return safeSend(s);
    };
    // Home Assistant BATCHES messages into a JSON array. Every `m.type` check below sees
    // undefined on those, so an array frame fell through every branch untouched and
    // unlabelled — which is how an unfiltered firehose hid in plain sight. Handle the array
    // by filtering its elements, then fall through with the rest of the logic intact.
    const dropStateChanged = (x) => STRIP
      && x && x.type === 'event'
      && stateChangedSubs.has(x.id)
      && typeof x.event?.data?.entity_id === 'string'
      && !allow.has(x.event.data.entity_id);

    try { m = JSON.parse(s); } catch (e) {
      logThrottled('unparsed-frame', `frame that is neither binary nor JSON (${raw?.length ?? '?'} bytes): ${e.message}`);
      return done();
    }

    // Apply the trims to ONE message.
    //
    // All of this used to be written against the top-level object, so a BATCHED frame — Home
    // Assistant packs several messages into a single JSON array — bypassed every trim. That is
    // not a small leak: ~13.5MB of untrimmed registry rode inside batched frames on every
    // connection while `trim_registries` was on and logging success for the unbatched ones.
    // Returns null to drop the message entirely.
    let changed = false;
    const transform = (msg) => {
      if (!msg || typeof msg !== 'object') return msg;
      if (dropStateChanged(msg)) return null;

      if (STRIP && msg.type === 'result' && getStatesIds.has(msg.id) && Array.isArray(msg.result)) {
        const before = msg.result.length;
        msg.result = msg.result.filter((e) => allow.has(e.entity_id));
        getStatesIds.delete(msg.id);
        changed = true;
        cat = 'states';
        if (before > INSTANCE_ENTITIES) INSTANCE_ENTITIES = before;
        log(`get_states trimmed ${before} -> ${msg.result.length}${dash ? ` (${dash})` : ''}`);
      }
    if (STRIP && TRIM_REGISTRIES && msg && msg.type === 'result' && registryIds.has(msg.id) && msg.result && typeof msg.result === 'object') {
      const kind = registryIds.get(msg.id);
      registryIds.delete(msg.id);
      const rowsOf = (r) => (Array.isArray(r) ? r.length : (Array.isArray(r?.entities) ? r.entities.length : -1));
      const before = rowsOf(msg.result);
      msg.result = trimRegistry(kind, msg.result, allow);
      const after = rowsOf(msg.result);
      if (after !== before) {
        changed = true;
        logThrottled(`reg:${kind}`, `${kind} registry trimmed ${before} -> ${after}${dash ? ` (${dash})` : ''}`);
      }
      cat = `registry:${kind}`;
      // Keep the trimmed rows for the next connection on this allowlist. Stored as a JSON
      // STRING, not an object: it is only ever spliced back into a reply, so serialising it
      // once here saves doing it per hit, and nothing downstream can mutate a string.
      REG_RESPONSE_CACHE.set(regCacheKey(kind, dash), JSON.stringify(msg.result));
    }
    if (STRIP && TRIM_SERVICES && msg && msg.type === 'result' && serviceIds.has(msg.id)
        && msg.result && typeof msg.result === 'object' && !Array.isArray(msg.result)) {
      serviceIds.delete(msg.id);
      const keep = new Set(['homeassistant']);
      for (const id of allow) keep.add(String(id).split('.')[0]);
      const before = Object.keys(msg.result).length;
      const next = {};
      for (const [domain, svcs] of Object.entries(msg.result)) if (keep.has(domain)) next[domain] = svcs;
      const after = Object.keys(next).length;
      if (after && after !== before) {
        msg.result = next;
        changed = true;
        logThrottled('services', `get_services trimmed ${before} -> ${after} domains${dash ? ` (${dash})` : ''}`);
      }
      cat = 'services';
    }
    if (STRIP && TRIM_RESOURCES && msg && msg.type === 'result' && resourceIds.has(msg.id) && Array.isArray(msg.result)) {
      resourceIds.delete(msg.id);
      const keep = dash ? RESOURCES_BY_DASH.get(dash) : null;
      if (keep?.size) {
        const before = msg.result.length;
        msg.result = msg.result.filter((r) => keep.has(r?.url));
        if (msg.result.length !== before) {
          changed = true;
          logThrottled('resources', `lovelace resources trimmed ${before} -> ${msg.result.length} (${dash})`);
        }
        cat = 'resources';
      }
    }
    if (STRIP && msg && msg.type === 'event' && subEntityIds.has(msg.id) && msg.event) {
      // NB: sets the OUTER `changed`. A local one here would shadow it, the frame would
      // never be re-serialised, and this filter would silently do nothing.
      const ev = msg.event;
      for (const k of ['a', 'c']) {
        if (ev[k]) for (const eid of Object.keys(ev[k])) {
          if (!allow.has(eid)) { delete ev[k][eid]; changed = true; }
        }
      }
      if (Array.isArray(ev.r)) {
        const before = ev.r.length;
        ev.r = ev.r.filter((eid) => allow.has(eid));
        if (ev.r.length !== before) changed = true;
      }
      stats.recordEvent(Buffer.byteLength(JSON.stringify(msg)));
      isEvent = true;
    }
      return msg;
    };

    if (Array.isArray(m)) {
      const kinds = [...new Set(m.map((x) => (x?.type === 'event'
        ? `event:${x.event?.event_type ?? 'entity-diff'}`
        : (x?.type ?? '?'))))].sort().join('+');
      const before = m.length;
      const kept = [];
      for (const x of m) { const t = transform(x); if (t !== null) kept.push(t); }
      // Recorded in done() instead, against the TRIMMED size. This used to record inBytes here,
      // which reported batched frames at their pre-trim size while every other row reported what
      // was actually sent — making the biggest row in the table both double-counted and inflated.
      batchedKinds = kinds;
      if (!kept.length) return;                        // nothing survived: forward nothing
      if (changed || kept.length !== before) {
        s = JSON.stringify(kept);
        cat = cat ?? 'batched';
        logThrottled('batch-trim', `batched frame: ${before} -> ${kept.length} msgs, `
          + `${inBytes} -> ${Buffer.byteLength(s)} bytes${dash ? ` (${dash})` : ''}`);
      }
      return done();
    }

    const single = transform(m);
    if (single === null) return;
    if (changed) s = JSON.stringify(single);
    return done();
  });

  // The callback is what makes drain time measurable: ws invokes it once the frame has been
  // handed to the socket, so the gap between calling send() and the callback firing IS the
  // time the payload spent going out. On a LAN that is ~0; on a phone over cellular it is the
  // link, which is exactly the number worth reporting.
  function safeSend(s, cb) { try { if (browserWs.readyState === 1) browserWs.send(s, cb); } catch {} }
  const close = () => { openBridges.delete(close); stats.connClose(connId); try { browserWs.close(); } catch {} try { haWs.close(); } catch {} };
  openBridges.add(close);            // so a grown allowlist can recycle this connection (#7)
  browserWs.on('close', close); browserWs.on('error', close);
  haWs.on('close', close);
  haWs.on('error', (e) => { logThrottled(`haws:${e.code || e.message}`, `HA ws error ${e.message}`); close(); });
}

// ---- stats panel + JSON API ----
// Served on STATS_PORT, which config.yaml declares as the add-on's `ingress_port`, so HA
// renders the panel in the sidebar with no extra configuration. The same JSON is reachable
// directly at http://<host>:8100/stats.json for a `rest` sensor, a scrape, or curl.
//
// Read-only by design: it exposes what the proxy already logs, nothing more, and offers no
// way to change anything. That matters because Ingress hands the page to any logged-in HA
// user — if this could mutate options, it would need a permission model it has no business
// owning.
const PANEL_HTML = (() => {
  try { return fs.readFileSync(new URL('./panel.html', import.meta.url)); }
  catch (e) { log(`stats: panel.html unreadable (${e.message}) — the JSON API still works`); return null; }
})();

function statsExtras() {
  return {
    version: VERSION,
    options: {
      strip_entities: STRIP,
      per_dashboard: PER_DASH,
      trim_registries: TRIM_REGISTRIES,
      compress_websocket: COMPRESS_WS,
      trim_resources: TRIM_RESOURCES,
      trim_services: TRIM_SERVICES,
    },
    allowlist: {
      ready: ALLOW_READY,
      union: ALLOW.size,
      instanceEntities: INSTANCE_ENTITIES,
      version: ALLOW_VERSION,
      byDashboard: Object.fromEntries([...ALLOW_BY_DASH].map(([d, s]) => [d, s.size])),
    },
    resources: { byDashboard: Object.fromEntries(RESOURCE_STATS) },
  };
}

const statsServer = http.createServer((req, res) => {
  // Ingress rewrites the path prefix, so match on the tail rather than the whole URL.
  const path = String(req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (path.endsWith('/history.json')) {
    const body = JSON.stringify(history.history());
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(body);
  }
  if (path.endsWith('/stats.json')) {
    const body = JSON.stringify(stats.snapshot(statsExtras()), null, 2);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(body);
  }
  if (path === '/' || path.endsWith('/index.html')) {
    if (!PANEL_HTML) { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('panel.html missing'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(PANEL_HTML);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
// A stats port that will not bind is an inconvenience, NOT a reason to take the proxy down
// with it — the add-on's actual job is unaffected. Log it and carry on, unlike PORT below.
statsServer.on('error', (e) => logThrottled(`stats:${e.code || e.message}`, `stats server unavailable (${e.message}) — proxying is unaffected`));
statsServer.listen(STATS_PORT, () => log(`stats panel on :${STATS_PORT} (ingress) — JSON at :${STATS_PORT}/stats.json`));

// 24h history. /data is the add-on's persistent volume, so a restart costs one 5-minute
// bucket rather than the whole day — which matters because the counters themselves reset.
// In dev there is no /data; the sampler still runs, it just keeps the window in memory.
const HISTORY_DIR = fs.existsSync('/data') ? '/data' : (process.env.HISTORY_DIR || null);
history.start(() => stats.snapshot(statsExtras()), HISTORY_DIR);
log(`history: sampling every ${history.INTERVAL_MS / 60000}min, keeping ${history.KEEP} buckets${HISTORY_DIR ? ` in ${HISTORY_DIR}` : ' (memory only)'}`);

// ---- boot ----
log(`ha-ws-trim-proxy v${VERSION} starting`);
log(`mode: ${inAddon ? 'add-on' : 'dev'} | target ${HA_BASE} | allowlist via ${ALLOW_WS_URL}`);
log(`options: per_dashboard=${PER_DASH} trim_registries=${TRIM_REGISTRIES} compress_websocket=${COMPRESS_WS} trim_resources=${TRIM_RESOURCES} trim_services=${TRIM_SERVICES}`);
// Listen FIRST, before HA is known to be reachable. The add-on and HA core restart together
// (host boot, a core update), and core can take minutes to answer — the proxy's job is to
// wait for it, not to exit. HTTP proxies through immediately (502 while HA is down, like any
// reverse proxy); /api/websocket is refused until the first allowlist lands, above.
server.listen(PORT, () => {
  log(`HA trim-proxy listening on :${PORT}  ->  ${HA_BASE}`);
  DASH_PATHS.forEach((p) => log(`  open: http://<host>:${PORT}/${p}`));
});
// A port we can't bind is a real config error (another add-on on :9123 — see issue #6) and
// worth exiting for; anything else the server surfaces is not worth dying over.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
    console.error(`fatal: cannot listen on :${PORT} (${e.code}) — set the add-on's \`port\` option to a free port`);
    process.exit(2);
  }
  logThrottled(`server:${e.code || e.message}`, `server error ${e.message}`);
});

// ALLOW / ALLOW_READY are already set at the point the first allowlist is built, so this only
// logs. The catch is not dead code: connect() runs synchronously inside the promise executor,
// so a malformed `allow_ws_url` throws `Invalid URL` right here — a config error worth dying
// on, but with a message rather than a raw stack.
startController()
  .then(() => log(`union allowlist for [${DASH_PATHS.join(', ')}]: ${ALLOW.size} entities (strip_entities=${STRIP})`))
  .catch((e) => { console.error('fatal: cannot start the control connection:', e.message); process.exit(2); });
