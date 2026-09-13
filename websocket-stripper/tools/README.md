# tools/

Development utilities. None of these ship in the app image — the Dockerfile copies an
explicit file list, and nothing here is on it.

## `bench-dashboard-load.mjs`

Measures how long a dashboard actually takes to become usable, trimmed versus untrimmed, at a
throttled connection speed.

**Why this exists rather than the app's own timings.** The stats panel reports
`msToEntityData` and `initialDrainMs` per connection. Those are useful diagnostics — they are
the only view of a native companion-app socket — but they are *not* a benchmark, and the panel
says so:

- `msToEntityData` is dominated by how long the **frontend** takes to get around to subscribing
  (auth handshake, JavaScript parse), not by moving the payload. Measured on a live instance, a
  LAN wall panel took 671 ms for 1.5 KB while a phone on 5G took 207 ms for 215 KB.
- `initialDrainMs` measures handoff to the kernel socket buffer, not receipt by the device. A
  215 KB payload "drained" in 6 ms over cellular, which no cellular link can actually do.

So this measures from outside, in a real browser, where "the dashboard is up" is an observable
event: the first `<ha-card>` to exist anywhere in the page's shadow DOM.

**The A/B needs no configuration change.** Point it at the stripper's port for the trimmed run
and at Home Assistant's own port for the untrimmed one. Same dashboard, same browser, same
throttle, same machine — only the path differs. That is deliberate: toggling `strip_entities`
off on a live instance degrades every panel in the house while the benchmark runs.

### Running it

```bash
npm install puppeteer-core          # deliberately NOT a package.json dependency
HA_TOKEN="<long-lived-token>" \
  HA_HOST=10.2.3.6 \
  DASH=dashboard-test \
  RUNS=3 \
  node tools/bench-dashboard-load.mjs
```

Create the token in Home Assistant under **Profile → Security → Long-lived access tokens**. It
is seeded into `localStorage` as `hassTokens` before any HA code runs, which is the same trick a
kiosk uses to skip the login screen — so the run measures loading rather than typing a password.

If a run reports `login screen (token rejected)`, the token is wrong or expired; that is
reported distinctly from a slow render so the two are never confused.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HA_TOKEN` | *(required)* | Long-lived access token |
| `HA_HOST` | `127.0.0.1` | Host running both the stripper and HA |
| `DASH` | `dashboard-test` | Dashboard `url_path` to load |
| `RUNS` | `3` | Runs per profile per side; the **median** is reported |
| `PROFILES` | `4G,weak cell,no limit` | Which throttle profiles to run |
| `CHROME` | macOS Chrome path | Edit the constant for other platforms |

Ports are the two constants in the script's run loop (`9123` trimmed, `8123` untrimmed).

### A note on profiles

Chrome's own "Slow 3G" preset (400 kbps) is **not** useful here and is deliberately not offered.
Home Assistant's frontend bundle is ~2.3 MB on its own, so at 400 kbps every run spends ~46
seconds before a single entity moves, and the untrimmed side times out before it can be compared.
That measures the profile, not the app. `weak cell` (1.5 Mbps / 150 ms) is a slow link that
still completes.

### Reading the output

Per run it prints wall-clock time to first card, websocket bytes received, and HTTP bytes
received. Medians are printed at the end — median rather than mean, so one stalled run does not
move the headline.
