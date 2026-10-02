/**
 * WebMCP Local Agent - virtual-cursor.js (ISOLATED world)
 *
 * A synthetic cursor drawn over the page while the agent works, so a screen
 * recording shows *what* the agent touched. It is off until content.js enables
 * it, and it never touches the page's own DOM beyond one shadow-hosted element.
 *
 * Tools are opaque (the extension calls `executeTool`, not `click`), so it does
 * not hook a dispatcher: it listens for the events a tool causes — click, input,
 * change, submit — and animates to their target. Isolated-world listeners do
 * see events the page's scripts dispatch.
 *
 * That still leaves tools that change state without any DOM event, so the panel
 * also tells this script when a tool starts and ends (`hud`), and a small banner
 * in the corner names it. That banner is what makes the video readable.
 */
(() => {
  'use strict';

  const FLAG = '__webmcpVirtualCursor__';
  if (globalThis[FLAG]) return;

  const MOVE_MS = 350;
  const PAUSE_MS = 120; // lets the move register in the video before the effect
  const Z = 2147483647;

  let host = null;
  let cursor = null;
  let layer = null;
  let enabled = false;
  let queue = Promise.resolve();
  let pos = { x: 40, y: 40 };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = `all:initial;position:fixed;inset:0;pointer-events:none;z-index:${Z};`;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .layer { position: fixed; inset: 0; pointer-events: none; }
        .cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; opacity: 0;
          transition: transform ${MOVE_MS}ms cubic-bezier(.22,.8,.3,1), opacity .2s; will-change: transform; }
        .cursor svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
        .ripple { position: fixed; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
          border: 2px solid #10B981; background: rgba(16,185,129,.25);
          animation: ripple .6s ease-out forwards; }
        @keyframes ripple { to { transform: scale(4); opacity: 0; } }
        .focus { position: fixed; border: 2px solid #10B981; border-radius: 4px;
          box-shadow: 0 0 0 3px rgba(16,185,129,.3); animation: focus 1.2s ease-out forwards; }
        @keyframes focus { 0%, 70% { opacity: 1; } 100% { opacity: 0; } }
      </style>
      <div class="layer"></div>
      <div class="cursor"><svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg></div>`;
    layer = root.querySelector('.layer');
    cursor = root.querySelector('.cursor');
    (document.documentElement || document).appendChild(host);
    place(pos.x, pos.y);
  }

  function unmount() {
    if (host) host.remove();
    host = cursor = layer = null;
  }

  function place(x, y) {
    pos = { x, y };
    if (cursor) cursor.style.transform = `translate(${x}px, ${y}px)`;
  }

  function centreOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  async function moveTo(el) {
    if (!visible(el)) return null;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { /* noop */ }
    const c = centreOf(el);
    if (cursor) cursor.style.opacity = '1';
    place(c.x, c.y);
    await sleep(MOVE_MS + PAUSE_MS);
    return c;
  }

  function ripple(x, y) {
    if (!layer) return;
    const node = document.createElement('div');
    node.className = 'ripple';
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    layer.appendChild(node);
    setTimeout(() => node.remove(), 700);
  }

  function outline(rect) {
    if (!layer) return;
    const node = document.createElement('div');
    node.className = 'focus';
    node.style.cssText = `left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px;`;
    layer.appendChild(node);
    setTimeout(() => node.remove(), 1300);
  }

  function enqueue(job) {
    queue = queue.then(job).catch(() => {});
  }

  function onClick(event) {
    if (!enabled || !(event.target instanceof Element)) return;
    const target = event.target;
    enqueue(async () => {
      const c = await moveTo(target);
      if (c) ripple(c.x, c.y);
    });
  }

  function onField(event) {
    if (!enabled || !(event.target instanceof Element)) return;
    const target = event.target;
    // One outline per burst of keystrokes, not one per character.
    if (target.__webmcpOutlined && Date.now() - target.__webmcpOutlined < 1000) return;
    target.__webmcpOutlined = Date.now();
    enqueue(async () => {
      const c = await moveTo(target);
      if (c) outline(c.rect);
    });
  }

  function onSubmit(event) {
    if (!enabled || !(event.target instanceof Element)) return;
    const target = event.target;
    enqueue(async () => {
      const c = await moveTo(target);
      if (c) outline(c.rect);
    });
  }

  // --- Tool banner (HUD) ---------------------------------------------------

  const HUD_DONE_MS = 1500;
  const HUD_FAIL_MS = 3000;
  const HUD_STALE_MS = 60000; // an 'end' that never arrives must not leave a card forever

  let hudHost = null;
  let hudList = null;
  const hudCards = new Map(); // call id -> { card, status }

  function mountHud() {
    if (hudHost) return;
    hudHost = document.createElement('div');
    hudHost.setAttribute('aria-hidden', 'true');
    hudHost.style.cssText = 'all:initial;position:fixed;top:0;right:0;pointer-events:none;z-index:' + Z + ';';
    const root = hudHost.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .list { position: fixed; top: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px;
          max-width: 360px; font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .card { background: rgba(17,24,39,.92); color: #fff; border: 1px solid rgba(255,255,255,.15);
          border-left: 4px solid #6366F1; border-radius: 8px; padding: 10px 14px;
          box-shadow: 0 10px 25px -5px rgba(0,0,0,.5); animation: in .25s ease-out;
          transition: opacity .3s, transform .3s, border-color .2s; }
        .card.ok { border-left-color: #10B981; }
        .card.fail { border-left-color: #EF4444; }
        .card.out { opacity: 0; transform: translateY(-10px); }
        .title { display: flex; gap: 6px; align-items: center; font-weight: 600; color: #A5B4FC; word-break: break-all; }
        .ok .title { color: #6EE7B7; }
        .fail .title { color: #FCA5A5; }
        .status { margin-left: auto; font-weight: 400; font-size: 11px; color: #94A3B8; white-space: nowrap; }
        .args { margin-top: 4px; color: #CBD5E1; font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace;
          white-space: pre-wrap; word-break: break-all; }
        @keyframes in { from { transform: translateX(40px); opacity: 0; } to { transform: none; opacity: 1; } }
      </style>
      <div class="list"></div>`;
    hudList = root.querySelector('.list');
    (document.documentElement || document).appendChild(hudHost);
  }

  function removeHudCard(id) {
    const entry = hudCards.get(id);
    if (!entry) return;
    hudCards.delete(id);
    entry.card.classList.add('out');
    setTimeout(() => {
      entry.card.remove();
      if (!hudCards.size && hudHost) {
        hudHost.remove();
        hudHost = hudList = null;
      }
    }, 320);
  }

  /**
   * payload: { phase: 'start', id, tool, args } | { phase: 'end', id, ok }.
   * Everything is set with textContent: tool names and arguments come from the
   * model and the page, and must never be parsed as markup.
   */
  function hud(payload) {
    if (!payload || payload.id === undefined) return;
    const id = String(payload.id);
    if (payload.phase === 'start') {
      mountHud();
      const card = document.createElement('div');
      card.className = 'card';
      const title = document.createElement('div');
      title.className = 'title';
      const name = document.createElement('span');
      name.textContent = '\u26A1 ' + String(payload.tool || 'tool');
      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = 'running\u2026';
      title.append(name, status);
      card.appendChild(title);
      if (payload.args) {
        const args = document.createElement('div');
        args.className = 'args';
        args.textContent = String(payload.args);
        card.appendChild(args);
      }
      hudList.appendChild(card);
      hudCards.set(id, { card, status });
      setTimeout(() => removeHudCard(id), HUD_STALE_MS);
      return;
    }
    if (payload.phase === 'end') {
      const entry = hudCards.get(id);
      if (!entry) return;
      const ok = Boolean(payload.ok);
      entry.card.classList.add(ok ? 'ok' : 'fail');
      entry.status.textContent = ok ? '\u2713 done' : '\u2717 failed';
      setTimeout(() => removeHudCard(id), ok ? HUD_DONE_MS : HUD_FAIL_MS);
    }
  }

  function setEnabled(on) {
    on = Boolean(on);
    if (on === enabled) return;
    enabled = on;
    const method = on ? 'addEventListener' : 'removeEventListener';
    // Capture: see the event even if the page stops its propagation.
    window[method]('click', onClick, true);
    window[method]('input', onField, true);
    window[method]('change', onField, true);
    window[method]('submit', onSubmit, true);
    if (on) mount();
    else unmount();
  }

  globalThis[FLAG] = { setEnabled, hud };
})();
