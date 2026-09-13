// http_log.mjs — HTTP access and error logs, kept apart from the service log.
//
// The add-on's stdout is a service log: what it decided, what it trimmed, why an allowlist moved.
// That is the right stream for those, and the wrong one for a request log — a busy panel makes
// hundreds of requests a minute, and mixing them in would bury the one line that explains why a
// dashboard is behaving oddly. Anyone who has grepped an nginx error out of a combined log knows
// the shape of that problem.
//
// So requests go into ring buffers instead, and are read through the stats API rather than the
// add-on log. No files: HAOS add-ons write to a container filesystem that a rebuild discards, and
// putting rotation, size caps and disk-full handling into a proxy is a lot of moving parts for a
// log most people read twice.
//
// Two rings, deliberately:
//
//   access  everything, so "what happened just now" is answerable
//   errors  4xx and 5xx only, so a failure at 09:14 is still there at 17:00 rather than having
//           scrolled away behind a thousand successful asset fetches
//
// A single combined ring cannot do both: size it for the error you want to keep and it holds
// twenty minutes of traffic; size it for traffic and the error is gone before you look.

const ACCESS_MAX = 500;
const ERROR_MAX = 200;
// Paths that would otherwise dominate the ring without ever being interesting. The panel polls
// its own JSON every few seconds; logging that is self-inflicted noise.
const BORING = /\/(stats|history|access)\.json$|\/pin-resource$/;

const access = [];
const errors = [];
// Rolled up rather than derived from the ring, so the counts survive entries ageing out.
const byStatusClass = new Map();   // '2xx' | '3xx' | '4xx' | '5xx' -> count
const slowest = [];                // top N by duration, all time
const SLOWEST_MAX = 15;
let total = 0;

const push = (arr, row, cap) => { arr.push(row); if (arr.length > cap) arr.shift(); };

export function record({ method, path, status, ms, bytes, ip, ua }) {
  total += 1;
  const cls = `${Math.floor(status / 100)}xx`;
  byStatusClass.set(cls, (byStatusClass.get(cls) || 0) + 1);

  const row = {
    at: new Date().toISOString(),
    method, path, status,
    ms: Math.round(ms),
    bytes: bytes || 0,
    ip: ip || null,
    // Truncated: a User-Agent is useful for telling a wall panel from a phone, and useless at
    // full length in a table.
    ua: ua ? String(ua).slice(0, 80) : null,
  };

  if (!BORING.test(path)) push(access, row, ACCESS_MAX);
  if (status >= 400) push(errors, row, ERROR_MAX);

  // Keep the slowest requests for the whole uptime. A p99 that happened an hour ago is exactly
  // the thing a rolling window loses and a person actually wants.
  if (!BORING.test(path)) {
    slowest.push(row);
    slowest.sort((a, b) => b.ms - a.ms);
    if (slowest.length > SLOWEST_MAX) slowest.length = SLOWEST_MAX;
  }
}

export function snapshot({ limit = 100 } = {}) {
  return {
    total,
    byStatusClass: Object.fromEntries([...byStatusClass].sort()),
    // Newest first: a log is read from the end.
    access: access.slice(-limit).reverse(),
    errors: errors.slice(-limit).reverse(),
    slowest: slowest.slice(),
    capacity: { access: ACCESS_MAX, errors: ERROR_MAX },
  };
}

// Wrap a Node request/response pair so the row is recorded when the response finishes — which is
// the only point at which status, byte count and duration are all known.
export function observe(req, res, ipOf) {
  const started = process.hrtime.bigint();
  let bytes = 0;
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  // Counting on the way out rather than trusting content-length: a proxied response may be
  // chunked, and a stream that dies halfway should report what actually went out.
  res.write = (chunk, ...a) => { if (chunk) bytes += Buffer.byteLength(chunk); return write(chunk, ...a); };
  res.end = (chunk, ...a) => { if (chunk) bytes += Buffer.byteLength(chunk); return end(chunk, ...a); };
  res.on('finish', () => {
    try {
      record({
        method: req.method,
        path: String(req.url || '/').split('?')[0],
        status: res.statusCode,
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        bytes,
        ip: ipOf ? ipOf(req) : null,
        ua: req.headers?.['user-agent'],
      });
    } catch { /* a log must never be able to break the response it is describing */ }
  });
}

export function reset() {
  access.length = 0; errors.length = 0; slowest.length = 0;
  byStatusClass.clear(); total = 0;
}
