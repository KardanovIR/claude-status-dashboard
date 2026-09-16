import { describe, it, expect } from 'vitest';
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
