// The resource diagnostics check themselves now, because one of them lied and nothing noticed.
//
// On 2026-09-15 "dropped by ALL dashboards" named 42 of 42 resources on an install where one
// dashboard alone kept 21. It compared raw URLs against normalised paths, so nothing matched once
// a URL carried `?hacstag=` — which every HACS resource does. No test caught it; arithmetic did.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resourceInvariantProblems } from '../resource_invariants.mjs';

const ok = (o) => resourceInvariantProblems(o);

describe('a self-consistent report raises nothing', () => {
  it('stays quiet when the numbers agree', () => {
    const problems = ok({
      total: 3,
      keptByDash: new Map([['a', 2], ['b', 1]]),
      droppedByAll: ['/r/unused.js'],
      droppedByDash: new Map([
        ['a', new Set(['/r/unused.js'])],
        ['b', new Set(['/r/unused.js', '/r/only-a.js'])],
      ]),
    });
    assert.deepEqual(problems, []);
  });

  it('stays quiet with nothing dropped anywhere', () => {
    assert.deepEqual(ok({
      total: 2,
      keptByDash: new Map([['a', 2]]),
      droppedByAll: [],
      droppedByDash: new Map([['a', new Set()]]),
    }), []);
  });
});

describe('the counting check', () => {
  // The real failure, with the real numbers.
  it('catches the 2026-09-15 bug: 42 of 42 reported, 21 kept by one dashboard', () => {
    const problems = ok({
      total: 42,
      keptByDash: new Map([
        ['lovelace', 21], ['dashboard-test', 14], ['basement-stairs-panel', 4],
        ['nspanel-pro-home-theater', 8], ['office-tablet', 7],
      ]),
      droppedByAll: Array.from({ length: 42 }, (_, i) => `/r/${i}.js`),
      droppedByDash: new Map([['lovelace', new Set(Array.from({ length: 42 }, (_, i) => `/r/${i}.js`))]]),
    });
    assert.ok(problems.length >= 1, 'the impossible count must be reported');
    assert.match(problems[0], /lists 42 of 42/);
    assert.match(problems[0], /at most 21/);
    assert.match(problems[0], /lovelace alone is served 21/);
  });

  it('accepts a count exactly at the ceiling', () => {
    // total 10, best dashboard keeps 4, so 6 dropped-everywhere is legal — an off-by-one here
    // would cry wolf on a correct report, which is how a checker gets switched off.
    const urls = Array.from({ length: 6 }, (_, i) => `/r/${i}.js`);
    assert.deepEqual(ok({
      total: 10,
      keptByDash: new Map([['a', 4], ['b', 2]]),
      droppedByAll: urls,
      droppedByDash: new Map([['a', new Set(urls)], ['b', new Set(urls)]]),
    }), []);
  });

  it('says nothing when there are no dashboards to bound it', () => {
    assert.deepEqual(ok({
      total: 5, keptByDash: new Map(), droppedByAll: [], droppedByDash: new Map(),
    }), []);
  });
});

describe('the set-membership check', () => {
  it('catches a resource reported dropped that a dashboard is actually served', () => {
    const problems = ok({
      total: 4,
      keptByDash: new Map([['a', 1], ['b', 1]]),
      // /r/mushroom.js is served to 'a' — it cannot also be dropped by ALL.
      droppedByAll: ['/r/mushroom.js'],
      droppedByDash: new Map([
        ['a', new Set(['/r/other.js'])],
        ['b', new Set(['/r/mushroom.js', '/r/other.js'])],
      ]),
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /\/r\/mushroom\.js is reported dropped by ALL dashboards, but a is served it/);
  });

  it('caps a flood so one bug cannot bury the log', () => {
    const urls = Array.from({ length: 30 }, (_, i) => `/r/${i}.js`);
    const problems = ok({
      total: 100,
      keptByDash: new Map([['a', 1]]),
      droppedByAll: urls,
      droppedByDash: new Map([['a', new Set()]]),
    });
    const named = problems.filter((p) => p.includes('is reported dropped'));
    assert.equal(named.length, 5, 'at most five are named individually');
    assert.ok(problems.some((p) => /and 25 more/.test(p)), 'the rest are counted, not dropped');
  });
});

// The checks have to be derived DIFFERENTLY from what they check, or they are decoration.
describe('the checks are independent of the code they check', () => {
  it('does not assert kept + dropped === total', () => {
    // That relation is true by construction in the proxy (`dropped` is defined as
    // `rows.length - keep.size`), so a check on it can never fail. Feeding a set of numbers that
    // violates it must NOT be what trips the checker — otherwise the suite is testing a
    // tautology and would pass against the broken code that started all this.
    const problems = ok({
      total: 10,
      keptByDash: new Map([['a', 3]]),   // implies 7 dropped
      droppedByAll: ['/r/x.js'],          // 1 <= 10 - 3, fine
      droppedByDash: new Map([['a', new Set(['/r/x.js'])]]),
    });
    assert.deepEqual(problems, [], 'only the independent invariants may fire');
  });
});
