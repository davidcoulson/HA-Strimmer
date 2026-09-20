# Proposal: multi-process Strimmer

Status: **proposal, not built.** Written 2026-09-19 after measuring, so the decision rests on
numbers rather than instinct.

The question behind it: *can the app be split across processes so one bad actor — a pathological
regex, a huge frame, a wedged handler — cannot block every panel at once?*

---

## 1. Two facts that decide the shape

Both were tested, not assumed.

### A SharedArrayBuffer does not survive cluster IPC

```js
// primary
const sab = new SharedArrayBuffer(1024);
worker.send({ sab });
// worker receives:  { got: 'Object' }     <- a plain object, not a SharedArrayBuffer
```

`process.send()` serialises. `SharedArrayBuffer` is shareable between **worker_threads**, which
live in one process, and not between **cluster workers**, which are separate processes. So true
shared memory across a cluster needs a native addon (POSIX `shm_open`/`mmap`), and this project
does not take native dependencies — the same rule that ruled out `re2` for the regex guard.

What is left that needs no addon:

- **`/dev/shm` tmpfs files.** Shared, fast, dependency-free — but it is a *filesystem*, not shared
  memory. Every read deserialises and every write needs a locking scheme you write yourself. It
  buys the word "SHM" and none of the zero-copy.
- **IPC to a state-owner process.** A round trip and a deserialise per lookup.

### The two mechanisms have opposite strengths

|  | pass a socket | share memory |
| --- | --- | --- |
| `cluster` (processes) | **yes**, natively | no |
| `worker_threads` | not for net sockets | **yes**, real `SharedArrayBuffer` |

That tension is the whole problem. A design that wants both has to give one up.

`reusePort` **is** supported on the target (verified in the running container: Linux, Node
v26.9.0, 8 CPUs), so each worker could bind its own listener and let the kernel distribute. But
the kernel hashes the 4-tuple, and a client uses a new source port per connection — so
`reusePort` distributes *connections*, not *clients*. It gives no stickiness, which as section 3
shows is the property that matters here.

---

## 2. What the app would have to share

| State | Size | Why it is shared today |
| --- | --- | --- |
| `REG_RESPONSE_CACHE` | large values | Trimmed registry answers reused across connections — CLAUDE.md records a 97.9% hit rate |
| `ALLOW`, `ALLOW_BY_DASH` | ~466 ids + per-dashboard | Every bridge reads it |
| `REG_BY_ENTITY`, `AREA_BY_DEVICE`, `PLATFORM_BY_ENTITY`, `REG_CACHE_BY_ENTITY` | ~17k entries each, ~2 MB | Registry and translation trimming, per frame |
| `clientDash` (ip → dashboard) | per client | Dashboard attribution — **the core feature** |
| `clientLearned`, `USER_CACHE` | per client | Self-identified satellites, per-user rules |
| `stats`, `history` | counters | The console |

The naive read is that all of it needs sharing, which is what makes clustering look expensive.
It does not.

---

## 3. The design: sticky by client, not shared memory

**Nothing on the hot path needs to be shared if each client always lands on the same worker.**

Look at what actually fragments. `clientDash` is keyed by IP. `clientLearned` is keyed by IP.
`USER_CACHE` is keyed by a token that belongs to one browser. And the registry cache's hits come,
per CLAUDE.md, from *"the same panel across its many reconnects"* — also one client. Every one of
those is **client-local state, not global state.** Route a client consistently to one worker and
they all keep working, unshared.

```
                      ┌─────────────────────────────────────────┐
   panels ──TCP──►    │ PRIMARY                                 │
                      │  • accepts, hashes client IP, hands the │
                      │    socket to worker[hash % N]           │
                      │  • owns the ONE control ws to HA        │
                      │  • owns /data, MQTT, mDNS, history      │
                      │  • aggregates stats for the console     │
                      └───────────────┬─────────────────────────┘
                        broadcast on rebuild (~2 MB, a few times an hour)
                      ┌───────────────┴─────────────────────────┐
                      │ WORKER 1..N — bridges only              │
                      │  • allowlist + registry lookups (copy)  │
                      │  • REG_RESPONSE_CACHE   (per worker)    │
                      │  • clientDash / learned (per worker)    │
                      └─────────────────────────────────────────┘
```

**Routing.** `cluster`'s default on Linux is round-robin, which destroys locality — so the primary
accepts and passes the handle itself, choosing `hash(clientIP) % N`. This also keeps the page GET
and the websocket upgrade that follows it on the same worker, without which dashboard attribution
silently falls back to the union. The primary touches every *connection* but no *frame*, so it
stays cheap.

**Shared state reduces to one broadcast.** On each rebuild the primary sends the allowlist and the
derived registry lookups to every worker — ~2 MB, measured at ~13 ms to serialise, a few times an
hour now that the field filter and the 30 s floor are in. No SHM, no locking, no `/dev/shm`.

### What this does not solve

- **Behind a reverse proxy every connection shares one peer address**, so the hash collapses and
  one worker takes everything. LAN panels connect directly and distribute fine; traffic through
  NPM or Cloudflare would not. Hashing the resolved client IP instead means the primary must parse
  HTTP headers before handing the socket over — doable, but it puts request parsing in the one
  place that must never be slow.
- **Singletons must move to the primary or run N times**: the MQTT publisher, mDNS discovery, the
  history sampler, the certificate check, and every `/data` write (user cache, client hints,
  config store). N writers to one file is corruption.
- Logs interleave from N processes.
- Config writes from the console arrive at one worker and must be forwarded to the primary.

---

## 4. What it costs and what it buys

**Costs**

- Memory: roughly `N × (V8 baseline ~40 MB + ~2 MB of registry lookups)`. At N=4 that is ~170 MB
  on top of today's 109 MB — about 3×.
- Complexity in the least forgiving part of the codebase. CLAUDE.md's longest sections are the
  cache-key and attribution rules, and both become distributed problems.
- New failure modes: worker death mid-connection, broadcast skew (a worker briefly on an older
  allowlist), split-brain on `/data`.

**Buys**

- **Fault isolation** — a wedged worker takes 1/N of the panels, not all of them. This is the real
  prize and the thing the question was actually about.
- CPU parallelism across the 8 cores available.

**The number that matters:** the app measured **0.12% CPU** with 6 panels, and a full allowlist
rebuild is ~31 ms of computation. There is no CPU shortage to parallelise. Every stall this design
would contain is a *single long operation*, and each of those already has a cheaper, specific
answer in place: the 4 MB frame cap, backpressure, and the 50 ms regex deadline.

---

## 5. Recommendation

**Do not build it yet — build the measurement that says when to.**

The honest position is that clustering solves a throughput problem this app does not have, at the
cost of distributing its hardest invariants. But "not yet" should be a threshold, not a feeling.

**Step 1 (small, do this first).** Publish event-loop lag. `perf_hooks.monitorEventLoopDelay()`
costs effectively nothing and turns the whole question into a number: if p99 loop delay stays in
single-digit milliseconds, clustering is unjustifiable; if it climbs past ~100 ms under real load,
the case makes itself. Put it on the console and in the MQTT sensors, where a month of history
will answer this better than any argument.

**Step 2, only if step 1 says so.** Sticky-by-IP cluster as in section 3, starting at N=2, with
`workers: 1` as the default so nobody gets it by accident.

**Step 3, only if the fleet grows past a few dozen panels.** Revisit hashing the resolved client
IP so it survives a reverse proxy — relevant at the ~49-panel scale reported upstream, where
deflate CPU across many connections is the plausible first real bottleneck.

Explicitly rejected: `worker_threads` for `extractEntities` (measured a net loss — 27 ms of
blocking clone to move 22 ms of work), and shared memory in any form, because Node cannot do it
across processes without a native dependency this project will not take.
