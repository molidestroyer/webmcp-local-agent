/**
 * End-to-end run of the extension against Google's hotel-chain WebMCP demo, in headless
 * Chromium, with no real model: e2e/fake-ollama.js plays a scripted tool-calling model on
 * 127.0.0.1:11434 and e2e/webmcp-polyfill.js provides document.modelContext (Chromium builds
 * without native WebMCP). The demo is served from a local build under its real URL, so the
 * catalog rule matches as it would online.
 *
 *   git clone https://github.com/GoogleChromeLabs/webmcp-tools
 *   (cd webmcp-tools/demos/hotel-chain && npm install && npx vite build)
 *   HOTEL_CHAIN_DIST=$PWD/webmcp-tools/demos/hotel-chain/dist node e2e/hotel-chain.js
 *
 * Env: SUBMIT=1 turns on "Submit forms that wait for review"; RECORD=1 records the run
 * (MODE=turn|session); CHAOS=1 presses New mid-turn and closes the recorded tab.
 * Needs Playwright. Output (screenshots, video, .log, model calls) goes to e2e/out/.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const EXT = path.resolve(__dirname, '..');
const DIST = process.env.HOTEL_CHAIN_DIST;
if (!DIST || !fs.existsSync(DIST)) { console.error('Set HOTEL_CHAIN_DIST to the built demo (see the header).'); process.exit(2); }
const OUT = __dirname + '/out';
const CALLS = OUT + '/model-calls.ndjson';
const ID = 'jiadmihhccjnmohgemenocmifipigolh';
const BASE = 'https://googlechromelabs.github.io/webmcp-tools/demos/hotel-chain/';
const RECORD = process.env.RECORD === '1';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const model = require('child_process').spawn(process.execPath, [__dirname + '/fake-ollama.js', CALLS], { stdio: 'inherit' });
  process.on('exit', () => model.kill());
  await new Promise((r) => setTimeout(r, 500));
  const ctx = await chromium.launchPersistentContext(OUT + '/profile', {
    channel: 'chromium', headless: true, acceptDownloads: true, downloadsPath: OUT + '/dl',
    viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      '--auto-accept-this-tab-capture', '--use-fake-ui-for-media-stream', "--auto-select-tab-capture-source-by-title=Hotel Chain",
      "--auto-select-desktop-capture-source=Hotel Chain"],
  });
  await ctx.route(/googleusercontent|googleapis|gstatic/, (r) => r.abort());
  await ctx.route(BASE + '**', (route) => {
    let p = new URL(route.request().url()).pathname.replace('/webmcp-tools/demos/hotel-chain/', '') || 'index.html';
    const file = path.join(DIST, p);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ status: 200, contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await ctx.addInitScript({ path: __dirname + '/webmcp-polyfill.js' });

  // The worker can be listed before its extension APIs are bound: wait for ours, ready.
  let sw = null;
  for (let i = 0; i < 50 && !sw; i++) {
    const found = ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${ID}/`));
    if (found && await found.evaluate(() => Boolean(globalThis.chrome && chrome.storage)).catch(() => false)) sw = found;
    else await new Promise((r) => setTimeout(r, 200));
  }
  if (!sw) throw new Error('The extension service worker never came up.');
  await sw.evaluate(([rec, process_submit, mode]) => chrome.storage.local.set({
    catalogSourceMode: 'demo', selectedModel: 'fake:latest', autoSuggest: false, confirmTools: false,
    showVirtualCursor: true, recordSession: rec, recordMode: mode, submitForms: process_submit,
  }), [RECORD, process.env.SUBMIT === '1', process.env.MODE || 'turn']);

  const demo = await ctx.newPage();
  const pageLogs = [];
  demo.on('console', (m) => pageLogs.push(m.type() + ': ' + m.text()));
  await demo.goto(BASE + '#/book/champs');
  await demo.waitForTimeout(1500);

  const panel = await ctx.newPage();
  panel.on('pageerror', (e) => console.log('PANEL ERROR', String(e)));
  panel.on('console', (m) => { if (/\[(Rec)\]|error/i.test(m.text())) console.log('panel>', m.text()); });
  await panel.addInitScript(() => {
    window.__goals = []; window.__huds = [];
    const q = chrome.tabs.query.bind(chrome.tabs);
    // The panel asks for the active tab of its window; in this harness that is the panel itself.
    chrome.tabs.query = async (info) => {
      if (info && info.active && (info.currentWindow || info.lastFocusedWindow)) {
        return (await q({})).filter((t) => (t.url || '').includes('hotel-chain'));
      }
      return q(info);
    };
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, ...rest) => {
      if (msg && msg.action === 'hud') {
        window.__huds.push(msg.payload);
        if (msg.payload.phase === 'goal') window.__goals.push(msg.payload.text);
      }
      return send(msg, ...rest);
    };
  });
  await panel.goto(`chrome-extension://${ID}/sidepanel.html`);
  await panel.waitForTimeout(2500);
  console.log('model:', await panel.$eval('#model-select', (s) => s.value));
  console.log('tools badge:', await panel.textContent('#tools-badge').catch(() => '?'));
  console.log('catalog chip:', (await panel.textContent('#catalog-active').catch(() => '')).trim().slice(0, 80));

  // QA flow: open the catalog browser, it should start on "This page", pick the E2E prompt.
  await panel.click('#catalog-browse-btn');
  console.log('browser scope:', await panel.textContent('#prompt-browser-scope'));
  console.log('groups:', await panel.$$eval('.prompt-group__title', (n) => n.map((x) => x.textContent)));
  await panel.click('.prompt-item >> nth=0');
  console.log('input starts:', (await panel.inputValue('#input')).slice(0, 60));
  await panel.screenshot({ path: OUT + '/panel-before.png' });
  await panel.click('#send');
  if (process.env.CHAOS === '1') {
    await panel.waitForTimeout(1000);
    const before = await panel.evaluate(() => document.querySelector('#chat').innerText.length);
    await panel.evaluate(() => document.getElementById('chat-new-btn').click());
    console.log('CHAOS new-chat while busy -> status:', await panel.textContent('#status'));
    console.log('CHAOS chat kept its content:', (await panel.evaluate(() => document.querySelector('#chat').innerText.length)) >= before);
    await panel.waitForTimeout(800);
    await demo.close();
    await panel.waitForTimeout(3000);
    console.log('CHAOS after closing the recorded tab -> status:', await panel.textContent('#status'));
    console.log('CHAOS rec button:', await panel.evaluate(() => ({ hidden: document.getElementById('rec-btn').hidden, disabled: document.getElementById('rec-btn').disabled, label: document.getElementById('rec-btn-label').textContent })));
    const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d).map((f) => fs.statSync(path.join(d, f)).size) : [];
    console.log('CHAOS files saved (bytes):', walk(OUT + '/dl'));
    fs.cpSync(OUT + '/dl', OUT + '/kept', { recursive: true });
    await ctx.close();
    return;
  }

  const shots = [];
  for (let i = 0; i < 60; i++) {
    await demo.waitForTimeout(500);
    if (i % 3 === 0) { const f = OUT + `/demo-${String(i).padStart(2, '0')}.png`; await demo.screenshot({ path: f }); shots.push(f); }
    const busy = await panel.evaluate(() => document.querySelector('#send').disabled && !!document.querySelector('.msg--assistant.cursor'));
    const txt = await panel.evaluate(() => document.querySelector('#chat').innerText);
    if (/Total \$1386/.test(txt) && !busy) break;
  }
  await demo.waitForTimeout(1500);
  await demo.screenshot({ path: OUT + '/demo-final.png' });
  await panel.screenshot({ path: OUT + '/panel-after.png', fullPage: true });
  console.log('demo url:', demo.url());
  console.log('demo h1:', await demo.$$eval('h1', (n) => n.map((x) => x.textContent)));
  console.log('goals:', JSON.stringify(await panel.evaluate(() => window.__goals), null, 1));
  const lines = fs.readFileSync(CALLS, 'utf8').trim().split('\n').map(JSON.parse);
  const last = lines[lines.length - 1];
  console.log('rounds sent to the model:', lines.length);
  const booking = String((last.toolResults.find((r) => r[0] === 'complete_booking') || [])[1] || '').replace(/\s+/g, ' ');
  console.log('complete_booking result:', booking);
  const goals = await panel.evaluate(() => window.__goals.filter(Boolean));
  const h1 = await demo.$$eval('h1', (n) => n.map((x) => x.textContent));
  const checks = [
    ['the catalog context reached the model', last.system.includes('hotel-chain demo')],
    ['the goal line changed on every step', new Set(goals).size >= 6],
    ['start_booking is gone once the booking page is up', !last.tools.includes('start_booking')],
    process.env.SUBMIT === '1'
      ? ['the booking went through', h1.includes('Reservation Confirmed') && /"submitted": ?true/.test(booking)]
      : ['the form was filled, not sent, and the result says so', !h1.includes('Reservation Confirmed') && /NOT submitted/.test(booking)],
  ];
  for (const [name, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
  console.log('chat tail:', (await panel.evaluate(() => document.querySelector('#chat').innerText)).slice(-300));
  console.log('page errors:', pageLogs.filter((l) => /^error/.test(l)).slice(0, 5));
  await panel.waitForTimeout(4000);
  const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map((f) => [f, fs.statSync(path.join(d, f)).size]) : [];
  console.log('downloads:', JSON.stringify(walk(OUT + '/dl')), 'status:', await panel.textContent('#status').catch(() => ''));
  fs.cpSync(OUT + '/dl', OUT + '/kept', { recursive: true });
  await ctx.close();
})().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error('RUN FAILED', e); process.exit(1); });
