// Where did this connection come from, and through which entry point?
//
// Every trimmed websocket arrives with three independent facts about its path, all of them
// already on the upgrade request and none of them currently recorded:
//
//   hop     req.socket.remoteAddress — the machine that actually opened the TCP connection.
//           A reverse proxy, a tunnel daemon, or the client itself when nothing is in front.
//   chain   X-Forwarded-For — every hop that admitted to being one, oldest first.
//   host    The Host header — WHICH hostname the client dialled, which in a multi-hostname
//           setup is the most direct statement of which entry point was used.
//
// From those we derive two labels:
//
//   route   direct | proxy | cloudflare | ingress — how it reached the add-on.
//   origin  lan | internet — whether the real client sits inside RFC1918 or outside it.
//
// A note on `origin` and hairpin NAT, because it looks like a bug the first time you see it:
// a device on your own LAN that reaches HA through an external hostname leaves the network,
// hits the CDN and comes back, arriving with your WAN address. It is reported as `internet`,
// which is correct — those bytes really did make the round trip, and that is exactly the
// cost worth seeing.
//
// ====================================================================================
// THIS IS OBSERVATIONAL DATA. DO NOT MAKE ACCESS DECISIONS WITH IT.
// ====================================================================================
// Every signal except `hop` is a request header, and request headers are typed by whoever
// sent them. Anything that can reach this port can claim `CF-Connecting-IP: 10.0.0.1` and
// present itself as a trusted LAN client arriving through the tunnel. Treating `origin` or
// `route` as an allow/deny input would therefore turn a spoofable header into an
// authorization decision — strictly worse than not having the field at all, because it reads
// like a security control. Making it trustworthy needs a configured list of trusted hops, so
// that forwarding headers are only believed from a peer known to be a real proxy. That does
// not exist here, and until it does this module answers "what happened", never "who may".

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// Node reports dual-stack peers as IPv4-mapped IPv6 (::ffff:10.2.3.42), proxies sometimes
// append ports, and IPv6 literals arrive bracketed. Reduce all of that to a bare address so
// the same client is one string no matter which path it came in on.
export function normalizeIp(value) {
  let s = String(value ?? '').trim();
  if (!s) return '';
  const bracketed = s.match(/^\[(.+?)\](?::\d+)?$/);      // [::1]:8123 -> ::1
  if (bracketed) s = bracketed[1];
  s = s.replace(/^::ffff:/i, '');                          // ::ffff:10.2.3.42 -> 10.2.3.42
  const withPort = s.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/);
  if (withPort) s = withPort[1];                           // 10.2.3.42:51234 -> 10.2.3.42
  return s.toLowerCase();
}

// RFC1918 and friends. Deliberately includes loopback and Docker's own ranges: a connection
// from 172.30.32.x is another add-on, not a person on the internet, and calling it `internet`
// would put the noisiest, least interesting traffic in the column you actually watch.
export function isPrivate(ip) {
  const s = normalizeIp(ip);
  if (!s) return false;
  if (IPV4.test(s)) {
    const [a, b] = s.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;      // covers Docker's 172.30.x
    if (a === 169 && b === 254) return true;               // link-local
    return false;
  }
  if (s === '::1' || s === '::') return true;              // loopback / unspecified
  if (/^f[cd]/.test(s)) return true;                       // fc00::/7 unique-local
  if (/^fe[89ab]/.test(s)) return true;                    // fe80::/10 link-local
  return false;
}

// Which hostname the client dialled. Port stripped so `host:9123` and `host` are one bucket,
// and length-capped because it is a header and ends up in a table.
function hostOf(headers) {
  const raw = headers[':authority'] || headers.host;
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const bracketed = s.match(/^\[(.+?)\](?::\d+)?$/);
  if (bracketed) return bracketed[1].slice(0, 120);
  return s.replace(/:\d+$/, '').slice(0, 120) || null;
}

export function classify(req) {
  const headers = req?.headers || {};
  const hop = normalizeIp(req?.socket?.remoteAddress);
  const chain = String(headers['x-forwarded-for'] || '')
    .split(',').map(normalizeIp).filter(Boolean);

  // Cloudflare stamps these at the edge and cloudflared passes them through the tunnel, so
  // any one of them means the request crossed Cloudflare. cdn-loop is checked as well because
  // it is the one header Cloudflare sets specifically so downstreams can detect it.
  const viaCf = Boolean(
    headers['cf-connecting-ip'] || headers['cf-ray'] ||
    /cloudflare/i.test(String(headers['cdn-loop'] || '')),
  );
  // Supervisor's Ingress, i.e. someone reached this through the HA sidebar rather than the
  // proxy port. Its own hop is always the Supervisor, so without this it would read as a
  // plain reverse proxy from 172.30.32.x.
  const viaIngress = Boolean(headers['x-ingress-path']);
  const forwarded = chain.length > 0 || Boolean(headers['x-real-ip']);

  // The real client address, with the same precedence the rest of the add-on already uses for
  // attribution (XFF first). `x-real-ip` is consulted before falling back to the peer because
  // a proxy that sets only that header would otherwise collapse ALL of its clients onto the
  // proxy's own address — one bucket, every device, silently.
  const ip = chain[0] || normalizeIp(headers['x-real-ip']) || hop;

  return {
    ip,
    hop: hop || null,
    host: hostOf(headers),
    route: viaCf ? 'cloudflare' : viaIngress ? 'ingress' : forwarded ? 'proxy' : 'direct',
    origin: ip ? (isPrivate(ip) ? 'lan' : 'internet') : null,
    // The full chain, but only when it says more than `ip` already does — one entry is just
    // the client repeated, and a table column that is always redundant trains you to skip it.
    hops: chain.length > 1 ? chain : null,
  };
}
