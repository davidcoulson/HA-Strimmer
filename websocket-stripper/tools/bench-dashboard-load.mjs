// Trimmed-vs-untrimmed dashboard load, at a published throttle profile.
//
// The add-on's own connection timings turned out to be diagnostics rather than a benchmark:
// `msToEntityData` is dominated by how long the frontend takes to get around to subscribing,
// and `initialDrainMs` measures handoff to the kernel socket buffer rather than receipt by the
// device. So this measures from OUTSIDE, in a real browser, where "the dashboard is up" is an
// observable fact rather than an inference.
//
// The A/B needs no configuration change on the live instance, which is the point: port 9123 is
// the stripper (trimmed) and 8123 is Home Assistant itself (untrimmed). Same dashboard, same
// browser, same throttle, same machine — only the path differs.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HOST = process.env.HA_HOST || '127.0.0.1';
const TOKEN = process.env.HA_TOKEN;
const DASH = process.env.DASH || 'dashboard-test';
const RUNS = Number(process.env.RUNS || 3);

if (!TOKEN) { console.error('HA_TOKEN is required'); process.exit(1); }

// Published profiles, so the numbers can be reproduced by someone else rather than taken on
// trust. Chrome DevTools' own presets, plus a 5G figure from a real measurement.
const PROFILES = {
  '4G':        { downloadThroughput: 9000e3 / 8, uploadThroughput: 9000e3 / 8, latency: 40 },
  // A weak-but-real cellular link. NOT Chrome's "Slow 3G" (400kbps): the frontend bundle alone
  // is ~2.3MB, so at 400kbps every run spends ~46s before an entity moves and the untrimmed side
  // times out before it can be compared. That measures the profile, not the add-on.
  'weak cell': { downloadThroughput: 1500e3 / 8, uploadThroughput: 750e3 / 8,  latency: 150 },
  'no limit':  { downloadThroughput: -1,         uploadThroughput: -1,         latency: 0 },
};

// The dashboard lives behind several layers of shadow DOM, so a plain querySelector never sees
// it. Walk open shadow roots until an <ha-card> actually exists — that is the first moment a
// person would say the dashboard is up.
const WAIT_FOR_CARD = `
  new Promise((resolve) => {
    const t0 = performance.now();
    const deadline = t0 + 180000;
    const find = (root) => {
      if (!root) return null;
      if (root.querySelector && root.querySelector('ha-card')) return root.querySelector('ha-card');
      const walk = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of walk) {
        if (el.shadowRoot) { const hit = find(el.shadowRoot); if (hit) return hit; }
      }
      return null;
    };
    const tick = () => {
      if (find(document)) return resolve(performance.now());
      if (performance.now() > deadline) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  })
`;

async function once(profileName, port, label) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=DialMediaRouteProvider'],
  });
  try {
    const page = await browser.newPage();
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');

    // Count what actually crosses the link, split by transport. The websocket is where the
    // entity payload lives, so it is the half that trimming changes.
    let httpBytes = 0, wsBytes = 0;
    cdp.on('Network.loadingFinished', (e) => { httpBytes += e.encodedDataLength || 0; });
    cdp.on('Network.webSocketFrameReceived', (e) => { wsBytes += e.response?.payloadData?.length || 0; });

    const base = `http://${HOST}:${port}`;
    // Seed the session before any HA code runs. A long-lived token in `hassTokens` is how a
    // kiosk skips the login screen, and it keeps the measurement about loading rather than
    // about typing a password.
    await page.evaluateOnNewDocument((tok, url) => {
      localStorage.setItem('hassTokens', JSON.stringify({
        access_token: tok, token_type: 'Bearer', expires_in: 315360000,
        hassUrl: url, clientId: null, expires: Date.now() + 315360000000, refresh_token: '',
      }));
    }, TOKEN, base);

    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, ...PROFILES[profileName],
    });

    const t0 = Date.now();
    await page.goto(`${base}/${DASH}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    // HA bounces through /auth/authorize if the seeded token is not accepted, which destroys
    // the execution context mid-evaluate. Retry once so a genuine redirect is measured rather
    // than reported as a crash; a second failure means we never got logged in at all.
    // HA can bounce through more than one navigation on a slow link (auth, a reload after a
    // websocket give-up), and each one destroys the execution context mid-evaluate. Retry a few
    // times rather than reporting the browser's own redirect as a failed measurement.
    let cardAt = null;
    for (let attempt = 0; attempt < 4 && cardAt == null; attempt++) {
      try { cardAt = await page.evaluate(WAIT_FOR_CARD); }
      catch (e) {
        if (!/context was destroyed|Target closed/i.test(e.message) || attempt === 3) throw e;
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
    }
    const wall = Date.now() - t0;
    const url = page.url();

    return {
      label, profile: profileName, ok: cardAt != null, ms: wall,
      httpKB: Math.round(httpBytes / 1024), wsKB: Math.round(wsBytes / 1024),
      // Surfaced so a failure is self-diagnosing: landing on /auth/ means the token was
      // rejected, which is a very different problem from a dashboard that renders slowly.
      endedOn: /\/auth\//.test(url) ? 'login screen (token rejected)' : url.replace(base, ''),
    };
  } finally {
    await browser.close();
  }
}

const results = [];
for (const profile of (process.env.PROFILES || '4G,weak cell,no limit').split(',')) {
  for (const [label, port] of [['trimmed (stripper)', 9123], ['untrimmed (HA direct)', 8123]]) {
    for (let i = 0; i < RUNS; i++) {
      try {
        const r = await once(profile.trim(), port, label);
        results.push(r);
        console.log(`${r.profile.padEnd(10)} ${r.label.padEnd(22)} run${i + 1}  ${r.ok ? String(r.ms).padStart(6) + 'ms' : '  FAILED'}  ws=${String(r.wsKB).padStart(5)}KB  http=${String(r.httpKB).padStart(5)}KB  ${r.ok ? "" : "-> " + r.endedOn}`);
      } catch (e) {
        console.log(`${profile.padEnd(10)} ${label.padEnd(22)} run${i + 1}  ERROR ${e.message}`);
      }
    }
  }
}

// Median, not mean: one stalled run should not move the headline.
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
console.log('\n=== medians ===');
for (const profile of [...new Set(results.map((r) => r.profile))]) {
  for (const label of [...new Set(results.map((r) => r.label))]) {
    const rs = results.filter((r) => r.profile === profile && r.label === label && r.ok);
    if (!rs.length) { console.log(`${profile.padEnd(10)} ${label.padEnd(22)} no successful runs`); continue; }
    console.log(`${profile.padEnd(10)} ${label.padEnd(22)} ${String(med(rs.map((r) => r.ms))).padStart(6)}ms   ws=${med(rs.map((r) => r.wsKB))}KB   http=${med(rs.map((r) => r.httpKB))}KB`);
  }
}
console.log('\nJSON:', JSON.stringify(results));
