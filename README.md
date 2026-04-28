# Claude Status Dashboard

A tiny webhook-driven dashboard for tracking the status of your Claude Code
sessions at a glance. Push status updates from each session; the page shows
them live, color-coded, and mobile-friendly.

![statuses](https://img.shields.io/badge/statuses-idle%20%7C%20planning%20%7C%20coding%20%7C%20testing%20%7C%20blocked%20%7C%20done-blueviolet)

![Dashboard screenshot](docs/dashboard.png)

## Features

- **Webhook ingestion** — POST status updates from anywhere.
- **Live updates** — Server-Sent Events push changes to the browser instantly.
- **Color-coded statuses** — `idle`, `planning`, `coding`, `testing`, `blocked`, `done`.
- **Mobile optimized** — fluid grid that collapses to a single column in portrait
  and packs horizontally in landscape.
- **Configurable** — public URL, port, and optional shared-secret auth via env vars.
- **Zero database** — sessions live in memory, with optional TTL-based expiry.

## Quick start

```bash
npm install
npm run dev           # hot reload via tsx
# or
npm run build && npm start
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
| `WEBHOOK_SECRET`  | _(unset)_                 | If set, mutating requests must send `X-Webhook-Secret: <value>`.        |
| `SESSION_TTL_MS`  | `0` (disabled)            | Auto-remove sessions not updated for this many ms.                      |

## Webhook API

### `POST /webhook`

Creates or updates a session. Upserts by `session_id`.

**Headers**
- `Content-Type: application/json`
- `X-Webhook-Secret: <value>` — required only if `WEBHOOK_SECRET` is configured.

**Body**

| Field        | Type   | Required | Notes                                                                 |
| ------------ | ------ | -------- | --------------------------------------------------------------------- |
| `session_id` | string | yes      | Unique identifier for the session.                                    |
| `status`     | enum   | yes      | One of `idle`, `planning`, `coding`, `testing`, `blocked`, `done`.    |
| `name`       | string | no       | Human-readable title. Defaults to `session_id` if omitted.            |
| `message`    | string | no       | Short description of the current activity (shown on the card).        |
| `project`    | string | no       | Project or repo the session is working on.                            |

**Response** — `200 OK`

```json
{ "ok": true, "session": { "id": "sess-abc", "status": "coding", ... } }
```

**Errors** — `400` on missing `session_id` or invalid status; `401` on bad secret.

### Other endpoints

| Method & path              | Purpose                                        | Auth |
| -------------------------- | ---------------------------------------------- | ---- |
| `GET /`                    | Dashboard UI.                                  | no   |
| `GET /events`              | SSE stream: `snapshot`, `session`, `remove`.   | no   |
| `GET /api/sessions`        | JSON list of all sessions.                     | no   |
| `GET /api/config`          | Webhook URL + auth flag (used by the UI).      | no   |
| `GET /healthz`             | Liveness probe.                                | no   |
| `DELETE /sessions/:id`     | Remove one session.                            | yes  |
| `POST /sessions/clear`     | Remove all sessions.                           | yes  |

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

The repo includes a ready-to-use hook script at
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

The app is a single Node.js process with no external dependencies. It runs on
any host that can expose a port (Fly.io, Render, Railway, Cloud Run, a VPS, etc.).

```bash
npm ci --omit=dev && npm run build
PUBLIC_URL=https://claude-status.example.com \
WEBHOOK_SECRET=$(openssl rand -hex 32) \
  npm start
```

Put a TLS-terminating reverse proxy in front (nginx, Caddy, your platform's
load balancer). SSE requires buffering to be disabled — the server sets
`X-Accel-Buffering: no`, which most proxies honor.

## Project layout

```
claude-status/
├── src/
│   └── server.ts                # Express + SSE + webhook
├── public/
│   ├── index.html               # Dashboard shell
│   ├── styles.css               # Responsive, landscape-phone tuned
│   └── app.js                   # SSE client + rendering
├── hooks/
│   └── claude-status-hook.sh    # Claude Code hook → webhook
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## License

MIT.
