import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeApp, createWorkspace, webhookBody } from './helpers';

describe('persistence (dbPath)', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('workspaces and sessions survive a restart with the same dbPath', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-test-'));
    const dbPath = path.join(tmpDir, 'agstatus.db');

    // First app: create a workspace and post a session, then shut down.
    const first = makeApp({ dbPath });
    const token = await createWorkspace(first.app);
    await request(first.app)
      .post(`/w/${token}/webhook`)
      .send(webhookBody('persisted', { name: 'Keeper', message: 'still here', project: 'proj' }))
      .expect(200);
    first.shutdown();

    // Second app on the same dbPath: token resolves, session is still there.
    const second = makeApp({ dbPath });
    try {
      const list = await request(second.app).get(`/w/${token}/api/sessions`).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({
        id: 'persisted',
        status: 'coding',
        name: 'Keeper',
        message: 'still here',
        project: 'proj',
      });

      // Token also resolves for the dashboard route
      const html = await request(second.app).get(`/w/${token}`).expect(200);
      expect(html.headers['content-type']).toMatch(/text\/html/);
    } finally {
      second.shutdown();
    }
  });

  it('a workspace deleted before shutdown stays deleted after restart', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-test-'));
    const dbPath = path.join(tmpDir, 'agstatus.db');

    const first = makeApp({ dbPath });
    const token = await createWorkspace(first.app);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('gone')).expect(200);
    await request(first.app).delete(`/w/${token}`).expect(200);
    first.shutdown();

    const second = makeApp({ dbPath });
    try {
      const res = await request(second.app).get(`/w/${token}/api/sessions`).expect(404);
      expect(res.body).toEqual({ error: 'unknown workspace' });
    } finally {
      second.shutdown();
    }
  });
});
