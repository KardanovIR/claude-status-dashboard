import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { configFromEnv } from '../src/config';
import { makeApp } from './helpers';

describe('configFromEnv hardening', () => {
  it('TRUST_PROXY only enables on "1" or "true"', () => {
    expect(configFromEnv({ TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(configFromEnv({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(configFromEnv({ TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(configFromEnv({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(configFromEnv({ TRUST_PROXY: '' }).trustProxy).toBe(false);
    expect(configFromEnv({}).trustProxy).toBe(false);
  });

  it('invalid SESSION_TTL_MS falls back to the mode default instead of NaN', () => {
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: '24h' }).sessionTtlMs).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(configFromEnv({ SESSION_TTL_MS: '24h' }).sessionTtlMs).toBe(0);
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: ' ' }).sessionTtlMs).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: '-5' }).sessionTtlMs).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: '5000' }).sessionTtlMs).toBe(5000);
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: '0' }).sessionTtlMs).toBe(0);
  });

  it('invalid MAX_WORKSPACES falls back to the default', () => {
    expect(configFromEnv({ MAX_WORKSPACES: 'lots' }).maxWorkspaces).toBe(10_000);
    expect(configFromEnv({ MAX_WORKSPACES: '0' }).maxWorkspaces).toBe(10_000);
    expect(configFromEnv({ MAX_WORKSPACES: '50' }).maxWorkspaces).toBe(50);
  });
});

describe('global workspace cap', () => {
  it('creation returns 503 once maxWorkspaces is reached', async () => {
    const { app } = makeApp({ maxWorkspaces: 2 });
    await request(app).post('/api/workspaces').expect(201);
    await request(app).post('/api/workspaces').expect(201);
    const res = await request(app).post('/api/workspaces').expect(503);
    expect(res.body.error).toMatch(/capacity/);
  });

  it('deleting a workspace frees capacity', async () => {
    const { app } = makeApp({ maxWorkspaces: 1 });
    const created = await request(app).post('/api/workspaces').expect(201);
    await request(app).post('/api/workspaces').expect(503);
    await request(app).delete(`/w/${created.body.token}`).expect(200);
    await request(app).post('/api/workspaces').expect(201);
  });
});

describe('/api/config legacy fields', () => {
  it('legacy mode reports requiresSecret and webhookUrl', async () => {
    const { app } = makeApp({ multiTenant: false, webhookSecret: 's3cret' });
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.mode).toBe('legacy');
    expect(res.body.requiresSecret).toBe(true);
    expect(res.body.webhookUrl).toBe('http://test.local/webhook');
  });

  it('legacy mode without a secret reports requiresSecret false', async () => {
    const { app } = makeApp({ multiTenant: false });
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.requiresSecret).toBe(false);
  });

  it('multi mode omits webhookUrl and requiresSecret', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.mode).toBe('multi');
    expect(res.body).not.toHaveProperty('requiresSecret');
    expect(res.body).not.toHaveProperty('webhookUrl');
  });
});
