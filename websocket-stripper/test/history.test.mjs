// The 24h history behind the panel's charts.
//
// The interesting cases are all about counters that reset. stats.mjs counts cumulatively from
// process start, so a restart makes the series go backwards — and a naive delta would emit a
// large negative bucket, which renders as a chart spike in the wrong direction and poisons the
// window total.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as history from '../history.mjs';

const snap = (saved, before, events, clients = 1, cacheHits = 0) => ({
  savings: { saved, before },
  eventStream: { bytes: events },
  clients: { open: clients },
  registryCache: { hits: cacheHits },
});

describe('history sampling', () => {
  beforeEach(() => history.reset());

  it('stores per-bucket deltas, not cumulative counters', () => {
    history.push(snap(100, 1000, 10), 1000);
    history.push(snap(250, 2000, 30), 2000);
    history.push(snap(400, 4000, 60), 3000);
    const s = history.history().samples;
    assert.deepEqual(s.map((x) => x.saved), [100, 150, 150]);
    assert.deepEqual(s.map((x) => x.events), [10, 20, 30]);
    assert.deepEqual(s.map((x) => x.before), [1000, 1000, 2000]);
  });

  it('treats a counter going backwards as a restart, never a negative bucket', () => {
    history.push(snap(500, 5000, 90), 1000);
    history.push(snap(800, 9000, 120), 2000);
    // Add-on restarted: counters begin again from a small value.
    history.push(snap(40, 300, 5), 3000);
    const s = history.history().samples;
    assert.deepEqual(s.map((x) => x.saved), [500, 300, 40]);
    assert.ok(s.every((x) => x.saved >= 0), 'no bucket may be negative');
    assert.ok(s.every((x) => x.events >= 0));
  });

  it('keeps clients as a gauge rather than differencing it', () => {
    history.push(snap(0, 0, 0, 4), 1000);
    history.push(snap(0, 0, 0, 2), 2000);
    assert.deepEqual(history.history().samples.map((x) => x.clients), [4, 2]);
  });

  it('drops samples older than the window', () => {
    const now = 10_000_000_000;
    history.push(snap(10, 10, 10), now - 25 * 3600 * 1000);   // 25h ago
    history.push(snap(20, 20, 20), now - 1 * 3600 * 1000);    // 1h ago
    history.push(snap(30, 30, 30), now);
    const s = history.history().samples;
    assert.equal(s.length, 2, 'the 25-hour-old sample is outside the window');
    assert.ok(s.every((x) => x.t >= now - 24 * 3600 * 1000));
  });

  it('totals the window and reports the span it actually covers', () => {
    history.push(snap(100, 1000, 0), 1000);
    history.push(snap(300, 3000, 0), 61000);
    const t = history.history().totals;
    assert.equal(t.saved, 300);          // 100 + 200
    assert.equal(t.before, 3000);        // 1000 + 2000
    assert.equal(t.spanMs, 60000, 'span is measured, not assumed to be 24h');
  });
});

describe('history persistence', () => {
  let dir;
  beforeEach(() => {
    history.reset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stripper-hist-'));
  });

  it('survives a restart through /data', () => {
    // start() samples immediately, so one bucket exists without waiting for the interval.
    history.start(() => snap(100, 1000, 10), dir, 1e9);
    assert.equal(history.history().samples.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'history.json')), 'history was written');
    history.stop();

    // Simulate a fresh process: module state cleared, same data dir.
    history.reset();
    assert.equal(history.history().samples.length, 0);
    history.load(dir);
    assert.equal(history.history().samples.length, 1, 'history came back from disk');
  });

  it('starts clean rather than throwing on a corrupt file', () => {
    fs.writeFileSync(path.join(dir, 'history.json'), '{not json');
    assert.doesNotThrow(() => history.load(dir));
    assert.deepEqual(history.history().samples, []);
  });

  it('does not need a data directory at all', () => {
    history.reset();
    assert.doesNotThrow(() => history.start(() => snap(5, 50, 1), null, 1e9));
    assert.equal(history.history().samples.length, 1, 'still samples in memory');
    history.stop();
  });

  it('samples immediately on start, not one interval later', () => {
    // Regression: the first bucket used to land a full interval after boot and the first
    // chart an interval after that, so a freshly restarted add-on showed an empty card for
    // ten minutes and looked broken while working perfectly.
    history.reset();
    history.start(() => snap(7, 70, 3), null, 1e9);
    assert.equal(history.history().samples.length, 1, 'a bucket exists before the first tick');
    history.stop();
  });
});

// Connection flows over the window, which the panel's "Last 24h" Sankey reads.
//
// Flows are a MAP of counters rather than one number, so the restart rule has to be applied per
// key — and a key can also appear for the first time mid-window, which from the delta's point of
// view is indistinguishable from a restart and must be treated the same way.
describe('history flows', () => {
  beforeEach(() => history.reset());

  const withFlows = (flows) => ({
    savings: { saved: 0, before: 0 },
    eventStream: { bytes: 0 },
    registryCache: { hits: 0 },
    clients: { open: 1 },
    paths: { flows },
  });

  it('sums each path across the window', () => {
    history.push(withFlows([{ origin: 'lan', route: 'proxy', host: 'a', n: 2 }]), 1000);
    // Cumulative counter: 5 total means 3 more in this bucket.
    history.push(withFlows([{ origin: 'lan', route: 'proxy', host: 'a', n: 5 }]), 2000);
    const { flows } = history.history().totals;
    assert.deepEqual(flows, [{ origin: 'lan', route: 'proxy', host: 'a', n: 5 }]);
  });

  it('treats a counter that went backwards as a restart, not a negative bucket', () => {
    history.push(withFlows([{ origin: 'lan', route: 'proxy', host: 'a', n: 10 }]), 1000);
    // The add-on restarted: the counter is now counting up from zero again.
    history.push(withFlows([{ origin: 'lan', route: 'proxy', host: 'a', n: 3 }]), 2000);
    const { flows } = history.history().totals;
    // 10 before the restart plus 3 after it. The bug this guards against is 10 + (3 - 10) = 3,
    // which silently erases everything that happened before the restart.
    assert.equal(flows[0].n, 13);
    assert.ok(flows.every((f) => f.n > 0), 'no bucket may contribute a negative count');
  });

  it('counts a path first seen mid-window from zero rather than from nothing', () => {
    history.push(withFlows([{ origin: 'lan', route: 'proxy', host: 'a', n: 4 }]), 1000);
    history.push(withFlows([
      { origin: 'lan', route: 'proxy', host: 'a', n: 4 },
      { origin: 'internet', route: 'cloudflare', host: 'b', n: 2 },
    ]), 2000);
    const { flows } = history.history().totals;
    const b = flows.find((f) => f.host === 'b');
    assert.equal(b.n, 2, 'a newly-seen path contributes its whole count');
    assert.equal(flows.find((f) => f.host === 'a').n, 4, 'an unchanged path adds nothing');
  });

  it('keeps flows out of the window once their buckets age out', () => {
    const DAY = 24 * 3600 * 1000;
    const now = Date.now();
    history.push(withFlows([{ origin: 'lan', route: 'proxy', host: 'old', n: 9 }]), now - DAY - 60000);
    history.push(withFlows([{ origin: 'lan', route: 'proxy', host: 'new', n: 1 }]), now);
    const hosts = history.history().totals.flows.map((f) => f.host);
    assert.ok(!hosts.includes('old'), 'a bucket older than the window must not be counted');
  });
});
