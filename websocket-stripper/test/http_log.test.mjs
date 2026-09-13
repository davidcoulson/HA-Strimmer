// HTTP access and error logs.
//
// The behaviour worth pinning is not "a row appears" — it is the reason there are two rings.
// A single combined log cannot serve both readers: size it to keep an error from this morning and
// it holds twenty minutes of traffic; size it for traffic and the error is gone before anyone
// looks. These tests hold that separation in place.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as log from '../http_log.mjs';

beforeEach(() => log.reset());

const hit = (over = {}) => log.record({
  method: 'GET', path: '/frontend_latest/app.js', status: 200, ms: 12, bytes: 500,
  ip: '10.0.0.1', ua: 'Mozilla/5.0', ...over,
});

test('an error survives a flood of successful requests', () => {
  hit({ status: 500, path: '/boom' });
  for (let i = 0; i < 900; i++) hit({ path: `/asset-${i}.js` });   // well past the access ring
  const s = log.snapshot();
  assert.equal(s.errors.length, 1, 'the error ring is not disturbed by ordinary traffic');
  assert.equal(s.errors[0].path, '/boom');
  assert.ok(s.access.length <= 500, 'the access ring stays bounded');
  assert.ok(!s.access.some((r) => r.path === '/boom'), 'and the error has long since aged out of it');
});

test('counts survive entries ageing out of the rings', () => {
  // Rolled up separately on purpose: a count derived from the ring would silently fall as old
  // rows are evicted, which would make the totals lie the longer the add-on ran.
  for (let i = 0; i < 900; i++) hit({ path: `/a-${i}` });
  hit({ status: 404, path: '/missing' });
  const s = log.snapshot();
  assert.equal(s.total, 901);
  assert.equal(s.byStatusClass['2xx'], 900);
  assert.equal(s.byStatusClass['4xx'], 1);
});

test('the panel polling itself is not logged as traffic', () => {
  // The panel fetches its own JSON every few seconds. Logging that would fill the ring with the
  // act of reading the ring.
  for (const p of ['/stats.json', '/history.json', '/access.json', '/pin-resource']) hit({ path: p });
  hit({ path: '/lovelace' });
  const s = log.snapshot();
  assert.equal(s.access.length, 1);
  assert.equal(s.access[0].path, '/lovelace');
  assert.equal(s.total, 5, 'they still count toward the total — they did happen');
});

test('a 4xx on a polled path is still kept as an error', () => {
  // Noise filtering applies to the access ring, never to failures: a 500 on /stats.json is the
  // most interesting thing that could happen to it.
  hit({ path: '/stats.json', status: 500 });
  assert.equal(log.snapshot().errors.length, 1);
});

test('the slowest requests are kept for the whole uptime', () => {
  // A p99 from an hour ago is exactly what a rolling window loses and a person wants.
  hit({ path: '/slow', ms: 9000 });
  for (let i = 0; i < 600; i++) hit({ path: `/fast-${i}`, ms: 5 });
  const s = log.snapshot();
  assert.equal(s.slowest[0].path, '/slow', 'the slow one is still there after the ring rolled over');
  assert.ok(s.slowest.length <= 15);
});

test('newest first, because a log is read from the end', () => {
  hit({ path: '/first' });
  hit({ path: '/second' });
  assert.equal(log.snapshot().access[0].path, '/second');
});

test('a long User-Agent is truncated rather than filling the table', () => {
  hit({ ua: 'x'.repeat(500) });
  assert.equal(log.snapshot().access[0].ua.length, 80);
});

test('query strings are stripped from the recorded path', () => {
  // Camera stream URLs carry a per-request signature; keeping them would make every row unique
  // and the log useless for spotting a repeated failure.
  log.record({ method: 'GET', path: '/api/camera_proxy/x', status: 200, ms: 1, bytes: 0 });
  assert.equal(log.snapshot().access[0].path, '/api/camera_proxy/x');
});
