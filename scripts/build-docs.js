#!/usr/bin/env node
/**
 * Renders docs/*.md into public/docs.html — one page, styled like the
 * landing page, served at /docs. Run after editing any included doc:
 *
 *   npm run build:docs
 *
 * The output is checked in (public/ ships verbatim in the Docker image),
 * so a stale docs.html means someone edited docs/*.md without re-running
 * this. marked is a devDependency; nothing here runs at runtime.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const ROOT = path.join(__dirname, '..');
const REPO = 'https://github.com/KardanovIR/claude-status-dashboard';

// Order is the reading order: setup first, then running your own, then API.
const DOCS = [
  { id: 'hooks', file: 'docs/hooks.md', nav: 'Integration' },
  { id: 'self-hosting', file: 'docs/self-hosting.md', nav: 'Self-hosting' },
  { id: 'api', file: 'docs/api.md', nav: 'HTTP API' },
];

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;|&#\d+;/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

/** Strip tags for TOC labels. */
const textOf = (html) => html.replace(/<[^>]+>/g, '');

function renderDoc(doc) {
  const md = fs.readFileSync(path.join(ROOT, doc.file), 'utf8');
  let html = marked.parse(md, { gfm: true, async: false });

  // Rewrite relative links: sibling docs → in-page anchors, anything else
  // repo-relative → GitHub. Absolute URLs and pure fragments pass through.
  html = html.replace(/href="([^"]+)"/g, (m, href) => {
    // In-doc fragments get the section prefix (all heading ids carry it).
    if (href.startsWith('#')) return `href="#${doc.id}-${href.slice(1)}"`;
    if (/^(https?:|mailto:)/.test(href)) return m;
    const [file, frag] = href.split('#');
    const base = file.replace(/^(\.\/)?(docs\/)?/, '');
    const sibling = DOCS.find((d) => path.basename(d.file) === base);
    if (sibling) return `href="#${frag ? `${sibling.id}-${frag}` : sibling.id}"`;
    // ../foo → repo root; bare foo → alongside docs/.
    const repoPath = file.startsWith('../') ? file.slice(3) : `docs/${file}`;
    return `href="${REPO}/blob/master/${path.posix.normalize(repoPath)}${frag ? `#${frag}` : ''}"`;
  });

  // Demote headings one level (the page owns <h1>) and give each an id
  // prefixed with the doc's section id so the three docs never collide.
  const headings = [];
  html = html.replace(/<h([1-5])>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
    const n = Number(level);
    if (n === 1) {
      headings.unshift({ level: 1, id: doc.id, text: textOf(inner) });
      return `<h2 id="${doc.id}">${inner}</h2>`;
    }
    const id = `${doc.id}-${slug(textOf(inner))}`;
    headings.push({ level: n, id, text: textOf(inner) });
    return `<h${n + 1} id="${id}"><a class="anchor" href="#${id}">${inner}</a></h${n + 1}>`;
  });

  // Tables scroll inside their own container, never the page.
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');

  return { html, headings };
}

const sections = DOCS.map((doc) => ({ doc, ...renderDoc(doc) }));

const toc = sections
  .map(({ doc, headings }) => {
    const subs = headings
      .filter((h) => h.level === 2)
      .map((h) => `<li><a href="#${h.id}">${h.text}</a></li>`)
      .join('\n          ');
    return `<li class="toc-doc"><a href="#${doc.id}">${doc.nav}</a>${
      subs ? `\n        <ul>\n          ${subs}\n        </ul>` : ''
    }</li>`;
  })
  .join('\n      ');

const body = sections
  .map(({ doc, html }) => `<section class="doc" aria-labelledby="${doc.id}">\n${html}\n</section>`)
  .join('\n<hr class="doc-split" />\n');

const page = `<!doctype html>
<!-- GENERATED FILE — do not edit. Source: docs/*.md, generator: scripts/build-docs.js -->
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>AgStatus docs — integration, self-hosting, API</title>
<meta name="description" content="AgStatus documentation: Claude Code and Codex hook integration, self-hosting with Docker, and the HTTP API reference." />
<meta name="theme-color" content="#0b0d12" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%23a855f7'/></svg>" />
<style>
  :root {
    --bg: #0b0d12;
    --surface: #151923;
    --surface-2: #1a1f2c;
    --line: #232836;
    --text: #e6e8ee;
    --muted: #8a91a4;
    --muted-2: #5b6278;
    --idle: #6b7280; --planning: #3b82f6; --coding: #a855f7;
    --testing: #f59e0b; --blocked: #ef4444; --done: #10b981;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
    --page: min(1080px, 100% - 48px);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    background: var(--bg); color: var(--text); font-family: var(--sans);
    line-height: 1.65; -webkit-font-smoothing: antialiased;
  }
  a { color: inherit; }
  :focus-visible { outline: 2px solid var(--coding); outline-offset: 3px; border-radius: 4px; }
  .spectrum {
    height: 2px; border: 0; opacity: 0.85;
    background: linear-gradient(90deg,
      var(--idle) 0 16.66%, var(--planning) 16.66% 33.33%, var(--coding) 33.33% 50%,
      var(--testing) 50% 66.66%, var(--blocked) 66.66% 83.33%, var(--done) 83.33% 100%);
  }
  .nav {
    position: sticky; top: 0; z-index: 50;
    background: rgba(11, 13, 18, 0.78);
    backdrop-filter: saturate(160%) blur(12px);
    -webkit-backdrop-filter: saturate(160%) blur(12px);
    border-bottom: 1px solid var(--line);
  }
  .nav-inner { width: var(--page); margin: 0 auto; height: 60px; display: flex; align-items: center; gap: 20px; }
  .brand {
    display: inline-flex; align-items: center; gap: 10px;
    font-family: var(--mono); font-weight: 600; letter-spacing: -0.02em;
    text-decoration: none; font-size: 15px;
  }
  .mark {
    width: 16px; height: 16px; border-radius: 5px; flex-shrink: 0;
    background: linear-gradient(135deg, var(--coding), var(--planning));
    box-shadow: 0 0 16px rgba(168, 85, 247, 0.5);
  }
  .nav-links { margin-left: auto; display: flex; align-items: center; gap: 22px; font-size: 14px; color: var(--muted); }
  .nav-links a { text-decoration: none; transition: color .15s; }
  .nav-links a:hover { color: var(--text); }
  @media (max-width: 620px) { .nav-links .hide-sm { display: none; } }

  .layout {
    width: var(--page); margin: 0 auto;
    display: grid; grid-template-columns: 220px minmax(0, 1fr);
    gap: 48px; padding: 40px 0 96px; align-items: start;
  }
  @media (max-width: 860px) { .layout { grid-template-columns: minmax(0, 1fr); gap: 8px; } }

  .toc { position: sticky; top: 84px; font-size: 14px; }
  @media (max-width: 860px) { .toc { position: static; border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; background: var(--surface); } }
  .toc-title { font-family: var(--mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted-2); margin-bottom: 10px; }
  .toc ul { list-style: none; }
  .toc > ul > li { margin-bottom: 12px; }
  .toc a { text-decoration: none; color: var(--muted); display: block; padding: 2px 0; transition: color .15s; }
  .toc a:hover { color: var(--text); }
  .toc-doc > a { color: var(--text); font-weight: 600; }
  .toc ul ul { margin: 4px 0 0 2px; padding-left: 12px; border-left: 1px solid var(--line); }

  .doc h2 {
    font-size: clamp(26px, 4vw, 32px); letter-spacing: -0.02em; line-height: 1.2;
    margin: 8px 0 16px; scroll-margin-top: 84px;
  }
  .doc h3 { font-size: 20px; margin: 36px 0 10px; letter-spacing: -0.01em; scroll-margin-top: 84px; }
  .doc h4 { font-size: 16px; margin: 28px 0 8px; scroll-margin-top: 84px; }
  .doc h5 { font-size: 14px; margin: 20px 0 6px; color: var(--muted); scroll-margin-top: 84px; }
  .anchor { text-decoration: none; }
  .anchor:hover::after { content: " #"; color: var(--muted-2); }
  .doc p, .doc ul, .doc ol { margin: 0 0 14px; color: var(--muted); }
  .doc li { margin: 4px 0; }
  .doc ul, .doc ol { padding-left: 24px; }
  .doc strong { color: var(--text); }
  .doc a { color: var(--text); text-decoration-color: var(--muted-2); text-underline-offset: 3px; }
  .doc a:hover { text-decoration-color: var(--text); }
  .doc code {
    font-family: var(--mono); font-size: 0.9em;
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: 5px; padding: 1px 5px; color: var(--text);
  }
  .doc pre {
    background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
    padding: 14px 16px; overflow-x: auto; margin: 0 0 16px; line-height: 1.55;
  }
  .doc pre code { background: none; border: 0; padding: 0; color: var(--text); font-size: 13px; }
  .doc blockquote {
    border-left: 3px solid var(--planning); background: var(--surface);
    border-radius: 0 10px 10px 0; padding: 10px 16px; margin: 0 0 16px;
  }
  .doc blockquote p:last-child { margin-bottom: 0; }
  .table-wrap { overflow-x: auto; margin: 0 0 16px; border: 1px solid var(--line); border-radius: 10px; }
  .doc table { border-collapse: collapse; width: 100%; font-size: 14px; }
  .doc th, .doc td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .doc th { font-family: var(--mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted-2); }
  .doc tr:last-child td { border-bottom: 0; }
  .doc td { color: var(--muted); }
  .doc td code, .doc th code { white-space: nowrap; }
  .doc-split { border: 0; border-top: 1px solid var(--line); margin: 56px 0; }
  .doc hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }

  footer { border-top: 1px solid var(--line); }
  .foot-inner {
    width: var(--page); margin: 0 auto; padding: 24px 0;
    display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: center;
    justify-content: space-between; font-size: 13px; color: var(--muted-2);
  }
  .foot-links { display: flex; gap: 18px; }
  .foot-links a { text-decoration: none; color: var(--muted); }
  .foot-links a:hover { color: var(--text); }
</style>
</head>
<body>

<nav class="nav">
  <div class="nav-inner">
    <a class="brand" href="/"><span class="mark" aria-hidden="true"></span>AgStatus</a>
    <div class="nav-links">
      <a href="#hooks" class="hide-sm">Integration</a>
      <a href="#self-hosting" class="hide-sm">Self-hosting</a>
      <a href="#api" class="hide-sm">API</a>
      <a href="${REPO}">GitHub</a>
    </div>
  </div>
</nav>
<hr class="spectrum" />

<div class="layout">
  <aside class="toc" aria-label="Table of contents">
    <div class="toc-title">Documentation</div>
    <ul>
      ${toc}
    </ul>
  </aside>
  <main>
${body}
  </main>
</div>

<footer>
  <div class="foot-inner">
    <span>MIT licensed · Built by Inal Kardanov</span>
    <div class="foot-links">
      <a href="${REPO}">GitHub</a>
      <a href="https://www.npmjs.com/package/agstatus">npm</a>
      <a href="/privacy">Privacy</a>
    </div>
  </div>
</footer>

</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, 'public', 'docs.html'), page);
console.log(
  `public/docs.html: ${DOCS.map((d) => d.file).join(', ')} → ${(page.length / 1024).toFixed(0)}KB`
);
