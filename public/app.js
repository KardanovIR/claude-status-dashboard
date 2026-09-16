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
  // Focus: listeners currently online (machine id → presence frame), and the
  // latest command each card is showing (session id → status). Both live
  // outside the DOM because the grid is re-rendered wholesale on every event.
  const machines = new Map();
  const focus = new Map();
  // Legacy boards can require X-Webhook-Secret on writes; this page never sends it.
  let requiresSecret = false;

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
        </div>${renderFocus(s)}
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
    // The card is going now, so its focus state and pending timers go with it:
    // waiting for the server's `remove` leaves them alive for as long as the SSE
    // backoff (up to 30s) while this DELETE succeeds anyway. Sessions are only
    // soft-deleted and resurrect on the next post, and the card that comes back
    // must not be wearing the status — or the Resume button — of a dead tap.
    setFocus(id, null);
    renderGrid();
    try {
      const res = await fetch(`${BASE}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) await refreshSessions();
    } catch {
      await refreshSessions();
    }
  }

  // ---- Focus: bring a session's terminal to the front on its machine -------
  //
  // An explicit control, never the card tap. Presence comes from the
  // `machines`/`machine` SSE frames, a tap POSTs a command carrying ids only,
  // and the outcome arrives as `command_ack` (docs/api.md "Focus commands",
  // docs/design/focus-protocol.md §7).

  // Two waiting marks, not one. The server's command TTL is 120s and its own
  // `expired` ack follows within a sweep of that (§3.3), so a listener that was
  // asleep at 15s can still connect, claim and ack long after — the design's
  // "hard 15s timeout" (§7) says the machine looks asleep, it does not decide.
  // Only the second mark gives up, past any expired ack this board could be sent.
  const ACK_SLOW_MS = 15000;
  const ACK_GIVEUP_MS = 150000;
  const STATUS_CLEAR_MS = 8000;   // successes fade; failures stay until the next tap

  const uuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    // A plain-http LAN board has no crypto.randomUUID; build a v4 by hand.
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  const machineOnline = (id) => {
    const m = machines.get(id);
    return Boolean(m && m.online);
  };

  // The hook's label, plus the id's last four hex when two online machines
  // share it — the default names ("Mac", "PC") make that likely.
  function machineLabel(host) {
    const own = machines.get(host.machine.id);
    const name = (own && own.name) || host.machine.name || 'Machine';
    let same = 0;
    for (const m of machines.values()) if (m.online && m.name === name) same += 1;
    return same > 1 ? `${name} (${host.machine.id.slice(-4)})` : name;
  }

  function offlineText(host, name) {
    const m = machines.get(host.machine.id);
    return m && m.lastSeen ? `${name} is offline (${relTime(m.lastSeen)})` : `${name} is offline`;
  }

  // The visible note: the time keeps ticking with the other [data-ts] labels, and a
  // machine the board has never seen gets the hint a tooltip can't give on touch.
  function offlineNote(host, name) {
    const m = machines.get(host.machine.id);
    if (!m) {
      return `${escape(name)} is offline — needs the <a href="/docs#hooks-focus-optional-opt-in">AgStatus listener</a> on that machine`;
    }
    return m.lastSeen
      ? `${escape(name)} is offline (<span data-ts="${Number(m.lastSeen)}">${escape(relTime(m.lastSeen))}</span>)`
      : `${escape(name)} is offline`;
  }

  // Every element is always present and toggled with `hidden`, so a status
  // change is painted in place and the live region actually announces it.
  function renderFocus(s) {
    const host = s.host;
    if (!host || !host.machine) return '';
    const name = machineLabel(host);
    const blocked = !BASE && requiresSecret;
    const online = !blocked && machineOnline(host.machine.id);
    const st = focus.get(s.id);
    const offline = online ? '' : blocked ? 'Bring-to-front needs the webhook secret on this board' : offlineText(host, name);
    const noteHtml = online ? '' : blocked ? escape(offline) : offlineNote(host, name);
    let title = `Bring this session's window to the front on ${name}`;
    if (!online) {
      title = blocked || machines.has(host.machine.id)
        ? offline
        : `${offline} — bring-to-front needs the AgStatus listener on that machine`;
    }
    // aria-disabled rather than disabled: an offline machine's button keeps
    // its tooltip and stays reachable for a screen reader to say why.
    const button = (type, label, hidden) => `
          <button class="focus-btn" type="button" data-focus="${escape(s.id)}" data-type="${type}"
                  title="${escape(title)}"${online ? '' : ' aria-disabled="true"'}${hidden ? ' hidden' : ''}>${escape(label)}</button>`;
    return `
        <div class="focus">
          ${button('focus', `Bring to front on ${name}`, false)}
          ${button('resume', 'Resume', !(st && st.resume))}
          <span class="focus-note"${offline && !st ? '' : ' hidden'}>${noteHtml}</span>
          <span class="focus-status${st ? ` ${st.kind}` : ''}" aria-live="polite">${st ? escape(st.text) : ''}</span>
        </div>`;
  }

  /** Repaints one card's focus row without re-rendering the grid. */
  function paintFocus(id) {
    let row = null;
    for (const el of gridEl.querySelectorAll('.card')) {
      if (el.dataset.id === id) row = el.querySelector('.focus');
    }
    if (!row) return;
    const st = focus.get(id);
    const status = row.querySelector('.focus-status');
    status.className = `focus-status${st ? ` ${st.kind}` : ''}`;
    status.textContent = st ? st.text : '';
    const note = row.querySelector('.focus-note');
    note.hidden = Boolean(st) || !note.textContent;
    row.querySelector('[data-type="resume"]').hidden = !(st && st.resume);
  }

  function setFocus(id, st) {
    const cur = focus.get(id);
    if (cur) {
      clearTimeout(cur.ackTimer);
      clearTimeout(cur.clearTimer);
    }
    if (st) focus.set(id, st); else focus.delete(id);
    paintFocus(id);
  }

  // Drops focus state no card can show any more: a session that left the board,
  // and one whose machine turned Focus off — the hook posts `host: null` so a live
  // card clears (§3.2). renderFocus draws no row for either, so paintFocus would
  // leave the entry and its timers behind, and a machine that re-enabled Focus
  // would get its card back wearing the old tap's status and Resume button.
  function pruneFocus() {
    for (const id of focus.keys()) {
      const s = state.get(id);
      if (!s || !s.host) setFocus(id, null);
    }
  }

  /** A final outcome: successes fade after a while, failures stay until the next tap. */
  function showResult(id, st, kind, text, resume) {
    st.done = true;
    st.inferred = false;   // heard, not guessed, unless the caller says otherwise
    st.kind = kind;
    st.text = text;
    st.resume = Boolean(resume);
    clearTimeout(st.ackTimer);
    if (kind === 'ok') {
      st.clearTimer = setTimeout(() => { if (focus.get(id) === st) setFocus(id, null); }, STATUS_CLEAR_MS);
    }
    paintFocus(id);
  }

  // An outcome the board inferred rather than heard: the tap may have landed all
  // the same — a lost response, or a TTL this board can only guess at — so a
  // matching ack still overrides it. Dropping a genuine ack, and leaving the card
  // on a failure while the window is in front, is what this must never produce.
  function inferFailure(id, st, text) {
    showResult(id, st, 'fail', text);
    st.inferred = true;
  }

  const SEND_ERRORS = {
    401: 'Not allowed — this board needs the webhook secret',
    404: 'Session gone',
    409: 'No machine info for this session',
    429: 'Too many taps — wait a moment',
  };

  async function sendCommand(id, type) {
    const s = state.get(id);
    if (!s || !s.host) return;
    const name = machineLabel(s.host);
    const st = {
      cmdId: uuid(), type, name, kind: 'pending', text: 'Sending…', done: false, inferred: false, resume: false,
      app: (s.host.app && s.host.app.name) || 'the app',
    };
    setFocus(id, st);
    // The slow mark repaints in place and leaves the card pending; the give-up
    // timer reuses `ackTimer`, so a newer tap and a real ack both cancel it.
    st.ackTimer = setTimeout(() => {
      if (focus.get(id) !== st || st.done) return;
      st.text = `No answer from ${name} yet — is it asleep?`;
      paintFocus(id);
      st.ackTimer = setTimeout(() => {
        if (focus.get(id) === st && !st.done) inferFailure(id, st, `No answer from ${name} — is it asleep?`);
      }, ACK_GIVEUP_MS - ACK_SLOW_MS);
    }, ACK_SLOW_MS);
    let res;
    try {
      res = await fetch(`${BASE}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: st.cmdId, type, session_id: id }),
      });
    } catch {
      // The POST may still have reached the server and only its answer been lost.
      if (focus.get(id) === st && !st.done) inferFailure(id, st, "Couldn't reach the board");
      return;
    }
    // A newer tap, or an ack that beat the response, already took over.
    if (focus.get(id) !== st || st.done) return;
    if (!res.ok) {
      showResult(id, st, 'fail', SEND_ERRORS[res.status] || `Couldn't send (HTTP ${res.status})`);
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (focus.get(id) !== st || st.done) return;
    st.text = data.delivered === false ? `Sent — ${name} is not connected` : 'Sent…';
    paintFocus(id);
  }

  function handleAck(ack) {
    const id = ack.session_id;
    const st = focus.get(id);
    // Only the command this card is waiting on: an older one that a re-tap
    // superseded, or a stray ack, has nothing to say to the viewer. A card that
    // gave up waiting is still listening — that is what `inferred` is for.
    if (!st || st.cmdId !== ack.id || (st.done && !st.inferred)) return;
    const name = st.name;
    switch (ack.result) {
      case 'focused': showResult(id, st, 'ok', `Brought to front on ${name}`); return;
      case 'activated': showResult(id, st, 'ok', `Opened ${st.app} on ${name} — couldn't find the exact window`); return;
      case 'selected': showResult(id, st, 'ok', `Selected the pane on ${name}; the window stayed behind`); return;
      case 'resumed': showResult(id, st, 'ok', `Resumed on ${name}`); return;
      default: break;
    }
    switch (ack.reason) {
      case 'superseded': showResult(id, st, 'ok', 'Replaced by a newer tap'); return;
      case 'not-running': showResult(id, st, 'fail', `Not running on ${name}`, true); return;
      case 'expired': showResult(id, st, 'fail', `No answer from ${name} — is it asleep?`); return;
      case 'unsupported-type':
        if (st.type === 'resume') { showResult(id, st, 'fail', "Resume isn't available yet"); return; }
        break;
      default: break;
    }
    showResult(id, st, 'fail', `Couldn't bring it to front (${ack.reason || ack.result || 'unknown'})`);
  }

  gridEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dismiss]');
    if (btn) {
      e.preventDefault();
      dismissSession(btn.dataset.dismiss);
      return;
    }
    const focusBtn = e.target.closest('[data-focus]');
    if (!focusBtn) return;
    e.preventDefault();
    if (focusBtn.getAttribute('aria-disabled') === 'true') return;
    sendCommand(focusBtn.dataset.focus, focusBtn.dataset.type === 'resume' ? 'resume' : 'focus');
  });

  function setConnected(ok) {
    connEl.classList.toggle('disconnected', !ok);
    connEl.title = ok ? 'Live' : 'Reconnecting…';
  }

  // Deleted/expired workspace: stop reconnecting and say so.
  function renderGone() {
    state.clear();
    machines.clear();
    for (const id of focus.keys()) setFocus(id, null);
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
      pruneFocus();
      renderGrid();
    });

    es.addEventListener('session', (e) => {
      const s = JSON.parse(e.data);
      state.set(s.id, s);
      pruneFocus();
      renderGrid();
    });

    es.addEventListener('remove', (e) => {
      const { id } = JSON.parse(e.data);
      state.delete(id);
      setFocus(id, null);
      renderGrid();
    });

    // Presence: the frame lists the machines online right now (src/app.ts
    // `onlineMachines`), so a reconnect re-seeds them; single frames then keep it
    // current. It is not the whole map, so nothing is cleared — an offline machine
    // dropped here loses the name and `lastSeen` behind "<name> is offline (3m
    // ago)", and its card then tells a user who already installed the listener to
    // install it. One that went offline while the stream was down keeps its name
    // and loses only `lastSeen`: the frame that said when never arrived.
    es.addEventListener('machines', (e) => {
      const online = new Set();
      for (const m of JSON.parse(e.data)) {
        machines.set(m.id, { ...(machines.get(m.id) || {}), ...m });
        online.add(m.id);
      }
      for (const [id, m] of machines) {
        if (m.online && !online.has(id)) machines.set(id, { id, name: m.name, online: false });
      }
      renderGrid();
    });

    // An offline frame carries no name, so the merge keeps the one we had for
    // the "<name> is offline" copy.
    es.addEventListener('machine', (e) => {
      const m = JSON.parse(e.data);
      machines.set(m.id, { ...(machines.get(m.id) || {}), ...m });
      renderGrid();
    });

    es.addEventListener('command_ack', (e) => {
      handleAck(JSON.parse(e.data));
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
    requiresSecret = Boolean(cfg && cfg.requiresSecret);
    if (requiresSecret) authEl.textContent = '· requires X-Webhook-Secret';
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
