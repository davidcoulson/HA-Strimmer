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

---

## 6. Would Rust or Go be better?

The same question one layer down, and it deserves a straight answer: **yes, both would give better
threading, and no, that is not a reason to rewrite this.**

### Where they genuinely win

**The catastrophic-regex class stops existing.** Go's `regexp` is RE2 and Rust's `regex` crate is
its descendant; both match in time linear in the input, because neither backtracks. The pattern
that cost this app 5.4 seconds on 27 characters —

```
/^(a|a)+$/   node: 5364 ms      RE2 / rust regex: linear, no backtracking
```

— is simply not expressible as a denial of service against them. Everything built to contain it
(`looksCatastrophic`, the `node:vm` deadline, the memo, the kill-list) would delete itself. That
is the most elegant argument for a move and the only one that removes code rather than adding it.

**Real parallelism.** Go's goroutines and Rust's tokio both schedule across cores, so a task that
blocks holds up one worker of N rather than everything. Every stall discussed in this document
becomes a local problem.

**Memory.** Measured now: **77 MB RSS**. Go would plausibly be 30–50 MB, Rust 15–30 MB.

### Where Node is the better fit for *this* app

**The domain is JSON manipulation of someone else's schema.** The whole proxy is
`transform(msg)` over Home Assistant's websocket messages — a schema HA changes without notice,
full of optional fields, two-letter keys (`a`, `c`, `ei`, `di`) and payloads that are sometimes an
object and sometimes an array. JavaScript's dynamic objects are a genuinely good match. In Rust
this is `serde_json::Value` and a lot of ceremony, or typed structs for a surface that keeps
moving; Go sits in between with `map[string]any`.

**The value in this repo is not the code.** It is CLAUDE.md: the X-Forwarded-For chain rules, the
cache signature, the auth-gate ordering, batched-frame handling, backpressure semantics, the
resource-trim heuristics. Every one of those was learned from a production failure. A rewrite
inherits the list only if someone ports it deliberately, and the failure mode is re-learning them
the same way they were learned the first time.

**The console is a web page regardless.**

### The measurements that decide it

| | measured |
| --- | --- |
| CPU | 0.12–3.85% |
| Event-loop delay p99 | 6.8 ms |
| Worst stall since boot | 46 ms (the boot allowlist build) |
| RSS | 77 MB |

Threading is not the binding constraint. A runtime that threads better would be solving a problem
this app does not have, at the cost of the one asset it does.

### Honest caveat

Asked as *"what would you start with today, knowing what this app does?"* the answer is different
— **Go** would be a strong choice: RE2 by default, goroutines that suit one-per-connection
naturally, `httputil.ReverseProxy` in the standard library, and `encoding/json` that handles
dynamic shapes without a fight. That is a real argument, and it is an argument about a greenfield
project, not about this one.

### What would change the answer

- Event-loop p99 climbing past ~100 ms under normal load (now measured continuously — section 5).
- A fleet where deflate CPU across connections actually saturates a core.
- A second pathological input class appearing that cannot be bounded as cheaply as the regex was.

Absent those, the sunk knowledge outweighs the runtime.
