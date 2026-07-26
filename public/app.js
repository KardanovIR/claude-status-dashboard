(() => {
  'use strict';

  const STATUSES = ['idle', 'planning', 'coding', 'testing', 'blocked', 'done'];
  const ACTIVE_STATUSES = new Set(['planning', 'coding', 'testing']);
  // An active card gone quiet for this long is probably a dead agent
  // (killed mid-turn, crashed machine) — stop pulsing and dim it.
  const STALE_MS = 10 * 60 * 1000;

  // Workspace-aware base path: on /w/<token> (or a sub-path), all API calls
  // are prefixed with /w/<token>. Otherwise base is '' (legacy mode).
  const wsMatch = location.pathname.match(/^\/w\/(ags_[A-Za-z0-9_-]{32})(?:\/|$)/);
  const BASE = wsMatch ? `/w/${wsMatch[1]}` : '';

  const gridEl = document.getElementById('grid');
  const usageEl = document.getElementById('usage');
  const statsEl = document.getElementById('stats');
  const connEl = document.getElementById('conn');
  const footerEl = document.getElementById('footer');
  const urlEl = document.getElementById('webhook-url');
  const copyBtn = document.getElementById('copy-btn');
  const authEl = document.getElementById('auth-note');

  let webhookUrl = '';
  const state = new Map();

  const escape = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  const relTime = (ts) => {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  // ---- plan usage limit bars ------------------------------------------------

  const SOURCE_NAMES = { claude: 'Claude', codex: 'Codex' };
  let usage = [];

  const fmtReset = (ts) => {
    const s = Math.floor((ts - Date.now()) / 1000);
    if (s <= 60) return 'resets soon';
    // Derive units from one rounded minute total so 7199s is "2h", never "1h 60m".
    const minutes = Math.round(s / 60);
    if (minutes < 60) return `resets in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      const m = minutes % 60;
      return `resets in ${hours}h${m ? ` ${m}m` : ''}`;
    }
    const d = Math.floor(hours / 24);
    const h = hours % 24;
    return `resets in ${d}d${h ? ` ${h}h` : ''}`;
  };

  const usageLevel = (pct) => (pct >= 85 ? 'high' : pct >= 60 ? 'mid' : 'low');

  function renderUsage() {
    // Only show limits for agents that actually have sessions on the board —
    // a Claude-only evening doesn't need Codex bars.
    const active = new Set();
    for (const s of state.values()) active.add(s.source || 'claude');
    const rows = [];
    for (const u of usage) {
      if (!active.has(u.source)) continue;
      const src = SOURCE_NAMES[u.source] || u.source;
      for (const w of u.windows || []) {
        const pct = Math.min(100, Math.max(0, Number(w.usedPct) || 0));
        const pctText = pct % 1 ? pct.toFixed(1) : String(pct);
        rows.push(`
          <div class="usage-row">
            <div class="usage-head">
              <span class="usage-label">${escape(src)} · ${escape(w.label || w.id)}</span>
              <span class="usage-val">${pctText}%${
                w.resetsAt ? ` <span class="usage-reset">· ${escape(fmtReset(w.resetsAt))}</span>` : ''
              }</span>
            </div>
            <div class="usage-track"><div class="usage-fill ${usageLevel(pct)}" style="width:${pct}%"></div></div>
          </div>`);
      }
    }
    usageEl.innerHTML = rows.join('');
    usageEl.hidden = rows.length === 0;
  }

  function renderStats(list) {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const s of list) counts[s.status] = (counts[s.status] || 0) + 1;
    statsEl.innerHTML = STATUSES
      .map((st) => `<span class="stat"><span class="dot status-${st}"></span><b>${counts[st]}</b> ${st}</span>`)
      .join('');
  }

  function renderEmpty() {
    const example = webhookUrl || '/webhook';
    gridEl.innerHTML = `
      <div class="empty">
        No sessions yet. Send a POST to <code>${escape(example)}</code> with JSON:<br><br>
        <code>{ "session_id": "abc", "name": "My task", "status": "coding", "message": "editing server.ts", "project": "dashboard" }</code>
      </div>`;
  }

  function renderGrid() {
    const list = Array.from(state.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    renderStats(list);
    renderUsage(); // session changes can change which sources' bars are shown
    if (list.length === 0) { renderEmpty(); return; }

    gridEl.innerHTML = list.map((s) => `
      <article class="card status-${escape(s.status)}${
        ACTIVE_STATUSES.has(s.status) && Date.now() - s.updatedAt > STALE_MS ? ' stale' : ''
      }" data-id="${escape(s.id)}"${
        ACTIVE_STATUSES.has(s.status) ? ` data-active-since="${s.updatedAt}"` : ''
      }>
        <div class="card-head">
          <div class="name" title="${escape(s.name)}">${escape(s.name)}</div>
          <span class="badge status-${escape(s.status)}">${escape(s.status)}</span>
          <button class="dismiss" type="button" data-dismiss="${escape(s.id)}" aria-label="Dismiss session" title="Dismiss">×</button>
        </div>
        ${s.message ? `<div class="message">${escape(s.message)}</div>` : ''}
        <div class="meta">
          <span class="project" title="${escape(s.project || '')}">${escape(s.project || '')}</span>
          <span class="ts" data-ts="${s.updatedAt}">${relTime(s.updatedAt)}</span>
        </div>
      </article>
    `).join('');
  }

  async function refreshSessions() {
    try {
      const res = await fetch(`${BASE}/api/sessions`);
      if (!res.ok) return;
      const list = await res.json();
      // Merge, don't replace: the fetch may race newer SSE-delivered state.
      // Deletions are handled by SSE remove/snapshot events, not here.
      for (const s of list) {
        const cur = state.get(s.id);
        if (!cur || cur.updatedAt <= s.updatedAt) state.set(s.id, s);
      }
      renderGrid();
    } catch { /* SSE snapshot will reconcile on reconnect */ }
  }

  async function dismissSession(id) {
    state.delete(id);
    renderGrid();
    try {
      const res = await fetch(`${BASE}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) await refreshSessions();
    } catch {
      await refreshSessions();
    }
  }

  gridEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dismiss]');
    if (!btn) return;
    e.preventDefault();
    dismissSession(btn.dataset.dismiss);
  });

  function setConnected(ok) {
    connEl.classList.toggle('disconnected', !ok);
    connEl.title = ok ? 'Live' : 'Reconnecting…';
  }

  // Deleted/expired workspace: stop reconnecting and say so.
  function renderGone() {
    state.clear();
    usage = [];
    renderUsage();
    webhookUrl = '';
    urlEl.textContent = '—';
    connEl.hidden = true;
    if (footerEl) footerEl.hidden = true;
    statsEl.innerHTML = '';
    gridEl.innerHTML = `
      <div class="empty">
        This board no longer exists. It may have been deleted or expired.<br><br>
        <a href="/">Create a new board</a>
      </div>`;
  }

  // Only trust an explicit 404 (unknown workspace); anything else — network
  // error, 200, 429 — means the workspace may still exist, so keep retrying.
  async function workspaceGone() {
    try {
      const res = await fetch(`${BASE}/api/sessions`);
      return res.status === 404;
    } catch {
      return false;
    }
  }

  // SSE with reconnect: on error close the stream and retry with exponential
  // backoff (1s, 2s, 4s… capped at 30s), reset on a successful open.
  let backoff = 1000;
  let sseErrors = 0;

  function connect() {
    const es = new EventSource(`${BASE}/events`);
    let retried = false;

    es.addEventListener('snapshot', (e) => {
      const list = JSON.parse(e.data);
      state.clear();
      for (const s of list) state.set(s.id, s);
      renderGrid();
    });

    es.addEventListener('session', (e) => {
      const s = JSON.parse(e.data);
      state.set(s.id, s);
      renderGrid();
    });

    es.addEventListener('remove', (e) => {
      const { id } = JSON.parse(e.data);
      state.delete(id);
      renderGrid();
    });

    es.addEventListener('usage', (e) => {
      usage = JSON.parse(e.data);
      renderUsage();
    });

    es.onopen = () => {
      backoff = 1000;
      sseErrors = 0;
      setConnected(true);
    };

    es.onerror = async () => {
      if (retried) return;
      retried = true;
      es.close();
      setConnected(false);
      sseErrors += 1;
      // After repeated failures on a workspace page, check whether the
      // workspace itself is gone — if so, stop reconnecting for good.
      if (BASE && sseErrors >= 2 && await workspaceGone()) {
        renderGone();
        return;
      }
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
  }

  // Multi-tenant landing: on / with mode "multi", offer to create a board
  // instead of showing an empty dashboard.
  function renderWelcome() {
    connEl.hidden = true;
    if (footerEl) footerEl.hidden = true;
    gridEl.innerHTML = `
      <div class="welcome">
        <div class="logo"></div>
        <h1>AgStatus</h1>
        <p>Live status board for your coding agents.</p>
        <button class="create-board" id="create-board" type="button">Create a status board</button>
        <div class="welcome-error" id="welcome-error" role="alert"></div>
      </div>`;
    document.getElementById('create-board').addEventListener('click', createBoard);
  }

  async function createBoard() {
    const btn = document.getElementById('create-board');
    const errEl = document.getElementById('welcome-error');
    btn.disabled = true;
    errEl.textContent = '';
    try {
      const res = await fetch('/api/workspaces', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !(data.token || data.dashboardUrl)) {
        errEl.textContent = res.status === 429
          ? 'Too many boards created from this address. Try again later.'
          : 'Could not create a board. Please try again.';
        btn.disabled = false;
        return;
      }
      // Prefer a same-origin path: a misconfigured server PUBLIC_URL in
      // dashboardUrl would strand the user (and their new token) elsewhere.
      location.href = data.token ? `/w/${encodeURIComponent(data.token)}` : data.dashboardUrl;
    } catch {
      errEl.textContent = 'Could not create a board. Please try again.';
      btn.disabled = false;
    }
  }

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(urlEl.textContent || '');
      copyBtn.textContent = 'Copied';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('copied');
      }, 1200);
    } catch { /* ignore */ }
  });

  setInterval(() => {
    document.querySelectorAll('[data-ts]').forEach((el) => {
      el.textContent = relTime(Number(el.dataset.ts));
    });
    // Active cards cross the staleness threshold without any new event.
    document.querySelectorAll('.card[data-active-since]').forEach((el) => {
      el.classList.toggle('stale', Date.now() - Number(el.dataset.activeSince) > STALE_MS);
    });
    renderUsage(); // keeps the "resets in …" countdowns honest
  }, 15000);

  // Neutral state while the root page can't tell legacy from multi yet.
  function renderConnecting() {
    setConnected(false);
    if (footerEl) footerEl.hidden = true;
    statsEl.innerHTML = '';
    gridEl.innerHTML = '<div class="empty">Connecting…</div>';
  }

  let configBackoff = 1000;

  async function init() {
    let cfg = null;
    try {
      const res = await fetch('/api/config');
      if (res.ok) cfg = await res.json();
    } catch { /* handled below */ }

    if (!cfg && !BASE) {
      // On the root page a missing config could be either mode — don't guess
      // (a legacy dashboard on a multi server 404s forever). Retry instead.
      renderConnecting();
      setTimeout(init, configBackoff);
      configBackoff = Math.min(configBackoff * 2, 30000);
      return;
    }
    configBackoff = 1000;

    if (!BASE && cfg.mode === 'multi') {
      renderWelcome();
      return;
    }

    if (footerEl) footerEl.hidden = false;
    webhookUrl = (cfg && cfg.webhookUrl) || `${location.origin}${BASE}/webhook`;
    urlEl.textContent = webhookUrl;
    if (cfg && cfg.requiresSecret) authEl.textContent = '· requires X-Webhook-Secret';
    connect();
  }

  init();
})();
