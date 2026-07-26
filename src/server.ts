import { configFromEnv } from './config';
import { createApp } from './app';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const cfg = configFromEnv();
const { app, ready } = createApp(cfg);

/** Connection string with any password replaced, safe for logs. */
const redactedDbUrl = cfg.databaseUrl.replace(/\/\/([^:@/]+):[^@/]+@/, '//$1:***@');

// Don't accept traffic until persisted state is loaded — a webhook arriving
// before the load would be overwritten by it.
ready
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`AgStatus dashboard v${cfg.version} listening on http://${HOST}:${PORT}`);
      console.log(`Mode:      ${cfg.multiTenant ? 'multi-tenant (workspaces)' : 'single-tenant (legacy)'}`);
      console.log(`Dashboard: ${cfg.publicUrl}`);
      if (cfg.multiTenant) {
        console.log(`Create a workspace: POST ${cfg.publicUrl}/api/workspaces`);
      } else {
        console.log(`Webhook:   ${cfg.publicUrl}/webhook`);
        if (cfg.webhookSecret) console.log('Auth:      X-Webhook-Secret header required');
      }
      if (cfg.databaseUrl) console.log(`Storage:   PostgreSQL at ${redactedDbUrl}`);
      else console.log('Storage:   in-memory (set DATABASE_URL to persist)');
    });
  })
  .catch((err: unknown) => {
    console.error(
      `Cannot reach PostgreSQL at ${redactedDbUrl}: ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
