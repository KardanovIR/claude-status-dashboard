import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { makeApp, createWorkspace } from './helpers';

describe('static pages', () => {
  it('serves the landing page at / in multi-tenant mode', async () => {
    const { app } = makeApp({ multiTenant: true });
    const res = await request(app).get('/').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // The hero offers both one-liners; a script picks which one is shown first.
    expect(res.text).toContain('curl -fsSL https://agstatus.online/install.sh | sh');
    expect(res.text).toContain('irm https://agstatus.online/install.ps1 | iex');
    // The landing page, not the board shell.
    expect(res.text).not.toContain('/app.js');
  });

  it('serves the dashboard at / in legacy mode', async () => {
    const { app } = makeApp({ multiTenant: false });
    const res = await request(app).get('/').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // Legacy root is the board itself.
    expect(res.text).toContain('/app.js');
  });

  it('serves the board shell at /w/<token>, not the landing page', async () => {
    const { app } = makeApp({ multiTenant: true });
    const token = await createWorkspace(app);
    const res = await request(app).get(`/w/${token}`).expect(200);
    expect(res.text).toContain('/app.js');
  });

  it('serves the privacy policy at /privacy in both modes', async () => {
    for (const multiTenant of [true, false]) {
      const { app } = makeApp({ multiTenant });
      const res = await request(app).get('/privacy').expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('Privacy Policy');
    }
  });

  it('serves the generated docs page at /docs in both modes', async () => {
    for (const multiTenant of [true, false]) {
      const { app } = makeApp({ multiTenant });
      const res = await request(app).get('/docs').expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // One section per source doc, wired to the in-page nav.
      for (const id of ['hooks', 'self-hosting', 'api']) {
        expect(res.text).toContain(`id="${id}"`);
      }
    }
  });

  // Every page is one palette now. Before this, landing.html, privacy.html and
  // the template inside scripts/build-docs.js each carried their own copy of
  // fourteen hex values, and a visitor walking from the marketing page to the
  // board watched the ground, the type and the accent all change underneath
  // them. The only durable guard is that none of them declares a palette.
  describe('one design system across every public page', () => {
    const PAGES = ['/', '/privacy', '/docs'] as const;

    // The pre-1.5 palette: six unmodified Tailwind defaults and the greys
    // around them. tokens.css exists to make these unnecessary.
    const RETIRED = [
      '#0b0d12', '#151923', '#1a1f2c', '#232836', '#e6e8ee', '#8a91a4', '#5b6278',
      '#6b7280', '#3b82f6', '#a855f7', '#f59e0b', '#ef4444', '#10b981',
    ];

    it('every page loads the shared tokens rather than declaring its own', async () => {
      const { app } = makeApp({ multiTenant: true });
      for (const path of PAGES) {
        const res = await request(app).get(path).expect(200);
        expect(res.text, `${path} must link tokens.css`).toContain('href="/tokens.css"');
        // A `:root {` in the page means a second palette has crept back in.
        expect(res.text, `${path} must not declare its own :root block`).not.toMatch(/:root\s*\{/);
      }
    });

    it('no page carries a retired hex literal', async () => {
      const { app } = makeApp({ multiTenant: true });
      for (const path of PAGES) {
        const res = await request(app).get(path).expect(200);
        for (const hex of RETIRED) {
          expect(res.text.toLowerCase(), `${path} still contains ${hex}`).not.toContain(hex);
        }
      }
    });

    // npm and the Homebrew tap get no new releases; `agstatus@1.3.0` stays
    // resolvable, so a link there silently hands someone a build from before
    // Focus and per-project token totals existed.
    it('no page links the retired npm package', async () => {
      const { app } = makeApp({ multiTenant: true });
      for (const path of PAGES) {
        const res = await request(app).get(path).expect(200);
        expect(res.text, `${path} links npm`).not.toContain('npmjs.com');
      }
    });

    // The one that would have caught card.css and marks.js going missing: a
    // page that references an asset the server does not serve is a page that
    // renders unstyled, and nothing else in this suite looks at the <head>.
    it('serves every stylesheet, script and image the pages reference', async () => {
      const { app } = makeApp({ multiTenant: true });
      for (const path of PAGES) {
        const res = await request(app).get(path).expect(200);
        const refs = [...res.text.matchAll(/(?:href|src)="(\/[^"]+\.(?:css|js|webp|png|svg|woff2))"/g)]
          .map((m) => m[1]);
        expect(refs.length, `${path} references no assets at all`).toBeGreaterThan(0);
        for (const ref of new Set(refs)) {
          await request(app).get(ref).expect(200);
        }
      }
    });
  });

  // A card's meta line is the one row where user-supplied text shares space
  // with fixed facts. Every item in it is `flex: none` except the machine and
  // project names, so without these two rules they absorb the whole shortfall:
  // on a 320px card carrying an agent, a machine, a project, an age and a
  // token count, "mini" rendered FOUR PIXELS wide, between two separators that
  // stayed put. jsdom has no layout engine and could not have caught it, so
  // this asserts the contract instead.
  describe('the card meta line cannot crush its own text', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'card.css'), 'utf8');
    const rule = (selector: string) => {
      const m = new RegExp(`\\n\\${selector} \\{([^}]*)\\}`).exec(css);
      if (!m) throw new Error(`no rule for ${selector} in card.css`);
      return m[1];
    };

    it('.meta wraps instead of shrinking its children', () => {
      expect(rule('.meta')).toMatch(/flex-wrap:\s*wrap/);
    });

    it('.host and .proj keep a minimum width', () => {
      for (const sel of ['.host', '.proj']) {
        expect(rule(sel), `${sel} needs a min-width floor`).toMatch(/min-width:\s*[1-9]/);
      }
    });
  });

  // The install one-liners are the documented way in, so both routes have to
  // work on a self-hosted board too — not only on the hosted instance.
  it('serves the install scripts in both modes', async () => {
    for (const multiTenant of [true, false]) {
      const { app } = makeApp({ multiTenant });

      const sh = await request(app).get('/install.sh').expect(200);
      // text/plain so a browser renders the script instead of downloading it;
      // express.static would have answered application/x-sh.
      expect(sh.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(sh.headers['cache-control']).toBe('public, max-age=300');
      expect(sh.text).toContain('#!/bin/sh');

      const ps1 = await request(app).get('/install.ps1').expect(200);
      expect(ps1.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(ps1.headers['cache-control']).toBe('public, max-age=300');
      // Windows PowerShell 5.1 is the floor, so the script must not be empty
      // and must look like PowerShell rather than a shell script.
      expect(ps1.text).toMatch(/\$[A-Za-z_]/);
    }
  });
});
