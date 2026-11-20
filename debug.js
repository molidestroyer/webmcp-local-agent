/**
 * WebMCP Local Agent - debug.js
 *
 * Standalone Conversation Debug Dashboard: token breakdown, WebMCP optimization
 * signals, page console errors, linked video recordings + session logs, and
 * 1-click Markdown export for external AI agents.
 */
'use strict';

(function () {
  const DR = globalThis.__WebMCPDebugReport;
  const AT = globalThis.__WebMCPAgentTrace;
  const Folder = globalThis.__WebMCPRecordingsFolder;

  const els = {
    subtitle: document.getElementById('dbg-subtitle'),
    sessionSelect: document.getElementById('session-select'),
    refreshBtn: document.getElementById('refresh-btn'),
    copyAllBtn: document.getElementById('copy-all-btn'),
    downloadMdBtn: document.getElementById('download-md-btn'),
    kpiTokens: document.getElementById('kpi-tokens'),
    kpiTokensSub: document.getElementById('kpi-tokens-sub'),
    kpiTurns: document.getElementById('kpi-turns'),
    kpiTurnsSub: document.getElementById('kpi-turns-sub'),
    kpiTools: document.getElementById('kpi-tools'),
    kpiToolsSub: document.getElementById('kpi-tools-sub'),
    kpiErrors: document.getElementById('kpi-errors'),
    kpiErrorsSub: document.getElementById('kpi-errors-sub'),
    kpiRecs: document.getElementById('kpi-recs'),
    kpiRecsSub: document.getElementById('kpi-recs-sub'),
    tokenBar: document.getElementById('token-bar'),
    tokenLegend: document.getElementById('token-legend'),
    hintsList: document.getElementById('optimization-hints'),
    turnsList: document.getElementById('turns-list'),
    toolsTableWrap: document.getElementById('tools-table-wrap'),
    pageConsoleList: document.getElementById('page-console-list'),
    extLogsPre: document.getElementById('ext-logs-pre'),
    showAllRecs: document.getElementById('show-all-recs'),
    grantFolderBtn: document.getElementById('grant-folder-btn'),
    recList: document.getElementById('rec-list'),
    recViewerEmpty: document.getElementById('rec-viewer-empty'),
    recPlayerBox: document.getElementById('rec-player-box'),
    recPlayerTitle: document.getElementById('rec-player-title'),
    recPlayerMeta: document.getElementById('rec-player-meta'),
    recShowBtn: document.getElementById('rec-show-btn'),
    recOpenBtn: document.getElementById('rec-open-btn'),
    recCopyLogBtn: document.getElementById('rec-copy-log-btn'),
    recVideo: document.getElementById('rec-video'),
    recVideoNote: document.getElementById('rec-video-note'),
    recLogPre: document.getElementById('rec-log-pre'),
    transcriptList: document.getElementById('transcript-list'),
    copyTokensBtn: document.getElementById('copy-tokens-btn'),
    copyTraceBtn: document.getElementById('copy-trace-btn'),
    copyToolsBtn: document.getElementById('copy-tools-btn'),
    copyConsoleBtn: document.getElementById('copy-console-btn'),
    copyExtLogsBtn: document.getElementById('copy-extlogs-btn'),
    copyTranscriptBtn: document.getElementById('copy-transcript-btn'),
  };

  let store = {
    chatSessions: [],
    agentTrace: [],
    recordingsIndex: [],
    pageConsoleHistory: [],
    extensionLogs: [],
  };
  let selectedSessionId = new URLSearchParams(location.search).get('sessionId') || '';
  let selectedRecId = null;
  let activeVideoUrl = null;
  let folderHandle = null;

  function flashCopied(btn, originalText) {
    if (!btn) return;
    btn.textContent = '✔ Copied!';
    setTimeout(() => { btn.textContent = originalText; }, 1400);
  }

  async function copyText(text, btn) {
    const orig = btn ? btn.textContent : '';
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(btn, orig);
    } catch (_) {
      /* clipboard blocked */
    }
  }

  function currentViewData() {
    const session = store.chatSessions.find((s) => s.id === selectedSessionId) || null;
    const filterBySession = Boolean(selectedSessionId && selectedSessionId !== '__all__');

    const turns = filterBySession
      ? store.agentTrace.filter((t) => t.sessionId === selectedSessionId)
      : store.agentTrace;

    const consoleLogs = filterBySession
      ? store.pageConsoleHistory.filter((e) => e.sessionId === selectedSessionId)
      : store.pageConsoleHistory;

    const recordings = (filterBySession && !(els.showAllRecs && els.showAllRecs.checked))
      ? store.recordingsIndex.filter((r) => r.sessionId === selectedSessionId)
      : store.recordingsIndex;

    const toolCalls = [];
    for (const t of turns) {
      for (const tc of (t.toolCalls || [])) {
        toolCalls.push({ turn: t.n, ...tc });
      }
    }

    return { session, turns, consoleLogs, recordings, toolCalls };
  }

  function renderSessionSelect() {
    if (!els.sessionSelect) return;
    const prev = selectedSessionId;
    els.sessionSelect.textContent = '';

    const allOpt = document.createElement('option');
    allOpt.value = '__all__';
    allOpt.textContent = `All Conversations (${store.agentTrace.length} turns · ${store.recordingsIndex.length} recordings)`;
    els.sessionSelect.appendChild(allOpt);

    const ids = new Set(store.chatSessions.map((s) => s.id));
    for (const s of store.chatSessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      const domain = s.domain ? `[${s.domain}] ` : '';
      opt.textContent = `${domain}${s.title || s.id}`;
      els.sessionSelect.appendChild(opt);
    }
    if (prev && prev !== '__all__' && !ids.has(prev)) {
      const unsaved = document.createElement('option');
      unsaved.value = prev;
      unsaved.textContent = `Current Thread (${prev})`;
      els.sessionSelect.appendChild(unsaved);
    }

    if (prev && Array.from(els.sessionSelect.options).some((o) => o.value === prev)) {
      els.sessionSelect.value = prev;
    } else if (store.chatSessions.length) {
      selectedSessionId = store.chatSessions[0].id;
      els.sessionSelect.value = selectedSessionId;
    } else {
      selectedSessionId = '__all__';
      els.sessionSelect.value = '__all__';
    }
  }

  function renderKpisAndTokens(data) {
    const { summary, drivers, hints } = DR.topTokenDrivers(data.turns);
    const { session, consoleLogs, recordings, toolCalls } = data;

    if (els.subtitle) {
      els.subtitle.textContent = session
        ? `${session.domain || 'local'} · ${session.url || ''}`
        : 'Showing telemetry across all tracked turns';
    }

    els.kpiTokens.textContent = summary.hasUsage
      ? `${DR.formatCompact(summary.input + summary.output)}`
      : `~${DR.formatCompact(summary.partsTotal)}`;
    els.kpiTokensSub.textContent = summary.hasUsage
      ? `in ${DR.formatCompact(summary.input)}${summary.cached ? ` (${DR.formatCompact(summary.cached)} cached)` : ''} · out ${DR.formatCompact(summary.output)}`
      : 'Estimated (~4 chars/token)';

    els.kpiTurns.textContent = `${summary.turnsCount} / ${summary.roundsCount}`;
    els.kpiTurnsSub.textContent = `${(summary.ms / 1000).toFixed(1)}s model time · ${summary.nudges} nudge(s)`;

    const failedTools = toolCalls.filter((t) => !t.ok).length;
    els.kpiTools.textContent = String(toolCalls.length || summary.tools);
    els.kpiToolsSub.textContent = failedTools ? `${failedTools} failed / cancelled` : 'All succeeded';

    const errs = consoleLogs.filter((e) => e.level !== 'warn').length;
    const warns = consoleLogs.filter((e) => e.level === 'warn').length;
    els.kpiErrors.textContent = String(errs || summary.pageErrors);
    els.kpiErrorsSub.textContent = `${warns} warning(s)`;

    els.kpiRecs.textContent = String(recordings.length);
    const totalBytes = recordings.reduce((acc, r) => acc + (r.sizeBytes || 0), 0);
    els.kpiRecsSub.textContent = totalBytes ? `${Math.round(totalBytes / 1024)} KB total` : 'No video files linked';

    // Stacked bar
    els.tokenBar.textContent = '';
    els.tokenLegend.textContent = '';
    const colors = { sys: '#64748b', cat: '#8b5cf6', tools: '#3b82f6', hist: '#10b981', res: '#f59e0b' };
    for (const d of drivers) {
      if (d.tokens > 0 && summary.partsTotal > 0) {
        const seg = document.createElement('div');
        seg.className = `token-seg token-seg--${d.key}`;
        seg.style.width = `${Math.max(1, (d.tokens / summary.partsTotal) * 100)}%`;
        seg.title = `${d.label}: ~${DR.formatCompact(d.tokens)} tokens (${d.pct}%)`;
        els.tokenBar.appendChild(seg);
      }
      const item = document.createElement('span');
      item.className = 'legend-item';
      const dot = document.createElement('span');
      dot.className = 'legend-dot';
      dot.style.background = colors[d.key] || '#888';
      item.append(dot, document.createTextNode(`${d.label}: ~${DR.formatCompact(d.tokens)} (${d.pct}%)`));
      els.tokenLegend.appendChild(item);
    }

    els.hintsList.textContent = '';
    for (const h of hints) {
      const li = document.createElement('li');
      li.textContent = h;
      els.hintsList.appendChild(li);
    }
  }

  function renderTurns(data) {
    els.turnsList.textContent = '';
    if (!data.turns.length) {
      const empty = document.createElement('div');
      empty.className = 'dbg-empty';
      empty.textContent = 'No turns recorded for this selection yet.';
      els.turnsList.appendChild(empty);
      return;
    }

    for (const t of data.turns) {
      const card = document.createElement('div');
      card.className = 'turn-card';

      const head = document.createElement('div');
      head.className = 'turn-card__head';
      const goal = document.createElement('div');
      goal.className = 'turn-card__goal';
      goal.textContent = `#${t.n || '?'} · ${t.goal || t.request || '(no goal)'}`;
      const meta = document.createElement('div');
      meta.className = 'turn-card__meta';
      meta.textContent = `${t.at || ''} · ${t.model || ''} · ${t.verdict || t.end || '?'} · ${t.nudges || 0} nudge(s)`;
      head.append(goal, meta);
      card.appendChild(head);

      for (let i = 0; i < (t.rounds || []).length; i++) {
        const r = t.rounds[i];
        const row = document.createElement('div');
        row.className = 'round-row';
        const c1 = document.createElement('span');
        c1.textContent = `r${i + 1}${r.nudge ? '*' : ''} ${(r.ms / 1000).toFixed(1)}s`;
        const c2 = document.createElement('span');
        c2.textContent = r.usage
          ? `in ${DR.formatCompact(r.usage.input)} out ${DR.formatCompact(r.usage.output)}`
          : 'usage ?';
        const c3 = document.createElement('span');
        const p = r.parts || {};
        c3.textContent = `[~sys ${DR.formatCompact(p.sys)} cat ${DR.formatCompact(p.cat)} tools ${DR.formatCompact(p.tools)} hist ${DR.formatCompact(p.hist)} res ${DR.formatCompact(p.res)}] -> ${r.reply || ''}`;
        row.append(c1, c2, c3);
        card.appendChild(row);
      }
      els.turnsList.appendChild(card);
    }
  }

  function renderToolCalls(data) {
    els.toolsTableWrap.textContent = '';
    if (!data.toolCalls.length) {
      const empty = document.createElement('div');
      empty.className = 'dbg-empty';
      empty.textContent = 'No WebMCP tool calls recorded for this selection.';
      els.toolsTableWrap.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'dbg-table';
    table.innerHTML = '<thead><tr><th>Turn</th><th>Tool</th><th>Status</th><th>Time</th><th>Arguments</th><th>Result</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const tc of data.toolCalls) {
      const tr = document.createElement('tr');
      const tdTurn = document.createElement('td');
      tdTurn.textContent = '#' + (tc.turn || '?');

      const tdName = document.createElement('td');
      const codeName = document.createElement('code');
      codeName.textContent = tc.name;
      tdName.appendChild(codeName);

      const tdStatus = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = 'pill ' + (tc.ok ? 'pill--ok' : 'pill--err');
      pill.textContent = tc.note || (tc.ok ? 'OK' : 'FAIL');
      tdStatus.appendChild(pill);

      const tdMs = document.createElement('td');
      tdMs.textContent = typeof tc.ms === 'number' ? `${tc.ms} ms` : '—';

      const tdArgs = document.createElement('td');
      const codeArgs = document.createElement('code');
      try { codeArgs.textContent = tc.args !== undefined ? JSON.stringify(tc.args) : '{}'; } catch (_) { codeArgs.textContent = String(tc.args); }
      tdArgs.appendChild(codeArgs);

      const tdRes = document.createElement('td');
      const codeRes = document.createElement('code');
      const out = String(tc.output || '');
      codeRes.textContent = out.length > 260 ? out.slice(0, 260) + `… (${out.length} chars)` : out;
      codeRes.title = out;
      tdRes.appendChild(codeRes);

      tr.append(tdTurn, tdName, tdStatus, tdMs, tdArgs, tdRes);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    els.toolsTableWrap.appendChild(table);
  }

  function renderConsoleAndLogs(data) {
    els.pageConsoleList.textContent = '';
    if (!data.consoleLogs.length) {
      const empty = document.createElement('div');
      empty.className = 'dbg-empty';
      empty.textContent = 'No page console errors or warnings captured.';
      els.pageConsoleList.appendChild(empty);
    } else {
      for (const entry of data.consoleLogs) {
        const div = document.createElement('div');
        div.className = 'console-item ' + (entry.level === 'warn' ? 'console-item--warn' : 'console-item--error');
        const ts = entry.at ? new Date(entry.at).toLocaleTimeString() + ' ' : '';
        div.textContent = `${ts}[${(entry.level || 'error').toUpperCase()}] ${entry.text || ''}`;
        els.pageConsoleList.appendChild(div);
      }
    }

    els.extLogsPre.textContent = store.extensionLogs.length
      ? store.extensionLogs.join('\n')
      : '(No extension diagnostic logs cached yet.)';
  }

  async function selectRecording(rec) {
    selectedRecId = rec ? rec.id : null;
    if (activeVideoUrl) {
      URL.revokeObjectURL(activeVideoUrl);
      activeVideoUrl = null;
    }
    if (!rec) {
      els.recViewerEmpty.hidden = false;
      els.recPlayerBox.hidden = true;
      return;
    }
    els.recViewerEmpty.hidden = true;
    els.recPlayerBox.hidden = false;
    els.recPlayerTitle.textContent = `${rec.stem}.webm`;
    const kb = rec.sizeBytes ? `${Math.round(rec.sizeBytes / 1024)} KB` : 'size ?';
    const dur = rec.durationMs ? `${(rec.durationMs / 1000).toFixed(1)}s` : '';
    els.recPlayerMeta.textContent = `${new Date(rec.startedAt).toLocaleString()} · ${rec.storage} · ${kb}${dur ? ' · ' + dur : ''}`;

    els.recShowBtn.hidden = !(rec.storage === 'downloads' && typeof rec.downloadId === 'number');
    els.recOpenBtn.hidden = !(rec.storage === 'downloads' && typeof rec.downloadId === 'number');
    els.recShowBtn.onclick = () => chrome.downloads.show(rec.downloadId);
    els.recOpenBtn.onclick = () => chrome.downloads.open(rec.downloadId);

    els.recVideo.hidden = true;
    els.recVideo.removeAttribute('src');
    els.recVideoNote.hidden = true;
    let logContent = rec.logText || '';

    if (rec.storage === 'folder' && Folder) {
      folderHandle = folderHandle || await Folder.load().catch(() => null);
      if (folderHandle && (await folderHandle.queryPermission({ mode: 'read' })) === 'granted') {
        try {
          const videoHandle = await folderHandle.getFileHandle(`${rec.stem}.webm`);
          const videoFile = await videoHandle.getFile();
          activeVideoUrl = URL.createObjectURL(videoFile);
          els.recVideo.src = activeVideoUrl;
          els.recVideo.hidden = false;
        } catch (_) {
          els.recVideoNote.hidden = false;
          els.recVideoNote.textContent = `Could not find ${rec.stem}.webm in the Recordings Folder.`;
        }
        try {
          const logHandle = await folderHandle.getFileHandle(`${rec.stem}.log`);
          const logFile = await logHandle.getFile();
          logContent = await logFile.text();
        } catch (_) { /* keep excerpt */ }
      } else {
        els.recVideoNote.hidden = false;
        els.recVideoNote.textContent = folderHandle
          ? 'Click "🔓 Grant Folder Access" above to play videos directly from your Recordings Folder.'
          : 'No Recordings Folder handle available.';
      }
    } else {
      els.recVideoNote.hidden = false;
      els.recVideoNote.textContent = 'Saved in Chrome Downloads. Use "Show in Folder" or "Open File" above to play.';
    }

    els.recLogPre.textContent = logContent || '(No session .log text captured for this recording.)';
  }

  async function renderRecordings(data) {
    els.recList.textContent = '';
    if (Folder) {
      folderHandle = await Folder.load().catch(() => null);
      if (folderHandle) {
        const perm = await folderHandle.queryPermission({ mode: 'read' }).catch(() => 'prompt');
        els.grantFolderBtn.hidden = perm === 'granted';
      } else {
        els.grantFolderBtn.hidden = true;
      }
    }

    if (!data.recordings.length) {
      const empty = document.createElement('div');
      empty.className = 'dbg-empty';
      empty.textContent = 'No recordings linked to this chat.';
      els.recList.appendChild(empty);
      selectRecording(null);
      return;
    }

    if (!data.recordings.some((r) => r.id === selectedRecId)) {
      selectedRecId = data.recordings[0].id;
    }

    for (const rec of data.recordings) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rec-item' + (rec.id === selectedRecId ? ' is-selected' : '');
      const t = document.createElement('div');
      t.className = 'rec-item__title';
      t.textContent = rec.stem + '.webm';
      const m = document.createElement('div');
      m.className = 'rec-item__meta';
      const kb = rec.sizeBytes ? `${Math.round(rec.sizeBytes / 1024)} KB` : '';
      m.textContent = `${new Date(rec.startedAt).toLocaleTimeString()} · ${rec.storage}${kb ? ' · ' + kb : ''}`;
      btn.append(t, m);
      btn.addEventListener('click', () => {
        selectedRecId = rec.id;
        renderRecordings(data);
      });
      els.recList.appendChild(btn);
    }

    const active = data.recordings.find((r) => r.id === selectedRecId) || data.recordings[0];
    await selectRecording(active);
  }

  function renderTranscript(data) {
    els.transcriptList.textContent = '';
    const msgs = data.session && Array.isArray(data.session.messages)
      ? data.session.messages.filter((m) => m && m.role !== 'system' && !m.synthetic)
      : [];
    if (!msgs.length) {
      const empty = document.createElement('div');
      empty.className = 'dbg-empty';
      empty.textContent = 'No saved messages for this conversation.';
      els.transcriptList.appendChild(empty);
      return;
    }

    for (const m of msgs) {
      const row = document.createElement('div');
      row.className = 'msg-row';
      const role = document.createElement('div');
      role.className = 'msg-row__role';
      role.textContent = m.role === 'tool' ? `TOOL (${m.name || 'tool'})` : m.role.toUpperCase();
      const body = document.createElement('div');
      body.className = 'msg-row__body';
      if (m.role === 'assistant' && !m.content && Array.isArray(m.tool_calls)) {
        body.textContent = 'Called: ' + m.tool_calls.map((c) => (c.function && c.function.name) || c.name || '?').join(', ');
      } else {
        body.textContent = String(m.content || '');
      }
      row.append(role, body);
      els.transcriptList.appendChild(row);
    }
  }

  function renderAll() {
    const data = currentViewData();
    renderKpisAndTokens(data);
    renderTurns(data);
    renderToolCalls(data);
    renderConsoleAndLogs(data);
    renderRecordings(data);
    renderTranscript(data);
  }

  async function loadFromStorage() {
    const stored = await chrome.storage.local.get([
      'chatSessions',
      'agentTrace',
      'recordingsIndex',
      'pageConsoleHistory',
      'extensionLogs',
    ]);
    store.chatSessions = Array.isArray(stored.chatSessions) ? stored.chatSessions : [];
    store.agentTrace = Array.isArray(stored.agentTrace) ? stored.agentTrace : [];
    store.recordingsIndex = Array.isArray(stored.recordingsIndex) ? stored.recordingsIndex : [];
    store.pageConsoleHistory = Array.isArray(stored.pageConsoleHistory) ? stored.pageConsoleHistory : [];
    store.extensionLogs = Array.isArray(stored.extensionLogs) ? stored.extensionLogs : [];
    renderSessionSelect();
    renderAll();
  }

  // Tabs
  document.querySelectorAll('.dbg-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.panel;
      document.querySelectorAll('.dbg-tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.dbg-panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${target}`));
    });
  });

  els.sessionSelect.addEventListener('change', () => {
    selectedSessionId = els.sessionSelect.value;
    selectedRecId = null;
    renderAll();
  });

  els.refreshBtn.addEventListener('click', loadFromStorage);
  els.showAllRecs.addEventListener('change', () => renderRecordings(currentViewData()));

  if (els.grantFolderBtn) {
    els.grantFolderBtn.addEventListener('click', async () => {
      if (!folderHandle || !Folder) return;
      await Folder.ensurePermission(folderHandle);
      renderRecordings(currentViewData());
    });
  }

  els.copyAllBtn.addEventListener('click', () => {
    const data = currentViewData();
    const md = DR.formatDebugMarkdown({ ...data, extensionLogs: store.extensionLogs });
    copyText(md, els.copyAllBtn);
  });

  els.downloadMdBtn.addEventListener('click', () => {
    const data = currentViewData();
    const md = DR.formatDebugMarkdown({ ...data, extensionLogs: store.extensionLogs });
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `webmcp-debug-${selectedSessionId || 'report'}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  els.copyTokensBtn.addEventListener('click', () => {
    const { summary, drivers, hints } = DR.topTokenDrivers(currentViewData().turns);
    const txt = [
      `Tokens: in ${summary.input} (cached ${summary.cached}), out ${summary.output}`,
      ...drivers.map((d) => `- ${d.label}: ~${d.tokens} (${d.pct}%)`),
      ...(hints.length ? ['', 'Optimization signals:', ...hints.map((h) => '- ' + h)] : []),
    ].join('\n');
    copyText(txt, els.copyTokensBtn);
  });

  els.copyTraceBtn.addEventListener('click', () => {
    const txt = AT.formatTrace(currentViewData().turns) || 'No trace turns.';
    copyText(txt, els.copyTraceBtn);
  });

  els.copyToolsBtn.addEventListener('click', () => {
    const txt = JSON.stringify(currentViewData().toolCalls, null, 2);
    copyText(txt, els.copyToolsBtn);
  });

  els.copyConsoleBtn.addEventListener('click', () => {
    const txt = currentViewData().consoleLogs
      .map((e) => `[${new Date(e.at || Date.now()).toISOString()}] [${e.level}] ${e.text}`)
      .join('\n') || 'No page console errors.';
    copyText(txt, els.copyConsoleBtn);
  });

  els.copyExtLogsBtn.addEventListener('click', () => {
    copyText(els.extLogsPre.textContent || '', els.copyExtLogsBtn);
  });

  els.recCopyLogBtn.addEventListener('click', () => {
    copyText(els.recLogPre.textContent || '', els.recCopyLogBtn);
  });

  els.copyTranscriptBtn.addEventListener('click', () => {
    const msgs = (currentViewData().session && currentViewData().session.messages) || [];
    const txt = msgs
      .filter((m) => m && m.role !== 'system' && !m.synthetic)
      .map((m) => `### ${m.role}\n${m.content || JSON.stringify(m.tool_calls || '')}`)
      .join('\n\n');
    copyText(txt, els.copyTranscriptBtn);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.chatSessions || changes.agentTrace || changes.recordingsIndex || changes.pageConsoleHistory || changes.extensionLogs) {
      loadFromStorage();
    }
  });

  loadFromStorage();
})();
