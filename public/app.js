(() => {
  'use strict';

  const STATUSES = ['idle', 'planning', 'coding', 'testing', 'blocked', 'done'];

  const gridEl = document.getElementById('grid');
  const statsEl = document.getElementById('stats');
  const connEl = document.getElementById('conn');
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
    if (list.length === 0) { renderEmpty(); return; }

    gridEl.innerHTML = list.map((s) => `
      <article class="card status-${escape(s.status)}" data-id="${escape(s.id)}">
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

  async function dismissSession(id) {
    state.delete(id);
    renderGrid();
    try {
      await fetch(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch { /* server will re-broadcast if it comes back */ }
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

  function connect() {
    const es = new EventSource('/events');

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

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
  }

  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      webhookUrl = cfg.webhookUrl;
      urlEl.textContent = webhookUrl;
      if (cfg.requiresSecret) authEl.textContent = '· requires X-Webhook-Secret';
    } catch {
      urlEl.textContent = `${location.origin}/webhook`;
      webhookUrl = urlEl.textContent;
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
  }, 15000);

  loadConfig().then(connect);
})();
