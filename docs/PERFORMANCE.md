# Performance: measurements and methodology

Every number in this document was measured against a live Home Assistant instance with **9,593
entities**. Nothing here is modelled, extrapolated, or estimated. Where a measurement turned out
to be invalid it is still recorded, with the reason — a discarded result is part of the record.

- [1. What is measured, and why](#1-what-is-measured-and-why)
- [2. Method](#2-method)
- [3. Results](#3-results)
- [4. Validity checks](#4-validity-checks)
- [5. A measurement that was wrong](#5-a-measurement-that-was-wrong)
- [6. An invalid profile](#6-an-invalid-profile)
- [7. Limitations](#7-limitations)
- [8. Reproducing this](#8-reproducing-this)

---

## 1. What is measured, and why

The question is **"how long until the dashboard is usable"**, not "how many bytes moved". Bytes
are the mechanism; time is the thing a person experiences.

So the measurement is taken from outside, in a real browser, and the stopwatch stops when the
first `<ha-card>` actually exists in the page — the first moment a person would say the dashboard
is up.

### Why not the app's own timings

The app records `msToEntityData` and `initialDrainMs` per connection, and those are **not** used
here. They are useful diagnostics — they are the only view of a native companion-app socket, which
no browser tooling can observe — but they are not a benchmark, for two reasons found by measuring
them:

- `msToEntityData` is dominated by how long the **frontend** takes to get around to subscribing
  (auth handshake, JavaScript parse), not by moving the payload. A LAN wall panel took **671 ms for
  1.5 KB** while a phone on 5G took **207 ms for 215 KB**.
- `initialDrainMs` measures handoff to the kernel socket buffer, not receipt by the device. A
  215 KB payload "drained" in **6 ms** over cellular, which no cellular link can do.

---

## 2. Method

### The A/B needs no configuration change

The comparison is **the app's port against Home Assistant's own port** — `:9123` versus `:8123`
— rather than toggling `trim_entities` on a running instance. Same dashboard, same browser, same
throttle, same machine, one extra hop. This matters practically: toggling the option would degrade
every panel in the house for the duration of the run.

### Instrument

[`strimmer/tools/bench-dashboard-load.mjs`](../strimmer/tools/bench-dashboard-load.mjs),
driving the system Chrome through `puppeteer-core`.

| Step | How |
|---|---|
| Throttle | CDP `Network.emulateNetworkConditions`, applied before navigation |
| Session | A long-lived token seeded into `localStorage` as `hassTokens` before any HA code runs — the same trick a kiosk uses to skip the login screen, so the run measures loading rather than typing |
| Start | `page.goto(...)`, `waitUntil: domcontentloaded` |
| Stop | First `<ha-card>` found by a recursive walk of open shadow roots |
| HTTP bytes | CDP `Network.loadingFinished` → `encodedDataLength` |
| WebSocket bytes | CDP `Network.webSocketFrameReceived` → `response.payloadData.length` |
| Isolation | A fresh browser profile per run |
| Reported | **Median**, so one stalled run cannot move the headline |

A run that fails to log in reports `login screen (token rejected)` distinctly from a slow render,
so the two can never be confused.

### Profiles

| Name | Down | Up | Latency |
|---|---|---|---|
| Weak cell | 1.5 Mbps | 750 kbps | 150 ms |
| 4G | 9 Mbps | 9 Mbps | 40 ms |
| No limit | unthrottled | unthrottled | 0 ms |

---

## 3. Results

### 3.1 Headline

Time to first rendered card. Median of three runs per side, five on LAN.

| Link | Untrimmed | Trimmed | Change | Time saved |
|---|---|---|---|---|
| **Weak cell** (1.5 Mbps) | 47,093 ms | **18,408 ms** | **2.6× faster** | **−28.7 s** |
| **4G** (9 Mbps) | 8,632 ms | **3,261 ms** | **2.6× faster** | **−5.4 s** |
| **Unthrottled LAN** | 661 ms | **429 ms** | **1.5× faster** | −0.2 s |

### 3.2 Every run

| Profile | Side | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Median |
|---|---|---|---|---|---|---|---|
| Weak cell | trimmed | 19,601 | 18,408 | 18,241 | — | — | **18,408** |
| Weak cell | untrimmed | 56,047 | 47,093 | 46,924 | — | — | **47,093** |
| 4G | trimmed | 3,065 | 3,261 | 3,572 | — | — | **3,261** |
| 4G | untrimmed | 8,632 | 9,288 | 8,586 | — | — | **8,632** |
| LAN | trimmed | 412 | 630 | 415 | 429 | 435 | **429** |
| LAN | untrimmed | 474 | 796 | 661 | 586 | 2,028 | **661** |

All times in milliseconds.

### 3.3 Payload

| Profile | Side | WebSocket | HTTP |
|---|---|---|---|
| Weak cell | trimmed | 842–846 KB | 2,286–2,423 KB |
| Weak cell | untrimmed | 6,040–7,638 KB | 2,293–2,374 KB |
| 4G | trimmed | 863–864 KB | 2,279–2,406 KB |
| 4G | untrimmed | 5,857–5,882 KB | 2,294–2,367 KB |
| LAN | trimmed | 844 KB (all five runs) | 2,272–2,538 KB |
| LAN | untrimmed | 5,799–5,801 KB | 2,298–3,136 KB |

**WebSocket payload falls by ~85%** — about 5.8 MB to 850 KB. **HTTP is unchanged**, which is the
control: the app does not trim the frontend bundle.

### 3.4 The ratio is link-independent

Both cellular profiles show the **same 2.6×**. That is not a coincidence — the ratio is set by the
byte counts, which do not change with the link. What the link decides is how many seconds that
ratio is worth: 5 on 4G, 29 on a weak cell.

### 3.5 Proxying the frontend is not a cost

The intuitive objection is that a reverse proxy must slow HTTP down, since every byte passes
through it. Measured directly with `curl` against the same host, it does the opposite:

| Test | HA direct | Through the app |
|---|---|---|
| One 564 KB bundle, mean of 5 | 0.043 s | **0.029 s** |
| 40 sequential requests | 74.7 ms each | **31.3 ms each** |

Identical byte counts both ways (564,016 B). The likely cause is connection reuse to Home
Assistant versus a fresh connection per request.

---

## 4. Validity checks

Three independent checks, all of which the data passes.

**The HTTP column is a control.** The app does not touch the frontend bundle, and it stays flat
across every profile and both sides. A change there would mean the two arms differed in something
other than the intended variable.

**Both cellular results reconcile with the link rate.** At 1.5 Mbps (187.5 KB/s):

| | Bytes | Theoretical | Measured |
|---|---|---|---|
| Untrimmed | 8,349 KB | 44.5 s | 47.1 s |
| Trimmed | 3,130 KB | 16.7 s | 18.4 s |

Both land just above their transfer floor, which is what a real measurement does — and what a
harness artefact would not.

**The LAN runs do not overlap.** In the regression described in §5, the *fastest* trimmed run was
slower than the *slowest* untrimmed one. Clean separation makes the direction trustworthy even at
n=3, independent of the magnitude.

---

## 5. A measurement that was wrong

An earlier version of the LAN result showed the app **2.2× slower** than not using it:

| LAN, on `2026.09.13.16` | Untrimmed | Trimmed |
|---|---|---|
| Median | 932 ms | 2,043 ms |

That was real, and two explanations were proposed and then **disproved by measurement**:

1. *The extra HTTP hop.* Disproved by §3.5 — the app serves the frontend faster than Home
   Assistant does.
2. *Parsing moved into the middle.* Plausible, never isolated, and unnecessary once the real cause
   was found.

The actual cause was a **per-user rule scoped to a dashboard the benchmark never opened**. Every
connection was held while the app resolved the connecting user — to reach a conclusion that
could not change anything. Skipping that lookup when no rule can match took the same load from
**2,043 ms to 429 ms**, and flipped the verdict from 2.2× slower to 1.5× faster.

Two things are worth taking from this. If you use `user_overrides`, **scope them to a dashboard** —
it is a speed feature as much as a correctness one. And a benchmark is worth running even when you
expect it to confirm what you already believe, because this one did the opposite.

---

## 6. An invalid profile

Chrome's own **"Slow 3G" preset (400 kbps)** was run and the results discarded. They are recorded
here because a discarded measurement is still a result.

| Side | Runs |
|---|---|
| trimmed | 84,115 ms / 88,561 ms / 72,991 ms |
| untrimmed | `ERROR` ×3 — execution context destroyed |

Two independent reasons to reject it:

- **The byte counts were unstable** — the trimmed websocket swung 866 → 1,651 KB across runs,
  meaning the page was reconnecting mid-load rather than loading once.
- **The untrimmed side never completed.** Home Assistant's frontend bundle is ~2.3 MB on its own;
  at 400 kbps that is ~46 s before a single entity moves, and the untrimmed payload adds ~117 s
  more. The run timed out and the page navigated, which is a harness failure and not a
  measurement.

At that bitrate the profile measures the profile, not the app. It was replaced with **weak
cell** (1.5 Mbps), which is a genuinely slow link that still completes.

---

## 7. Limitations

Stated plainly, because a benchmark that lists none is hiding some.

- **n = 3** per profile (5 on LAN). Enough for direction; not enough for a tight confidence
  interval on magnitude.
- **One instance, one dashboard.** 9,593 entities, 149 on the dashboard under test. A smaller
  instance has less to trim and will see less benefit.
- **One client.** Headless Chrome on a desktop. A slow wall panel is a *different* bottleneck —
  parsing rather than transfer — and is not covered by these runs.
- **Throttling is simulated**, applied by Chrome rather than by a real radio. It models bandwidth
  and latency, not jitter, packet loss, or handover.
- **The §5 comparison spans two versions** (`.16` and `.17`). Everything else was held constant,
  but it is not a single-variable experiment in the way the profile comparisons are.
- **Cold start only.** Every run uses a fresh browser profile. Warm-cache loads are not measured.

---

## 8. Reproducing this

```bash
cd strimmer
npm install puppeteer-core          # deliberately not a package.json dependency

HA_TOKEN="<long-lived-token>" \
  HA_HOST=<your-ha-host> \
  DASH=<dashboard-url-path> \
  RUNS=3 \
  node tools/bench-dashboard-load.mjs
```

Create the token under **Profile → Security → Long-lived access tokens**.

| Variable | Default | Meaning |
|---|---|---|
| `HA_TOKEN` | *(required)* | Long-lived access token |
| `HA_HOST` | `127.0.0.1` | Host running both the app and Home Assistant |
| `DASH` | `dashboard-test` | Dashboard `url_path` to load |
| `RUNS` | `3` | Runs per profile per side; the median is reported |
| `PROFILES` | `4G,weak cell,no limit` | Which throttle profiles to run |

Ports are the two constants in the script's run loop: `9123` (app) and `8123` (Home Assistant).

The HTTP-hop test in §3.5 needs no token at all:

```bash
ASSET=/frontend_latest/<hashed-bundle>.js     # take one from HA's page source
for port in 8123 9123; do
  for i in 1 2 3 4 5; do
    curl -s -o /dev/null -w "%{time_total}\n" "http://<your-ha-host>:$port$ASSET"
  done
done
```
