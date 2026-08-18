import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeApp, createWorkspace } from './helpers';

describe('static pages', () => {
  it('serves the landing page at / in multi-tenant mode', async () => {
    const { app } = makeApp({ multiTenant: true });
    const res = await request(app).get('/').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('npx agstatus init');
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
});
