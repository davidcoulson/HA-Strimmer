// A 24-hour rolling history behind the stats panel.
//
// The counters in stats.mjs are cumulative since process start, which makes them useless for
// "what did this thing do overnight" — and they reset to zero on every add-on restart, so a
// restart silently erases the evidence. This samples them on a fixed interval, stores the
// DELTA per bucket, and persists to /data so a restart costs one bucket rather than the day.
//
// Deltas, not cumulative values, because a restart makes a cumulative series go backwards. A
// bucket whose counter decreased is treated as the first bucket after a restart: the reading
// itself is the delta, since the process started from zero.
//
// Sampling is deliberately coarse. At 5 minutes, 24 hours is 288 buckets — a file small
// enough to rewrite whole on every sample, which avoids any append/corruption handling.

import fs from 'node:fs';
import path from 'node:path';

export const INTERVAL_MS = 5 * 60 * 1000;
export const KEEP = 288;                       // 288 * 5min = 24h
const WINDOW_MS = KEEP * INTERVAL_MS;

let samples = [];
let prev = null;
let timer = null;
let file = null;

const num = (v) => (Number.isFinite(v) ? v : 0);

// What each sample records. Gauges are point-in-time; counters become per-bucket deltas.
function read(snap) {
  return {
    clients: num(snap?.clients?.open),                 // gauge
    saved: num(snap?.savings?.saved),                  // counter
    before: num(snap?.savings?.before),                // counter
    events: num(snap?.eventStream?.bytes),             // counter
    cacheHits: num(snap?.registryCache?.hits),         // counter
    // Connection flows, as "origin|route|host" -> cumulative count. A map of counters rather
    // than a single number, so the 24h view can show the same breakdown as the live one instead
    // of only a total. Each key is delta'd independently below.
    flows: flowMap(snap?.paths?.flows),
  };
}

// The snapshot carries flows as an array of objects; a keyed map is what deltas need.
function flowMap(arr) {
  const m = {};
  if (!Array.isArray(arr)) return m;
  for (const f of arr) {
    if (!f || !Number.isFinite(f.n)) continue;
    m[`${f.origin}|${f.route}|${f.host}`] = f.n;
  }
  return m;
}

// Same restart rule as the scalar counters, applied per key: a key whose count went backwards —
// or that is absent from the previous reading, which is what a restart looks like from here —
// contributes its whole current value, because it accumulated from zero.
function flowDelta(cur, prevFlows) {
  const out = {};
  for (const [k, n] of Object.entries(cur)) {
    const was = prevFlows?.[k];
    const d = !Number.isFinite(was) || n < was ? n : n - was;
    if (d > 0) out[k] = d;
  }
  return out;
}

export function push(snap, now = Date.now()) {
  const cur = read(snap);
  // A counter that went backwards means the process restarted between samples; the current
  // reading IS the delta in that case, because it accumulated from zero.
  const delta = (k) => (prev === null || cur[k] < prev[k] ? cur[k] : cur[k] - prev[k]);
  samples.push({
    t: now,
    clients: cur.clients,
    saved: delta('saved'),
    before: delta('before'),
    events: delta('events'),
    cacheHits: delta('cacheHits'),
    flows: flowDelta(cur.flows, prev?.flows),
  });
  prev = cur;
  const cutoff = now - WINDOW_MS;
  samples = samples.filter((s) => s.t >= cutoff).slice(-KEEP);
  return samples;
}

function persist() {
  if (!file) return;
  try {
    // Whole-file rewrite via a temp file and rename, so a crash mid-write cannot leave a
    // half-written history that fails to parse on the next boot.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, samples }));
    fs.renameSync(tmp, file);
  } catch {
    /* history is a nicety; never take the proxy down for it */
  }
}

export function load(dataDir, now = Date.now()) {
  file = path.join(dataDir, 'history.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cutoff = now - WINDOW_MS;
    samples = (Array.isArray(raw?.samples) ? raw.samples : [])
      .filter((s) => s && Number.isFinite(s.t) && s.t >= cutoff)
      .slice(-KEEP);
  } catch {
    samples = [];
  }
  // prev stays null: the process just started, so the next sample's counters are its own
  // deltas, which is exactly what the restart rule above produces.
  return samples;
}

export function start(getSnapshot, dataDir, interval = INTERVAL_MS) {
  if (dataDir) load(dataDir);
  const tick = () => {
    try { push(getSnapshot()); persist(); } catch { /* never throw from a timer */ }
  };
  // Sample immediately as well as on the interval. Without this the first bucket lands a
  // whole interval after startup and the first CHART lands two intervals after — ten minutes
  // of a panel that looks broken, which is the exact failure this panel exists to remove.
  tick();
  timer = setInterval(tick, interval);
  if (typeof timer.unref === 'function') timer.unref();
  return tick;
}

export function stop() { if (timer) clearInterval(timer); timer = null; }

export function history() {
  return {
    intervalMs: INTERVAL_MS,
    windowHours: (KEEP * INTERVAL_MS) / 3600000,
    samples,
    // Totals over whatever window actually exists, which is not 24h until the add-on has
    // been up that long. Reported so the panel can say so rather than implying a full day.
    totals: {
      ...samples.reduce(
        (a, s) => ({
          saved: a.saved + s.saved,
          before: a.before + s.before,
          events: a.events + s.events,
          cacheHits: a.cacheHits + s.cacheHits,
          spanMs: samples.length > 1 ? samples[samples.length - 1].t - samples[0].t : 0,
        }),
        { saved: 0, before: 0, events: 0, cacheHits: 0, spanMs: 0 },
      ),
      // Flows summed across the window, in the same {origin, route, host, n} shape the live
      // snapshot uses — so the panel draws the 24h diagram with exactly the code that draws the
      // live one, and the only difference between the two views is which array it is handed.
      flows: (() => {
        const m = new Map();
        for (const s of samples) {
          for (const [k, n] of Object.entries(s.flows || {})) m.set(k, (m.get(k) || 0) + n);
        }
        return [...m]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => {
            const [origin, route, host] = k.split('|');
            return { origin, route, host, n };
          });
      })(),
    },
  };
}

export function reset() { samples = []; prev = null; file = null; }
