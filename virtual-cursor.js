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
 * also tells this script when a tool starts and ends (`hud`): a stack of cards in the
 * bottom-right corner names each call, and a goal line at the top says what the agent is
 * after. That is what makes the video readable.
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
  //
  // A stack of cards, newest at the bottom, plus one goal line at the top. A tool that
  // resolves in 3 ms must still be readable in the video, so a card stays up for a minimum
  // time whatever the tool did, and a burst never fills the frame.

  const HUD_MAX_VISIBLE = 4;
  const HUD_MIN_VISIBLE_MS = 2800;
  const HUD_OK_LINGER_MS = 1500;
  const HUD_FAIL_LINGER_MS = 3000;
  const HUD_FADE_MS = 320;
  const HUD_EVICT_FADE_MS = 140; // cards pushed out by a burst leave quickly
  const HUD_STALE_MS = 60000;    // an 'end' that never arrives must not leave a card forever

  /**
   * The timing and capacity rules, with no DOM, so they can be tested. Callers pass `now`.
   * add() returns the ids pushed out by the capacity limit (oldest finished first);
   * finish() returns how many ms the card still has to stay up.
   */
  function createHudStack({
    maxVisible = HUD_MAX_VISIBLE,
    minVisibleMs = HUD_MIN_VISIBLE_MS,
    okLingerMs = HUD_OK_LINGER_MS,
    failLingerMs = HUD_FAIL_LINGER_MS,
  } = {}) {
    const entries = []; // oldest first

    return {
      add(id, now) {
        entries.push({ id, startedAt: now, endedAt: null });
        const evicted = [];
        while (entries.length > maxVisible) {
          let index = entries.findIndex((e) => e.endedAt !== null);
          if (index < 0) index = 0; // all still running: the oldest goes, never the new one
          evicted.push(entries.splice(index, 1)[0].id);
        }
        return evicted;
      },
      finish(id, ok, now) {
        const entry = entries.find((e) => e.id === id);
        if (!entry) return null;
        entry.endedAt = now;
        const linger = ok ? okLingerMs : failLingerMs;
        return Math.max(now + linger, entry.startedAt + minVisibleMs) - now;
      },
      remove(id) {
        const index = entries.findIndex((e) => e.id === id);
        if (index >= 0) entries.splice(index, 1);
        return index >= 0;
      },
      size: () => entries.length,
      ids: () => entries.map((e) => e.id),
    };
  }

  const stack = createHudStack();
  let hudHost = null;
  let hudList = null;
  let hudGoal = null;
  let goalText = '';
  let goalSetAt = 0;
  let goalTimer = null;
  const hudCards = new Map(); // call id -> { card, status, timer }

  function mountHud() {
    if (hudHost) return;
    hudHost = document.createElement('div');
    hudHost.setAttribute('aria-hidden', 'true');
    hudHost.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:' + Z + ';';
    const root = hudHost.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .goal { position: fixed; top: 16px; right: 16px; max-width: 380px; display: none;
          align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px;
          background: rgba(79,70,229,.95); color: #fff; font-weight: 600; font-size: 14px;
          box-shadow: 0 10px 25px -5px rgba(0,0,0,.5); transition: opacity .3s; }
        .goal.on { display: flex; animation: in .25s ease-out; }
        .goal.out { opacity: 0; }
        .goal::before { content: "\\1F3AF"; }
        .list { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column;
          justify-content: flex-end; gap: 8px; max-width: 360px;
          max-height: calc(100vh - 90px); overflow: hidden; } /* never reach the goal line */
        .card { background: rgba(17,24,39,.92); color: #fff; border: 1px solid rgba(255,255,255,.15);
          border-left: 4px solid #6366F1; border-radius: 8px; padding: 10px 14px;
          box-shadow: 0 10px 25px -5px rgba(0,0,0,.5); animation: in .25s ease-out;
          transition: opacity ${HUD_FADE_MS}ms, transform ${HUD_FADE_MS}ms, border-color .2s; }
        .card.ok { border-left-color: #10B981; }
        .card.fail { border-left-color: #EF4444; }
        .card.out { opacity: 0; transform: translateY(-10px); }
        .card.out.fast { transition-duration: ${HUD_EVICT_FADE_MS}ms; }
        .title { display: flex; gap: 6px; align-items: center; font-weight: 600; color: #A5B4FC; word-break: break-all; }
        .ok .title { color: #6EE7B7; }
        .fail .title { color: #FCA5A5; }
        .status { margin-left: auto; font-weight: 400; font-size: 11px; color: #94A3B8; white-space: nowrap; }
        .args { margin-top: 4px; color: #CBD5E1; font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace;
          white-space: pre-wrap; word-break: break-all; }
        @keyframes in { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
      </style>
      <div class="goal"><span class="goal-text"></span></div>
      <div class="list"></div>`;
    hudList = root.querySelector('.list');
    hudGoal = root.querySelector('.goal');
    (document.documentElement || document).appendChild(hudHost);
  }

  function unmountHudIfIdle() {
    if (hudHost && !hudCards.size && !goalText) {
      hudHost.remove();
      hudHost = hudList = hudGoal = null;
    }
  }

  function dropHudCard(id, fast) {
    const entry = hudCards.get(id);
    if (!entry) return;
    hudCards.delete(id);
    stack.remove(id);
    clearTimeout(entry.timer);
    entry.card.classList.add('out');
    if (fast) entry.card.classList.add('fast');
    setTimeout(() => {
      entry.card.remove();
      unmountHudIfIdle();
    }, fast ? HUD_EVICT_FADE_MS : HUD_FADE_MS);
  }

  /** Slides the cards already on screen to their new place instead of jumping. */
  function animateShift(before) {
    for (const [id, entry] of hudCards) {
      const was = before.get(id);
      if (was === undefined) continue;
      const delta = was - entry.card.getBoundingClientRect().top;
      if (!delta) continue;
      entry.card.style.transition = 'none';
      entry.card.style.transform = `translateY(${delta}px)`;
      entry.card.getBoundingClientRect(); // commit the start position
      entry.card.style.transition = '';
      entry.card.style.transform = '';
    }
  }

  function setGoal(text) {
    text = String(text || '').trim();
    if (text === goalText) return;
    clearTimeout(goalTimer);
    if (text) {
      mountHud();
      goalText = text;
      goalSetAt = Date.now();
      hudGoal.querySelector('.goal-text').textContent = text;
      hudGoal.classList.remove('out');
      hudGoal.classList.add('on');
      return;
    }
    // Cleared: let the last goal be read for its minimum time first.
    const wait = Math.max(0, goalSetAt + HUD_MIN_VISIBLE_MS - Date.now());
    goalTimer = setTimeout(() => {
      goalText = '';
      if (hudGoal) hudGoal.classList.add('out');
      setTimeout(() => {
        if (hudGoal && !goalText) hudGoal.classList.remove('on');
        unmountHudIfIdle();
      }, HUD_FADE_MS);
    }, wait);
  }

  /**
   * payload: { phase: 'start', id, tool, args } | { phase: 'end', id, ok } | { phase: 'goal', text }.
   * Everything is set with textContent: tool names, arguments and goals come from the
   * model and the page, and must never be parsed as markup.
   */
  function hud(payload) {
    if (!payload) return;
    if (payload.phase === 'goal') {
      setGoal(payload.text);
      return;
    }
    if (payload.id === undefined) return;
    const id = String(payload.id);
    if (payload.phase === 'start') {
      mountHud();
      const before = new Map();
      for (const [key, entry] of hudCards) before.set(key, entry.card.getBoundingClientRect().top);
      const card = document.createElement('div');
      card.className = 'card';
      const title = document.createElement('div');
      title.className = 'title';
      const name = document.createElement('span');
      name.textContent = '⚡ ' + String(payload.tool || 'tool');
      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = 'running…';
      title.append(name, status);
      card.appendChild(title);
      if (payload.args) {
        const args = document.createElement('div');
        args.className = 'args';
        args.textContent = String(payload.args);
        card.appendChild(args);
      }
      hudList.appendChild(card);
      const entry = { card, status, timer: setTimeout(() => dropHudCard(id), HUD_STALE_MS) };
      hudCards.set(id, entry);
      for (const gone of stack.add(id, Date.now())) dropHudCard(gone, true);
      animateShift(before);
      return;
    }
    if (payload.phase === 'end') {
      const entry = hudCards.get(id);
      if (!entry) return;
      const ok = Boolean(payload.ok);
      entry.card.classList.add(ok ? 'ok' : 'fail');
      entry.status.textContent = ok ? '✓ done' : '✗ failed';
      const stayMs = stack.finish(id, ok, Date.now());
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => dropHudCard(id), stayMs === null ? 0 : stayMs);
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

  globalThis[FLAG] = { setEnabled, hud, createHudStack };
  if (typeof module === 'object' && module.exports) module.exports = { createHudStack };
})();
