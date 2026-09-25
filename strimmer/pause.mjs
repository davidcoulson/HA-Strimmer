// Pausing the trim, per Home Assistant USER, for a bounded time.
//
// Why a pause exists at all: this add-on serves a panel only the entities its dashboard names,
// which is exactly wrong when a person is trying to TROUBLESHOOT. The case it was built for was
// real — an admin away from home, on their phone through Cloudflare, unable to see an entity
// because no card on the dashboard mentions it, and with no way to turn the trimming off from
// where they were standing.
//
// Why per USER rather than per device. A phone on cellular behind Cloudflare has no stable
// address: CF-Connecting-IP moves with the tower and the leftmost X-Forwarded-For entry is
// supplied by the caller anyway. The Home Assistant user behind the token does not move — it is
// the same identity `user_overrides` already matches on, it follows the person from phone to
// laptop, and it is already resolved for these connections. A pause aimed at an address would
// have been aimed at the least stable fact available.
//
// Why it EXPIRES rather than toggling. A pause that has to be turned off by hand is a pause that
// gets left on, and a trim that is off is invisible — panels just load slowly again, for as long
// as nobody notices. Every pause carries an expiry, so forgetting is bounded by an hour or a day
// instead of by attention.
//
// This is NOT an access control and must never be read as one. Pausing does not grant the
// connection anything Home Assistant would not already hand that same token: it stops this app
// filtering what HA is willing to send. Trimming is a performance measure, and turning it off
// has performance consequences and no security ones.

import fs from 'node:fs';

export const PAUSE_FILE = 'pauses.json';
// A pause is an emergency measure with a bounded life. A day is the longest that can still be
// called temporary; anything beyond it is a configuration change and belongs in the options.
export const MAX_PAUSE_MS = 24 * 3600 * 1000;

const filePath = (dataDir) => `${dataDir.replace(/\/$/, '')}/${PAUSE_FILE}`;

// Identity is matched on the HA user ID, never the display name. A name is editable in the HA UI
// and two people can share one; the id is what `auth/current_user` returns and what the console's
// Ingress headers carry, so both ends of this agree without a lookup.
//
// One reserved key stands for a ROLE rather than a person: every administrator at once. It exists
// because a switch in Home Assistant has no user — MQTT delivers a payload, not who published it
// — so a switch can only pause a GROUP. Administrators is the right group: they are the people
// who troubleshoot, and it leaves every kiosk and wall panel trimmed. A colon cannot appear in a
// Home Assistant user id (they are 32 hex characters), so this can never collide with one.
const keyOf = (user) => String(user ?? '').trim().toLowerCase();
export const ADMINS = 'role:admin';
export const isRoleKey = (k) => keyOf(k) === ADMINS;

export function emptyPauses() { return { pauses: {} }; }

// Read whatever is on disk, discarding anything that is not a live pause.
//
// Sanitised on LOAD, like history.mjs and for the same reason: this file is written by us but
// read after an arbitrary interval, across restarts and version changes, and a damaged row here
// would decide whether a connection is trimmed. An unreadable file is an empty one — the safe
// direction, because the failure mode is "trimming stays on", never "trimming silently stopped".
export function readPauses(dataDir, now = Date.now()) {
  if (!dataDir) return emptyPauses();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath(dataDir), 'utf8')); } catch { return emptyPauses(); }
  return sanitize(raw, now);
}

export function sanitize(raw, now = Date.now()) {
  const out = emptyPauses();
  if (!raw || typeof raw !== 'object') return out;
  const src = raw.pauses;
  if (!src || typeof src !== 'object') return out;
  for (const k of Object.keys(src)) {
    if (k === '__proto__' || k === 'constructor') continue;   // same rule as the config store
    const v = src[k];
    if (!v || typeof v !== 'object') continue;
    const until = Number(v.until);
    if (!Number.isFinite(until) || until <= now) continue;    // expired or nonsense: drop it
    out.pauses[keyOf(k)] = {
      until: Math.min(until, now + MAX_PAUSE_MS),             // a hand-edited year is still a day
      name: typeof v.name === 'string' ? v.name.slice(0, 120) : null,
      by: typeof v.by === 'string' ? v.by.slice(0, 120) : null,
      at: typeof v.at === 'string' ? v.at : new Date(now).toISOString(),
    };
  }
  return out;
}

export function writePauses(dataDir, state) {
  if (!dataDir) return null;
  const p = filePath(dataDir);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);                                      // atomic, like every other /data write here
  return p;
}

// Add or extend a pause. Returns the new state; the caller persists and acts on it.
export function pauseUser(state, user, ms, { name = null, by = null, now = Date.now() } = {}) {
  const key = keyOf(user);
  if (!key) throw new Error('a pause needs a Home Assistant user id');
  const span = Math.max(0, Math.min(Number(ms) || 0, MAX_PAUSE_MS));
  if (!span) throw new Error('a pause needs a duration');
  return {
    ...state,
    pauses: {
      ...state.pauses,
      [key]: { until: now + span, name, by, at: new Date(now).toISOString() },
    },
  };
}

export function resumeUser(state, user) {
  const key = keyOf(user);
  if (!state.pauses[key]) return state;
  const pauses = { ...state.pauses };
  delete pauses[key];
  return { ...state, pauses };
}

// Drop everything that has run out. Returns [state, expiredUserKeys] so the caller can recycle
// exactly the connections that have just gone back to being trimmed.
export function sweep(state, now = Date.now()) {
  const expired = Object.keys(state.pauses).filter((k) => state.pauses[k].until <= now);
  if (!expired.length) return [state, expired];
  const pauses = { ...state.pauses };
  for (const k of expired) delete pauses[k];
  return [{ ...state, pauses }, expired];
}

// Is this user's trim paused right now? Returns the expiry in ms, or null.
export function pausedUntil(state, user, now = Date.now()) {
  const hit = state.pauses[keyOf(user)];
  if (!hit || hit.until <= now) return null;
  return hit.until;
}

// The question the bridge actually asks: is THIS person's trim paused, by name or by role?
// Returns the expiry, or null. `is_admin` comes from `auth/current_user`, the same field the
// `role: admin` override matcher already uses — so "admin" means exactly what it means everywhere
// else in this add-on, rather than a second definition that could drift from it.
export function pausedForUser(state, user, now = Date.now()) {
  if (!user) return null;
  const own = pausedUntil(state, user.id, now) ?? pausedUntil(state, user.name, now);
  if (own) return own;
  return user.is_admin ? pausedUntil(state, ADMINS, now) : null;
}

export const anyActive = (state, now = Date.now()) =>
  Object.values(state.pauses).some((p) => p.until > now);

// What the console renders, newest expiry last. `name` is carried for display only.
export function listPauses(state, now = Date.now()) {
  return Object.entries(state.pauses)
    .filter(([, p]) => p.until > now)
    .map(([user, p]) => ({
      user,
      role: isRoleKey(user) ? 'admin' : null,
      // The role pause has no person to name, so it carries its own label rather than leaving the
      // console to special-case a key it should not have to know about.
      name: isRoleKey(user) ? 'administrators' : p.name,
      by: p.by, at: p.at, until: p.until, msLeft: p.until - now,
    }))
    .sort((a, b) => a.until - b.until);
}

// "Rest of the day" means the viewer's midnight, which this process cannot know — the container
// runs UTC and the person is somewhere else. The console sends its own offset in minutes
// (Date.getTimezoneOffset), and the span is computed from that. Clamped to the same maximum as
// everything else, so a bogus offset cannot buy more than a day.
export function msUntilEndOfDay(offsetMinutes = 0, now = Date.now()) {
  const off = Number.isFinite(Number(offsetMinutes)) ? Number(offsetMinutes) : 0;
  const local = new Date(now - off * 60000);
  const endLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 23, 59, 59, 999);
  const span = (endLocal + off * 60000) - now;
  return Math.max(60000, Math.min(span, MAX_PAUSE_MS));       // never less than a minute
}
