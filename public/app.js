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
  const detailEl = document.getElementById('detail');

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
    if (s <= 0) return '';        // already reset — a countdown would be a lie
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
    // a Claude-only evening doesn't need Codex bars. With no sessions there is
    // nothing to disambiguate, and the limits still matter between runs, so
    // show everything rather than nothing.
    const active = new Set();
    for (const s of state.values()) active.add(s.source || 'claude');
    const blocks = [];
    for (const u of usage) {
      if (active.size > 0 && !active.has(u.source)) continue;
      const bars = (u.windows || []).map((w) => {
        const pct = Math.min(100, Math.max(0, Number(w.usedPct) || 0));
        const pctText = pct % 1 ? pct.toFixed(1) : String(pct);
        return `
          <div class="usage-row">
            <div class="usage-head">
              <span class="usage-label">${escape(w.label || w.id)}</span>
              <span class="usage-val">${pctText}%${
                w.resetsAt && fmtReset(w.resetsAt) ? ` <span class="usage-reset">· ${escape(fmtReset(w.resetsAt))}</span>` : ''
              }</span>
            </div>
            <div class="usage-track"><div class="usage-fill ${usageLevel(pct)}" style="width:${pct}%"></div></div>
          </div>`;
      });
      if (bars.length === 0) continue;
      // One block per agent; the block header carries the source name, so the
      // rows inside it don't repeat it.
      blocks.push(`
        <section class="usage-block" data-source="${escape(u.source)}" role="button" tabindex="0"
                 aria-label="${escape(SOURCE_NAMES[u.source] || u.source)} usage detail">
          <h2 class="usage-src">${escape(SOURCE_NAMES[u.source] || u.source)}<span class="usage-more">›</span></h2>
          ${bars.join('')}
        </section>`);
    }
    usageEl.innerHTML = blocks.join('');
    usageEl.hidden = blocks.length === 0;
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

  // ---- usage detail: how limits moved, and where the tokens went ------------
  //
  // Two different units share one time axis on purpose. The bars are tokens a
  // project actually spent (from the agent's own local logs, so they reach back
  // as far as those logs go). The lines are the account-wide plan limit, which
  // only exists from the moment a board starts recording it. They correlate but
  // do not convert: a plan limit weights models and cache reads differently.

  const DETAIL_DAYS = 30;
  const LINE_COLORS = ['#4D9FFF', '#B17AFF', '#FFB02E', '#3ECF8E', '#FF5C5C', '#8B93A7'];

  const fmtTokens = (n) => {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
    return String(Math.round(n));
  };
  const dayLabel = (day) => {
    const d = new Date(`${day}T00:00:00Z`);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

  /** The `days` UTC days ending today, oldest first. */
  function dayRange(days) {
    const out = [];
    const today = Date.parse(`${utcDay(Date.now())}T00:00:00Z`);
    for (let i = days - 1; i >= 0; i--) out.push(utcDay(today - i * 86400000));
    return out;
  }

  /** Step-samples a recorded series onto the day grid; null before it starts. */
  function sampleSeries(points, days) {
    return days.map((day) => {
      const end = Date.parse(`${day}T23:59:59Z`);
      let value = null;
      for (const p of points) {
        if (p.at <= end) value = p.usedPct;
        else break;
      }
      return value;
    });
  }

  function renderDetail(source, data) {
    const days = dayRange(data.days || DETAIL_DAYS);
    const name = SOURCE_NAMES[source] || source;

    // Tokens per day for this source, and the per-project totals beside it.
    const perDay = new Map(days.map((d) => [d, 0]));
    const perProject = new Map();
    for (const row of data.projects || []) {
      if (row.source !== source) continue;
      if (perDay.has(row.day)) perDay.set(row.day, perDay.get(row.day) + row.tokens);
      perProject.set(row.project, (perProject.get(row.project) || 0) + row.tokens);
    }
    const series = (data.history || []).filter((h) => h.source === source);
    const maxTokens = Math.max(1, ...perDay.values());
    const totalTokens = [...perDay.values()].reduce((a, b) => a + b, 0);

    // Geometry. The viewBox does the scaling; CSS only sets the drawn size.
    const W = 720, H = 220, L = 44, R = 40, T = 14, B = 26;
    const plotW = W - L - R, plotH = H - T - B;
    const x = (i) => L + (days.length === 1 ? plotW / 2 : (i * plotW) / (days.length - 1));
    const barW = Math.max(2, (plotW / days.length) * 0.62);

    const bars = days.map((day, i) => {
      const v = perDay.get(day) || 0;
      const h = (v / maxTokens) * plotH;
      return `<rect class="dv-bar" x="${(x(i) - barW / 2).toFixed(1)}" y="${(T + plotH - h).toFixed(1)}"
        width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="1.5"
        ><title>${escape(dayLabel(day))}: ${escape(fmtTokens(v))} tokens</title></rect>`;
    }).join('');

    const lines = series.map((s, si) => {
      const vals = sampleSeries(s.points, days);
      let d = '';
      vals.forEach((v, i) => {
        if (v === null) return;
        const px = x(i), py = T + plotH - (Math.min(100, Math.max(0, v)) / 100) * plotH;
        d += `${d === '' ? 'M' : 'L'}${px.toFixed(1)} ${py.toFixed(1)}`;
      });
      const drawn = vals.filter((v) => v !== null).length;
      if (drawn === 0) return '';
      const color = LINE_COLORS[si % LINE_COLORS.length];
      if (drawn === 1) {
        // A board that has only just started recording has one reading; a path
        // with a single moveto renders nothing at all, so mark it as a point.
        const i = vals.findIndex((v) => v !== null);
        const py = T + plotH - (Math.min(100, Math.max(0, vals[i])) / 100) * plotH;
        return `<circle class="dv-dot" cx="${x(i).toFixed(1)}" cy="${py.toFixed(1)}" r="2.5" fill="${color}" />`;
      }
      return `<path class="dv-line" d="${d}" stroke="${color}" />`;
    }).join('');

    const legend = series.map((s, si) => `
      <span class="dv-key">
        <i style="background:${LINE_COLORS[si % LINE_COLORS.length]}"></i>${escape(s.windowId)}
      </span>`).join('');

    const gridLines = [0, 25, 50, 75, 100].map((pct) => {
      const py = T + plotH - (pct / 100) * plotH;
      return `<line class="dv-grid" x1="${L}" x2="${W - R}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}" />
              <text class="dv-axis dv-axis-r" x="${W - R + 6}" y="${(py + 3.5).toFixed(1)}">${pct}%</text>`;
    }).join('');

    const lastTick = days.length - 1;
    const showTick = (i) => i % 7 === 0 || (i === lastTick && lastTick % 7 > 2);
    const xTicks = days.map((day, i) => showTick(i)
      ? `<text class="dv-axis" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${escape(dayLabel(day))}</text>`
      : '').join('');

    const projects = [...perProject.entries()].sort((a, b) => b[1] - a[1]);
    const topShare = projects.length > 0 ? projects[0][1] : 1;
    const projectRows = projects.length === 0
      ? '<p class="dv-empty">No per-project token data reported yet.</p>'
      : projects.map(([project, tokens]) => `
        <div class="dv-proj">
          <div class="dv-proj-head">
            <span class="dv-proj-name">${escape(project)}</span>
            <span class="dv-proj-val">${escape(fmtTokens(tokens))}
              <span class="dv-proj-pct">${totalTokens ? Math.round((tokens / totalTokens) * 100) : 0}%</span>
            </span>
          </div>
          <div class="dv-proj-track"><div class="dv-proj-fill" style="width:${(tokens / topShare) * 100}%"></div></div>
        </div>`).join('');

    detailEl.innerHTML = `
      <div class="dv-head">
        <button class="dv-back" type="button" id="dv-back" aria-label="Back to the board">‹ Board</button>
        <h2 class="dv-title">${escape(name)} · last ${days.length} days</h2>
      </div>
      <div class="dv-card">
        <div class="dv-card-head">
          <span class="dv-card-title">Tokens per day<span class="dv-sub"> · ${escape(fmtTokens(totalTokens))} total</span></span>
          <span class="dv-legend">${legend || '<span class="dv-key-none">limit history starts once reported</span>'}</span>
        </div>
        <svg class="dv-chart" viewBox="0 0 ${W} ${H}" role="img"
             aria-label="${escape(name)} tokens per day and plan limit over time">
          ${gridLines}
          <text class="dv-axis" x="${L - 8}" y="${T + 4}" text-anchor="end">${escape(fmtTokens(maxTokens))}</text>
          <text class="dv-axis" x="${L - 8}" y="${T + plotH + 4}" text-anchor="end">0</text>
          ${bars}${lines}${xTicks}
        </svg>
      </div>
      <div class="dv-card">
        <div class="dv-card-head"><span class="dv-card-title">Where the tokens went</span></div>
        ${projectRows}
      </div>
      <p class="dv-note">Bars are tokens your agent spent, read from its own local logs.
        Lines are the account-wide plan limit, recorded from when this board first saw it.
        They track each other but are not the same measure.</p>`;

    document.getElementById('dv-back').addEventListener('click', () => { location.hash = ''; });
  }

  async function openDetail(source) {
    detailEl.hidden = false;
    detailEl.innerHTML = '<p class="dv-empty">Loading…</p>';
    try {
      const res = await fetch(`${BASE}/api/usage/history?days=${DETAIL_DAYS}`);
      if (!res.ok) throw new Error(String(res.status));
      renderDetail(source, await res.json());
    } catch {
      detailEl.innerHTML = '<p class="dv-empty">Could not load usage history.</p>';
    }
  }

  /** The detail view is a hash route, so Back returns to the board. */
  function applyRoute() {
    const m = /^#usage\/([a-z][a-z0-9_-]*)$/.exec(location.hash);
    const showing = Boolean(m);
    document.body.classList.toggle('detail-open', showing);
    if (showing) openDetail(m[1]);
    else { detailEl.hidden = true; detailEl.innerHTML = ''; }
  }

  usageEl.addEventListener('click', (e) => {
    const block = e.target.closest('.usage-block');
    if (block) location.hash = `usage/${block.dataset.source}`;
  });
  usageEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const block = e.target.closest('.usage-block');
    if (block) { e.preventDefault(); location.hash = `usage/${block.dataset.source}`; }
  });
  window.addEventListener('hashchange', applyRoute);
  applyRoute();

})();
