# Claude Status Dashboard

A tiny webhook-driven dashboard for tracking the status of your Claude Code
sessions at a glance. Push status updates from each session; the page shows
them live, color-coded, and mobile-friendly.

![statuses](https://img.shields.io/badge/statuses-idle%20%7C%20planning%20%7C%20coding%20%7C%20testing%20%7C%20blocked%20%7C%20done-blueviolet)

![Dashboard screenshot](docs/dashboard.jpg)

## Features

- **Webhook ingestion** — POST status updates from anywhere.
- **Live updates** — Server-Sent Events push changes to the browser instantly.
- **Color-coded statuses** — `idle`, `planning`, `coding`, `testing`, `blocked`, `done`.
- **Mobile optimized** — fluid grid that collapses to a single column in portrait
  and packs horizontally in landscape.
- **Configurable** — public URL, port, and optional shared-secret auth via env vars.
- **Zero database by default** — sessions live in memory, with optional TTL-based
  expiry; set `DB_PATH` for SQLite-backed persistence across restarts.
- **Multi-tenant mode (optional)** — run one shared instance where every
  workspace gets its own token-scoped dashboard and webhook URLs.

## Quick start

```bash
npm install
npm run dev           # hot reload via tsx
# or
npm run build && npm start
```

Or with Docker Compose (binds host port `3000`; override with `PORT` in `.env`):

```bash
docker compose up -d --build
```

Open http://localhost:3000 and send a webhook:

```bash
curl -X POST http://localhost:3000/webhook \
  -H 'content-type: application/json' \
  -d '{
    "session_id": "sess-abc",
    "name": "Refactor auth",
    "status": "coding",
    "message": "Editing server.ts",
    "project": "my-repo"
  }'
```

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env`
or set them in your deployment environment.

| Variable          | Default                   | Purpose                                                                 |
| ----------------- | ------------------------- | ----------------------------------------------------------------------- |
| `PORT`            | `3000`                    | Port to listen on.                                                      |
| `HOST`            | `0.0.0.0`                 | Bind address.                                                           |
| `PUBLIC_URL`      | `http://localhost:$PORT`  | Public URL of the deployed service. Shown in the UI; defines webhook URL. |
| `MULTI_TENANT`    | _(unset)_                 | Set to `true` to enable [multi-tenant workspace mode](#multi-tenant-mode-workspaces). |
| `WEBHOOK_SECRET`  | _(unset)_                 | Legacy (single-tenant) mode only: if set, `POST /webhook` and `POST /sessions/clear` must send `X-Webhook-Secret: <value>` (`DELETE /sessions/:id` and reads stay open — see endpoint table). Ignored in multi-tenant mode. |
| `SESSION_TTL_MS`  | `0` (legacy) / `86400000` (multi) | Auto-remove sessions not updated for this many ms. `0` disables expiry. |
| `DB_PATH`         | _(empty — in-memory)_     | SQLite file path for persistence (WAL mode). Empty keeps everything in memory; state is lost on restart. |
| `MAX_WORKSPACES`  | `10000`                   | Multi-tenant mode: hard ceiling on live workspaces; creation returns `503` at the cap. |
| `TRUST_PROXY`     | _(unset)_                 | Set to `1` behind a reverse proxy (Caddy, nginx) so client IPs come from `X-Forwarded-For`. |

## Webhook API

### `POST /webhook`

Creates or updates a session. Upserts by `session_id`.

**Headers**
- `Content-Type: application/json`
- `X-Webhook-Secret: <value>` — required only if `WEBHOOK_SECRET` is configured.

**Body**

| Field        | Type   | Required | Notes                                                                 |
| ------------ | ------ | -------- | --------------------------------------------------------------------- |
| `session_id` | string | yes      | Unique identifier for the session. Must match `^[A-Za-z0-9._:-]{1,128}$`. |
| `status`     | enum   | yes      | One of `idle`, `planning`, `coding`, `testing`, `blocked`, `done`.    |
| `name`       | string | no       | Human-readable title. Defaults to `session_id` if omitted. Truncated to 120 chars. |
| `message`    | string | no       | Short description of the current activity (shown on the card). Truncated to 300 chars. |
| `project`    | string | no       | Project or repo the session is working on. Truncated to 120 chars.    |

Control characters are stripped from all string fields. The JSON body is
capped at 16 KB.

**Response** — `200 OK`

```json
{ "ok": true, "session": { "id": "sess-abc", "status": "coding", ... } }
```

**Errors** — `400` on missing/malformed `session_id` or invalid `status`;
`401` on bad secret; `413` on bodies over 16 KB.

### Other endpoints

| Method & path              | Purpose                                        | Auth |
| -------------------------- | ---------------------------------------------- | ---- |
| `GET /`                    | Dashboard UI.                                  | no   |
| `GET /events`              | SSE stream: `snapshot`, `session`, `remove`.   | no   |
| `GET /api/sessions`        | JSON list of all sessions.                     | no   |
| `GET /api/config`          | Server mode, version, and status list (used by the UI). | no   |
| `GET /healthz`             | Liveness probe.                                | no   |
| `DELETE /sessions/:id`     | Remove one session.                            | no   |
| `POST /sessions/clear`     | Remove all sessions.                           | yes  |

The endpoints above are the **legacy (single-tenant) mode** API — the default;
same endpoints and semantics as v1, with the tightened input validation
described under `POST /webhook`. In multi-tenant mode the global `/webhook`, `/events`,
`/api/sessions`, and `/sessions/...` endpoints return `404`; use the
workspace-scoped equivalents below.

## Multi-tenant mode (workspaces)

Set `MULTI_TENANT=true` to run one instance shared by many users. Sessions are
grouped into **workspaces**: isolated namespaces, each with its own dashboard,
webhook URL, and event stream. There are no accounts or passwords — a workspace
is identified by an unguessable token embedded in its URLs
(`ags_` + 32 URL-safe characters), the same capability model as Discord/Slack
webhook URLs. Anyone who has the URL can view and update that workspace, so
treat it like a secret. The server stores only a SHA-256 hash of the token; the
raw token is returned exactly once, at creation.

### Create a workspace

```bash
curl -X POST https://status.example.com/api/workspaces
```

**Response** — `201 Created`

```json
{
  "ok": true,
  "token": "ags_...",
  "dashboardUrl": "https://status.example.com/w/ags_...",
  "webhookUrl": "https://status.example.com/w/ags_.../webhook"
}
```

Save the token — it is not shown again. Workspace creation is rate limited
(about 20 per hour per IP; `429` beyond that).

### Workspace endpoints

Everything under `/w/<token>/...` mirrors the legacy API, scoped to one
workspace:

| Method & path                     | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `GET /w/<token>`                  | Dashboard UI for this workspace.                          |
| `GET /w/<token>/api/sessions`     | JSON list of the workspace's sessions (newest first).     |
| `GET /w/<token>/events`           | SSE stream: `snapshot` on connect, then `session` / `remove`; keepalive comment every 25 s. |
| `POST /w/<token>/webhook`         | Create/update a session. `200` with `{ok, session}`; `400` on validation errors; `429` over the rate limit. |
| `DELETE /w/<token>/sessions/:id`  | Remove one session. Returns `{ok: boolean}`.              |
| `POST /w/<token>/sessions/clear`  | Remove all sessions in the workspace. Returns `{ok: true}`. |
| `DELETE /w/<token>`               | Delete the whole workspace: all sessions removed and its event streams closed. Returns `{ok: true}`. |

Any request with an invalid or unknown token returns
`404 {"error": "unknown workspace"}`.

### Limits

To keep a shared instance healthy, each workspace is capped:

- **50 sessions** — a new session past the cap evicts the oldest-updated one
  (a `remove` event is broadcast for it).
- **10 concurrent SSE connections** — the 11th gets `429` before the stream starts.
- **120 webhook requests/minute** — `429` beyond that.
- **Sessions expire after 24 h** without updates by default (`SESSION_TTL_MS`).
- **Workspaces idle for more than 60 days are deleted** by a periodic sweep
  (runs every 6 hours).

### Privacy

A workspace's data lives only under its token. To wipe everything you've sent —
sessions, names, messages, project paths — delete the workspace:

```bash
curl -X DELETE https://status.example.com/w/<token>
```

## Status semantics

| Status     | Color  | Suggested meaning                            |
| ---------- | ------ | -------------------------------------------- |
| `idle`     | gray   | Waiting for user input, no active work.      |
| `planning` | blue   | Designing or gathering context.              |
| `coding`   | purple | Editing files.                               |
| `testing`  | amber  | Running tests or validating changes.         |
| `blocked`  | red    | Needs user help, or an error occurred.       |
| `done`     | green  | Task complete.                               |

`planning`, `coding`, and `testing` badges pulse to indicate active work.
`blocked` cards are highlighted with a red glow. `done` cards are dimmed.

## Setting up Claude Code

### The easy way: `agstatus init`

The [`cli/`](cli/) package does the whole setup in one command — creates a
private board, installs a dependency-free Node hook, and safely merges the
hook registrations into `~/.claude/settings.json` (with a backup):

```bash
npx agstatus init                      # use the default hosted instance
npx agstatus init --url https://your-server.example   # self-hosted
npx agstatus init --code XXXX-XXXX    # pair with a board created elsewhere
npx agstatus init --minimal           # send tool names only, never command text
```

It prints your board URL plus a QR code to open it on your phone. Also:
`npx agstatus status` (check setup + server reachability) and
`npx agstatus uninstall` (clean removal).

> Until the package is published to npm, run it from the repo:
> `npm --prefix cli install && npm --prefix cli run build && node cli/dist/cli.js init`

Boards created elsewhere (e.g. a mobile app) can hand you a pairing code:
the board owner calls `POST /w/<token>/pair` and gets a short-lived
single-use code (15 min, max 3 outstanding per board); `agstatus init --code`
exchanges it via `POST /api/pair/claim` for the board's URLs. Claims are rate
limited to 10/min/IP.

### The manual way (bash hook)

The repo also includes the original bash hook at
[`hooks/claude-status-hook.sh`](hooks/claude-status-hook.sh) that translates
Claude Code [hook events](https://code.claude.com/docs/en/hooks) into webhook
calls. Wire it up once and every Claude Code session you run will appear on the
dashboard automatically.

### 1. Prerequisites

- The dashboard service running and reachable from your machine.
- `curl` and `jq` installed (`brew install jq` on macOS).

### 2. Install the hook script

Copy the script into your Claude config directory and make it executable:

```bash
mkdir -p ~/.claude/hooks
cp hooks/claude-status-hook.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/claude-status-hook.sh
```

  ### 3. Configure `~/.claude/settings.json`

For all sessions (user-scope), edit `~/.claude/settings.json`. For one project,
use `.claude/settings.json` in that repo instead.

```json
{
  "env": {
    "CLAUDE_STATUS_URL": "https://claude-status.example.com",
    "CLAUDE_STATUS_SECRET": "your-shared-secret"
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/claude-status-hook.sh" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash|Task|WebSearch|WebFetch",
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/claude-status-hook.sh" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/claude-status-hook.sh" }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/claude-status-hook.sh" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/claude-status-hook.sh" }
        ]
      }
    ]
  }
}
```

Replace `CLAUDE_STATUS_URL` with the public URL of your dashboard. Drop
`CLAUDE_STATUS_SECRET` if you didn't set `WEBHOOK_SECRET` on the server.

**Using a multi-tenant instance?** Point `CLAUDE_STATUS_URL` at your workspace
instead:

```json
"CLAUDE_STATUS_URL": "https://<host>/w/<token>"
```

The hook appends `/webhook` and `/sessions/<id>` to whatever base URL you give
it, so targeting a workspace requires no changes to the script. Workspaces
don't use `CLAUDE_STATUS_SECRET` — the token in the URL is the auth.

### 4. How events map to statuses

The shipped script applies this mapping. Customize the script to taste.

| Hook event                      | Dashboard status | Notes                                                 |
| ------------------------------- | ---------------- | ----------------------------------------------------- |
| `SessionStart`                  | `idle`           | New session appears as soon as Claude starts.         |
| `PreToolUse` — `Edit` / `Write` / `MultiEdit` / `NotebookEdit` | `coding`  | Card shows the tool name.                             |
| `PreToolUse` — `Bash` (test runner) | `testing`    | Detected via `pytest`/`jest`/`vitest`/`go test`/etc.  |
| `PreToolUse` — `Bash` (other)   | `coding`         | Card shows the command (truncated).                   |
| `PreToolUse` — `Task` / `WebSearch` / `WebFetch` | `planning` | Investigation tools.                                  |
| `Notification`                  | `blocked`        | Permission prompts and other attention-needed events. |
| `Stop`                          | `idle`           | Turn finished, waiting for the next prompt.           |
| `SessionEnd`                    | _card removed_   | Hook calls `DELETE /sessions/:id` so the card disappears. |

The card `name` defaults to the basename of the session's working directory, so
multiple sessions are easy to tell apart.

### 5. Verify

Start a fresh Claude Code session in any project. The dashboard should show a
new card transitioning through `idle → coding → idle` as you work. To debug:

```bash
# Tail Claude's hook logs (path may vary by OS):
tail -f ~/.claude/logs/*.log

# Or run the script manually with a fake payload:
echo '{"hook_event_name":"SessionStart","session_id":"manual-test","cwd":"'"$PWD"'"}' \
  | CLAUDE_STATUS_URL=http://localhost:3000 ~/.claude/hooks/claude-status-hook.sh
```

The hook is intentionally non-blocking: any failure (server down, bad secret,
missing `jq`) is swallowed and Claude Code continues normally.

## Deployment

The app is a single Node.js process; the only external state is an optional
SQLite file (`DB_PATH`). It runs on any host that can expose a port (Fly.io,
Render, Railway, Cloud Run, a VPS, etc.).

```bash
npm ci --omit=dev && npm run build
PUBLIC_URL=https://claude-status.example.com \
WEBHOOK_SECRET=$(openssl rand -hex 32) \
  npm start
```

Put a TLS-terminating reverse proxy in front (nginx, Caddy, your platform's
load balancer) and set `TRUST_PROXY=1`. SSE requires buffering to be disabled —
the server sets `X-Accel-Buffering: no`, which most proxies honor.

## Self-hosting with TLS

The repo ships a ready-made Caddy setup ([`deploy/Caddyfile`](deploy/Caddyfile))
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
automatically and proxies to the app with streaming enabled so SSE works out
of the box. Without the profile (`docker compose up -d`) the app is served
plain on host port `${PORT:-3000}`.

By default the compose file persists the SQLite database to `./data` on the
host (`DB_PATH=/app/data/agstatus.db`). The container runs as an unprivileged
user (uid 1000), so on Linux create the directory first:
`mkdir -p data && sudo chown 1000:1000 data`. Set `DB_PATH=` (empty) in `.env`
to run purely in-memory instead.

## Project layout

```
claude-status/
├── src/
│   ├── app.ts                   # Express app factory (routes, SSE)
│   ├── config.ts                # Env parsing (MULTI_TENANT, DB_PATH, TTLs)
│   ├── store.ts                 # Sessions/workspaces store + SQLite persistence
│   └── server.ts                # Entry point: env config + listen
├── public/
│   ├── index.html               # Dashboard shell
│   ├── styles.css               # Responsive, landscape-phone tuned
│   └── app.js                   # SSE client + rendering
├── hooks/
│   └── claude-status-hook.sh    # Claude Code hook → webhook (manual/bash setup)
├── cli/                         # `npx agstatus` — one-command setup CLI
│   ├── src/                     # init/status/uninstall + settings.json merge
│   └── assets/agstatus-hook.js  # dependency-free Node hook installed by init
├── deploy/
│   └── Caddyfile                # TLS reverse proxy (compose --profile tls)
├── test/                        # Vitest suite (legacy, workspaces, limits, SSE, persistence)
├── vitest.config.ts
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## License

MIT.
