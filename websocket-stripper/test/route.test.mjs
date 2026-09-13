// Classifying where a connection came from and which front door it used.
//
// The risk in this module is not that a label comes out wrong — it is that a label comes out
// wrong and nobody notices, because it is reporting-only data nothing else depends on. So the
// tests pin the real topologies rather than synthetic ones: direct on the LAN, through a
// reverse proxy, through Cloudflare, and the hairpin case that looks like a bug.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classify, normalizeIp, isPrivate } from '../route.mjs';

const req = (headers = {}, remoteAddress = '10.2.3.1') => ({ headers, socket: { remoteAddress } });

describe('normalizeIp', () => {
  it('unwraps the forms a client address actually arrives in', () => {
    assert.equal(normalizeIp('::ffff:10.2.3.42'), '10.2.3.42');   // Node dual-stack
    assert.equal(normalizeIp('10.2.3.42:51234'), '10.2.3.42');    // proxy with port
    assert.equal(normalizeIp('[2001:db8::1]:443'), '2001:db8::1');
    assert.equal(normalizeIp('  10.2.3.42 '), '10.2.3.42');
    assert.equal(normalizeIp(undefined), '');
  });

  it('does not mistake an IPv6 address for a host:port pair', () => {
    // The port-stripping regex is IPv4-only on purpose: '2001:db8::1' ends in ':1' and a
    // looser rule would silently truncate every IPv6 client to '2001:db8:'.
    assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
  });
});

describe('isPrivate', () => {
  it('covers the ranges a home instance actually sees', () => {
    for (const ip of ['10.2.3.42', '192.168.1.5', '172.16.0.1', '172.30.32.1', '127.0.0.1',
                      '169.254.1.1', '::1', 'fd00::1', 'fe80::1']) {
      assert.equal(isPrivate(ip), true, `${ip} should be private`);
    }
  });

  it('does not treat 172.32 as private just because 172.16 is', () => {
    // 172.16/12 stops at 172.31. Getting this wrong labels a public host as LAN.
    assert.equal(isPrivate('172.15.0.1'), false);
    assert.equal(isPrivate('172.31.255.255'), true);
    assert.equal(isPrivate('172.32.0.1'), false);
  });

  it('calls public addresses public', () => {
    for (const ip of ['74.131.254.145', '8.8.8.8', '2606:4700::1']) {
      assert.equal(isPrivate(ip), false, `${ip} should be public`);
    }
  });
});

describe('classify: real topologies', () => {
  it('a browser straight at the proxy port is lan/direct', () => {
    const r = classify(req({ host: '10-2-3-6.coulson.io:9123' }, '::ffff:10.2.3.42'));
    assert.equal(r.ip, '10.2.3.42');
    assert.equal(r.origin, 'lan');
    assert.equal(r.route, 'direct');
    assert.equal(r.host, '10-2-3-6.coulson.io', 'the port is not part of the front door');
    assert.equal(r.hop, '10.2.3.42', 'nothing in front, so the peer IS the client');
  });

  it('a reverse proxy is lan/proxy, and the client is the far end of the chain', () => {
    const r = classify(req({
      host: 'home-iot.coulson.io',
      'x-forwarded-for': '10.2.4.129',
      'x-real-ip': '10.2.4.129',
    }, '172.30.33.2'));
    assert.equal(r.ip, '10.2.4.129', 'not the proxy container');
    assert.equal(r.hop, '172.30.33.2', 'the proxy is still recorded as the hop');
    assert.equal(r.route, 'proxy');
    assert.equal(r.origin, 'lan');
  });

  it('Cloudflare is detected by any of its three markers', () => {
    for (const h of [{ 'cf-connecting-ip': '74.131.254.145' }, { 'cf-ray': '8f2a-DFW' },
                     { 'cdn-loop': 'cloudflare; loops=1' }]) {
      const r = classify(req({ host: 'ha.example.com', 'x-forwarded-for': '74.131.254.145', ...h }, '172.30.33.4'));
      assert.equal(r.route, 'cloudflare', `missed ${Object.keys(h)[0]}`);
    }
  });

  it('reports hairpinned LAN traffic as internet, because that is what happened', () => {
    // A machine on the home LAN reaching HA through the external hostname: out to the CDN and
    // back in, arriving with the WAN address. Calling this 'lan' would hide the round trip,
    // which is the single most useful thing this field can show.
    const r = classify(req({
      host: 'ha.example.com',
      'cf-connecting-ip': '74.131.254.145',
      'x-forwarded-for': '74.131.254.145',
      'cf-ray': '8f2a-DFW',
    }, '172.30.33.4'));
    assert.equal(r.origin, 'internet');
    assert.equal(r.route, 'cloudflare');
    assert.equal(r.ip, '74.131.254.145');
  });

  it('separates Supervisor ingress from an ordinary reverse proxy', () => {
    // Both arrive from 172.30.32.x with forwarding headers; only the ingress path carries
    // x-ingress-path, so without checking it the sidebar reads as 'proxy'.
    const r = classify(req({
      host: '10.2.3.6:8123',
      'x-ingress-path': '/api/hassio_ingress/abc',
      'x-forwarded-for': '10.2.3.42',
    }, '172.30.32.2'));
    assert.equal(r.route, 'ingress');
  });

  it('keeps the full chain only when it adds something', () => {
    const one = classify(req({ 'x-forwarded-for': '10.2.3.42' }, '172.30.33.2'));
    assert.equal(one.hops, null, 'a one-entry chain just repeats ip');
    const two = classify(req({ 'x-forwarded-for': '74.131.254.145, 172.30.33.4' }, '172.30.33.2'));
    assert.deepEqual(two.hops, ['74.131.254.145', '172.30.33.4']);
    assert.equal(two.ip, '74.131.254.145', 'oldest entry is the real client');
  });

  it('falls back to x-real-ip so a proxy cannot collapse all its clients into one', () => {
    // Some proxies set only x-real-ip. Before this fallback every client behind such a proxy
    // was attributed to the proxy's own address — one IP, every device, and per-dashboard
    // attribution silently degraded to whoever loaded last.
    const r = classify(req({ 'x-real-ip': '10.2.4.109' }, '172.30.33.2'));
    assert.equal(r.ip, '10.2.4.109');
    assert.equal(r.route, 'proxy');
  });

  it('survives a request with no headers and no peer at all', () => {
    const r = classify({});
    assert.equal(r.route, 'direct');
    assert.equal(r.origin, null, 'no address means no honest origin, not a guessed one');
    assert.equal(r.host, null);
  });
});

describe('classify: this data is spoofable', () => {
  it('believes forged headers, which is exactly why it must not gate access', () => {
    // Anything that can reach the port can claim to be a trusted LAN client arriving through
    // the tunnel. This test exists to document that as intended behaviour: the module reports
    // what it was told. If a future change ever routes allow/never rules through `origin` or
    // `route`, this is the test that should have stopped it.
    const forged = classify(req({
      'cf-connecting-ip': '10.2.3.42',
      'x-forwarded-for': '10.2.3.42',
    }, '198.51.100.7'));
    assert.equal(forged.origin, 'lan', 'a public attacker now reads as LAN');
    assert.equal(forged.hop, '198.51.100.7', 'only the peer address cannot be faked');
    assert.notEqual(forged.hop, forged.ip, 'the hop is the one signal worth trusting');
  });
});
