# Self-hosting AgStatus

The server is a single Node.js process; the only external state is an optional
PostgreSQL database. It runs anywhere that can expose a port — a VPS, Fly.io,
Render, Railway, Cloud Run, a Raspberry Pi.

## Quick start

### npm

```bash
npm ci
npm run dev           # hot reload via tsx
# or
npm run build && npm start
```

Open http://localhost:3000 and send a test webhook:

```bash
curl -X POST http://localhost:3000/webhook \
  -H 'content-type: application/json' \
  -d '{"session_id": "sess-abc", "name": "Refactor auth", "status": "coding", "message": "Editing server.ts", "project": "my-repo"}'
```

### Docker Compose

```bash
cp .env.example .env   # optional — defaults work out of the box
docker compose up -d --build
```

Binds host port `3000` (override with `PORT` in `.env`). The prebuilt image
`ghcr.io/kardanovir/agstatus` is published from tagged releases and works the
same way: `docker run -d -p 3000:3000 ghcr.io/kardanovir/agstatus`.

### Production without Docker

```bash
npm ci --omit=dev && npm run build
PUBLIC_URL=https://status.example.com \
WEBHOOK_SECRET=$(openssl rand -hex 32) \
  npm start
```

Put a TLS-terminating reverse proxy in front and set `TRUST_PROXY=1`. SSE
requires proxy buffering to be disabled — the server sends
`X-Accel-Buffering: no`, which most proxies honor.

## Single-tenant vs multi-tenant

**Single-tenant (legacy) mode — the default.** One board for the whole
instance, served at `/`. Anyone who can reach the server can see it; writes
can be protected with `WEBHOOK_SECRET`. Right for a personal server on a LAN,
VPN, or a private URL.

**Multi-tenant mode** (`MULTI_TENANT=true`). One instance shared by many
users. Each **workspace** is an isolated board with its own dashboard,
webhook URL, and event stream, identified by an unguessable token in the URL
(`ags_` + 32 URL-safe characters) — the same capability model as Discord or
Slack webhook URLs. No accounts, no passwords; the server stores only a
SHA-256 hash of each token. Per-workspace caps and rate limits keep the
instance healthy (see [docs/api.md](api.md#limits)). This is what the hosted
instance at `https://agstatus.online` runs.

In multi-tenant mode the global `/webhook`, `/events`, `/api/sessions`, and
`/sessions/...` endpoints return `404`; everything lives under `/w/<token>/...`
instead, and `WEBHOOK_SECRET` is ignored (the token is the auth).

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env`
or set them in your deployment environment.

| Variable         | Default                           | Purpose |
| ---------------- | --------------------------------- | ------- |
| `PORT`           | `3000`                            | Port to listen on. With docker-compose, also the published host port (the container always listens on 3000). |
| `HOST`           | `0.0.0.0`                         | Bind address. |
| `PUBLIC_URL`     | `http://localhost:$PORT`          | Public base URL of the service. Used to build the dashboard/webhook URLs returned by the API and shown in the UI. |
| `MULTI_TENANT`   | _(unset)_                         | Set to `true` for multi-tenant workspace mode (see above). |
| `WEBHOOK_SECRET` | _(unset)_                         | Legacy mode only: if set, `POST /webhook` and `POST /sessions/clear` must send `X-Webhook-Secret: <value>`. `DELETE /sessions/:id` and the read endpoints stay open so the dashboard can list and dismiss cards — don't expose a legacy instance publicly if that matters (use multi-tenant mode instead). Ignored in multi-tenant mode. |
| `SESSION_TTL_MS` | `0` (legacy) / `86400000` (multi) | Auto-remove sessions not updated for this many ms. `0` disables expiry. |
| `DATABASE_URL`   | _(empty — in-memory)_             | PostgreSQL connection string (`postgres://user:pass@host:5432/db`) for persistence across restarts. Empty keeps everything in memory. docker-compose defaults it to the bundled `postgres` service; set `DATABASE_URL=` (empty) in `.env` to opt out. (`DB_PATH`/SQLite is no longer supported — see the migration note below.) |
| `POSTGRES_PASSWORD` | `agstatus`                     | docker-compose only: password for the bundled `postgres` service (baked into the default `DATABASE_URL`). Not read by the app itself. |
| `MAX_WORKSPACES` | `10000`                           | Multi-tenant only: hard ceiling on live workspaces; creation returns `503` at the cap. |
| `TRUST_PROXY`    | _(unset)_                         | Set to `1` behind a reverse proxy (Caddy, nginx, a load balancer) so client IPs come from `X-Forwarded-For`. Required for correct per-IP rate limiting on a public instance. |
| `DOMAIN`         | _(unset)_                         | Domain for the bundled Caddy proxy (`--profile tls` only; not read by the app). |
| `APNS_KEY_PATH`  | _(unset)_                         | Path to the APNs `.p8` auth key. Alternatively set `APNS_KEY` to the PEM content itself. |
| `APNS_KEY_ID`    | _(unset)_                         | 10-character key id of the `.p8` key. |
| `APNS_TEAM_ID`   | _(unset)_                         | 10-character Apple Developer team id. |
| `APNS_TOPIC`     | _(unset)_                         | The iOS app's bundle id (sent as the `apns-topic` header), e.g. `com.kardanov.agstatus`. |
| `APNS_ENV`       | `sandbox`                         | `sandbox` targets `api.sandbox.push.apple.com` (development builds); `production` targets `api.push.apple.com` (TestFlight/App Store). `APNS_SERVER` overrides the URL explicitly. |

## Persistence (PostgreSQL)

Persistence is PostgreSQL, enabled by `DATABASE_URL`. With Docker Compose a
`postgres:16` service is bundled and wired up automatically (data lives in the
`pg_data` named volume; set `POSTGRES_PASSWORD` in `.env` for anything
non-local). Set `DATABASE_URL=` (empty) in `.env` to run purely in-memory —
sessions (and workspaces, in multi-tenant mode) are then lost on restart.

The server treats memory as authoritative and writes through to Postgres in
the background, so a database hiccup degrades to "not persisted for a moment",
never to a down dashboard. Rows are **soft-deleted**: deletions set a
`deleted_at` timestamp instead of removing the row, and flagged rows are
invisible to the app. If you need data actually gone (e.g. a deletion
request), purge flagged rows yourself:
`DELETE FROM sessions WHERE deleted_at IS NOT NULL;` (same for `workspaces`,
`devices`, `usage_limits`).

### Migrating from SQLite (pre-PostgreSQL versions)

Earlier versions persisted to SQLite via `DB_PATH`. Copy that data over once,
then drop `DB_PATH` from your `.env`:

```bash
npm install   # better-sqlite3 is a dev dependency now
node scripts/migrate-sqlite-to-postgres.js ./data/agstatus.db "$DATABASE_URL"
```

Re-running is safe — rows that already exist in Postgres are left untouched.

## Production deploy (GitHub Actions → droplet)

The hosted instance at `https://agstatus.online` deploys itself from this
repo: every push to `master` runs
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml), which
SSHes into the droplet, fast-forwards the checkout at `/opt/agstatus`, and
rebuilds the stack (`docker compose --profile tls up -d --build`), then waits
for `/healthz`.

Server-side setup is one command as root (idempotent):

```bash
curl -fsSL https://raw.githubusercontent.com/KardanovIR/claude-status-dashboard/master/deploy/bootstrap-droplet.sh | bash
```

It installs Docker, authorizes the workflow's deploy key, clones the repo,
writes a production `.env` (random Postgres password), and starts
app + PostgreSQL + Caddy. The private deploy key lives in the repo's
`DEPLOY_SSH_KEY` secret; rotating it means generating a new keypair, updating
the secret, and re-running the bootstrap.

## TLS with the bundled Caddy profile

The repo ships a ready-made Caddy setup ([`deploy/Caddyfile`](../deploy/Caddyfile))
wired into `docker-compose.yml` under the `tls` profile. Point your domain's
DNS at the host, open ports 80/443, then:

```bash
cp .env.example .env
# In .env set:
#   DOMAIN=status.example.com
#   PUBLIC_URL=https://status.example.com
#   TRUST_PROXY=1

docker compose --profile tls up -d --build
```

Caddy obtains and renews a Let's Encrypt certificate for `DOMAIN`
automatically and proxies to the app with streaming enabled
(`flush_interval -1`), so SSE works out of the box. Without the profile
(`docker compose up -d`) the app is served plain on host port `${PORT:-3000}`.

## Push notifications (APNs)

Optional, and only relevant if you use the iOS app against your instance.
Self-hosts without a key simply don't send pushes — the server runs exactly
as before and `GET /api/config` reports `"push": false`, so the app knows not
to offer notifications. If the APNs block is only partially configured (or
the key can't be read) the server logs one warning and disables push; it
never fails to start.

To enable:

1. In your [Apple Developer account](https://developer.apple.com/account/resources/authkeys/list),
   create a key with the **Apple Push Notifications service (APNs)** capability
   and download the `.p8` file (downloadable only once).
2. Note the **Key ID** (10 characters, shown next to the key) and your
   **Team ID** (Membership page).
3. Mount or copy the `.p8` file where the server can read it and set:

   ```bash
   APNS_KEY_PATH=/app/keys/AuthKey_ABC123DEFG.p8   # or APNS_KEY with the PEM content
   APNS_KEY_ID=ABC123DEFG
   APNS_TEAM_ID=TEAM123456
   APNS_TOPIC=com.kardanov.agstatus                # your app build's bundle id
   APNS_ENV=sandbox                                # production for TestFlight/App Store builds
   ```

4. Restart. `GET /api/config` now reports `"push": true`, and the app's
   Notifications toggle goes live.

What triggers a push: an agent transitioning into `blocked` notifies every
registered device; transitioning into `done` notifies only devices that opted
in (`notify_done: true`). Repeat alerts for the same session and kind are
debounced to at most one per minute, and a session that first appears already
`done` doesn't notify. A push payload contains the same session name and
message your hook already sent to the board — nothing more — relayed through
Apple's APNs. Device registration endpoints exist in multi-tenant mode only;
see [docs/api.md](api.md#device-push-endpoints).

## Pointing clients at your instance

- CLI: `npx agstatus init --url https://status.example.com`
- iOS app: on the welcome screen, expand "Self-hosting?" and enter your
  server URL, or paste/scan your board URL directly.
- Manual hooks: see [docs/hooks.md](hooks.md).
