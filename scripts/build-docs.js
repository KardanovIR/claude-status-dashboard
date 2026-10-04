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

// Order is the reading order: setup first, then what Focus reaches, then how to
// drive it, then running your own, then API. Focus support sits second because
// it is the question people ask immediately after wiring the hook up — "will it
// work with my terminal?" — and the answer is narrow enough to need saying
// early. Focus keys follows it directly: knowing Focus reaches your terminal is
// what makes binding a key to it worth reading about.
const DOCS = [
  { id: 'hooks', file: 'docs/hooks.md', nav: 'Integration' },
  { id: 'focus-support', file: 'docs/focus-support.md', nav: 'Focus support' },
  { id: 'focus-keys', file: 'docs/focus-keys.md', nav: 'Focus keys' },
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
  .map(({ doc, html }) => `<section class="doc prose" aria-labelledby="${doc.id}">\n${html}\n</section>`)
  .join('\n<hr class="doc-split" />\n');

const page = `<!doctype html>
<!-- GENERATED FILE — do not edit. Source: docs/*.md, generator: scripts/build-docs.js -->
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>AgStatus docs — integration, self-hosting, API</title>
<meta name="description" content="AgStatus documentation: Claude Code and Codex hook integration, self-hosting with Docker, and the HTTP API reference." />
<!-- --ink-950 and --st-done, converted once. A meta cannot read a custom property. -->
<meta name="theme-color" content="#0c0f0d" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%23141815'/><circle cx='16' cy='16' r='6' fill='%2369c88e'/></svg>" />
<link rel="stylesheet" href="/tokens.css" />
<link rel="stylesheet" href="/site.css" />
<style>
  /* Only what the generated docs need beyond the shared chrome. The palette,
     the reset, the focus ring, the nav, the footer, the prose rules and the
     tables all live in site.css now — this file used to carry its own copy of
     every one of them, as did landing.html and privacy.html. */

  .layout {
    width: var(--page);
    margin: 0 auto;
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    gap: var(--space-2xl);
    padding: var(--space-xl) 0 var(--space-2xl);
    align-items: start;
  }

  @media (max-width: 860px) {
    .layout { grid-template-columns: minmax(0, 1fr); gap: var(--space-xs); }
  }

  /* ---- Contents -------------------------------------------------------- */

  .toc {
    position: sticky;
    top: calc(var(--nav-h) + var(--space-lg));
    font-size: var(--t-sm);
  }

  @media (max-width: 860px) {
    .toc {
      position: static;
      padding: var(--space-sm) var(--space-md);
      background: var(--ink-900);
      border: 1px solid var(--ink-800);
      border-radius: var(--r-md);
    }
  }

  .toc-title {
    margin-bottom: var(--space-xs);
    font-family: var(--font-label);
    font-size: var(--t-2xs);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
  }

  .toc ul { list-style: none; padding: 0; }
  .toc > ul > li { margin-bottom: var(--space-sm); }

  .toc a {
    display: block;
    padding: 2px 0;
    text-decoration: none;
    color: var(--text-3);
    transition: color var(--d-fast) var(--ease);
  }

  .toc a:hover { color: var(--text-1); }
  .toc-doc > a { color: var(--text-1); font-weight: 600; }

  .toc ul ul {
    margin: var(--space-2xs) 0 0 2px;
    padding-left: var(--space-sm);
    border-left: 1px solid var(--ink-800);
  }

  /* ---- Document -------------------------------------------------------- */

  /* The nav is sticky, so every anchor target has to clear it or a jump lands
     with the heading underneath the bar. */
  .doc h2,
  .doc h3,
  .doc h4,
  .doc h5 { scroll-margin-top: calc(var(--nav-h) + var(--space-lg)); }

  .doc h2 { margin: var(--space-xs) 0 var(--space-md); }
  .doc h3 { margin: var(--space-xl) 0 var(--space-xs); }
  .doc h4 { margin: var(--space-lg) 0 var(--space-xs); }

  .doc h5 {
    margin: var(--space-md) 0 var(--space-2xs);
    font-size: var(--t-sm);
    font-weight: 600;
    color: var(--text-2);
  }

  /* A heading is its own permalink. The hash only appears on hover, because a
     row of them down the page is noise on every line you are not pointing at. */
  .anchor { text-decoration: none; color: inherit; }
  .anchor:hover::after { content: " #"; color: var(--text-3); }

  .doc-split {
    border: 0;
    border-top: 1px solid var(--ink-800);
    margin: var(--space-2xl) 0;
  }
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

<footer class="site-foot">
  <div class="foot-inner">
    <span>MIT licensed · Built by Inal Kardanov</span>
    <div class="foot-links">
      <a href="/">Home</a>
      <a href="${REPO}">GitHub</a>
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
