# HTTP API reference

The server runs in one of two modes:

- **Legacy (single-tenant)** — the default. One global board; the endpoints
  under [Legacy endpoints](#legacy-single-tenant-endpoints) apply.
- **Multi-tenant** (`MULTI_TENANT=true`) — boards ("workspaces") live under
  `/w/<token>/...`. The global `/webhook`, `/events`, `/api/sessions`, and
  `/sessions/...` endpoints return `404`. The hosted instance at
  `https://agstatus.online` runs in this mode.

`GET /api/config` tells you which mode a server is in.

## The session object

```json
{
  "id": "sess-abc",
  "name": "Refactor auth",
  "status": "coding",
  "message": "Editing server.ts",
  "project": "my-repo",
  "source": "claude",
  "host": {
    "machine": { "id": "9f2c1b7e4d3a8f0c5e6b2a1d9c8f7e6b", "name": "Mac" },
    "app": { "slug": "herdr", "name": "herdr", "kind": "multiplexer" }
  },
  "createdAt": 1752096000000,
  "updatedAt": 1752096030000
}
```

Timestamps are epoch milliseconds. `status` is one of `idle`, `planning`,
`coding`, `testing`, `blocked`, `done`. `host` says where the session runs
(see the [webhook table](#webhook-body-and-validation)); it is `null` for
the many sessions whose hook has not opted in, and the key is always present.

## Shared endpoints (both modes)

| Method & path     | Purpose |
| ----------------- | ------- |
| `GET /api/config` | `{mode: "legacy"\|"multi", version, statuses, push}`. Legacy mode adds `webhookUrl` and `requiresSecret`. `push` is `true` iff APNs is configured. |
| `GET /healthz`    | Liveness probe: `{ok: true, version}`. Legacy mode adds a `sessions` count. |
| `GET /`           | Dashboard UI shell (in multi-tenant mode the board itself is at `/w/<token>`). |

## Webhook body and validation

`POST /webhook` (legacy) and `POST /w/<token>/webhook` (multi-tenant) accept
the same JSON body and upsert a session by `session_id`:

| Field        | Type   | Required | Notes |
| ------------ | ------ | -------- | ----- |
| `session_id` | string | yes      | Unique session identifier. Must match `^[A-Za-z0-9._:-]{1,128}$`. |
| `status`     | enum   | yes      | One of `idle`, `planning`, `coding`, `testing`, `blocked`, `done`. |
| `name`       | string | no       | Human-readable title. Defaults to `session_id` if omitted. Truncated to 120 chars. |
| `message`    | string | no       | Short description of the current activity (shown on the card). Truncated to 300 chars. |
| `project`    | string | no       | Project or repo the session is working on. Truncated to 120 chars. |
| `source`     | string | no       | Agent kind that owns the session, e.g. `claude` or `codex` (same regex as the usage `source`). Defaults to `claude`; omitted on update = carried forward. Dashboards use it to show only the limit bars of agents present on the board. |
| `host`       | object \| null | no | Where the session runs, sent by hooks that opted in to Focus: `{"machine": {"id", "name"}, "app": {"slug", "name", "kind"}}`. Omitted = carried forward; `null` = cleared (the hook opted out). `machine.id` must match `^[0-9a-f]{32}$` (a per-board hash, never a raw machine id) or the post is `400`. `machine.name` and `app.name` are trimmed and truncated to 32 chars; blank ones become `Machine` and the slug. `app.slug` is one of `agterm`, `iterm2`, `kitty`, `wezterm`, `terminal`, `ghostty`, `alacritty`, `warp`, `vscode`, `cursor`, `windsurf`, `jetbrains`, `zed`, `claude-desktop`, `codex-desktop`, `herdr`, `tmux`, `zellij`, `screen`, `windows-terminal`, `other` — anything else is stored as `other`; `app.kind` is one of `terminal`, `multiplexer`, `ide`, `desktop-app`, `unknown` — anything else becomes `unknown`. Every other key is dropped. |

Control characters are stripped from all string fields. Omitted optional
fields carry the previous value forward on update. The JSON body is capped at
16 KB. `host` is the one nullable field: it goes out as `null` on every
session that has none (REST and SSE alike), and it is scrubbed from the
stored row whenever a session is dismissed, evicted, expired or its
workspace deleted. It never appears in the session timeline or in push
notifications.

**Response** — `200 OK`:

```json
{ "ok": true, "session": { "id": "sess-abc", "status": "coding", ... } }
```

**Errors** — `400` on missing/malformed `session_id`, invalid `status`,
malformed `source`, or a `host` that is neither an object nor `null` or whose
`machine.id` fails the regex; `401` on bad secret (legacy mode with
`WEBHOOK_SECRET` set); `404` unknown
workspace (multi-tenant); `413` on bodies over 16 KB; `429` over the
per-workspace rate limit (multi-tenant).

## Plan usage

`POST /usage` (legacy, same secret rules as the webhook) and
`POST /w/<token>/usage` (multi-tenant) let a hook report how much of an
agent plan's rate limits is consumed, so dashboards can draw limit bars:

```json
{
  "source": "claude",
  "windows": [
    { "id": "session", "label": "Current session", "usedPct": 42, "resetsAt": 1752100000000 },
    { "id": "week", "label": "Weekly (all models)", "usedPct": 61.5, "resetsAt": 1752300000000 }
  ]
}
```

| Field      | Type   | Required | Notes |
| ---------- | ------ | -------- | ----- |
| `source`   | string | yes      | Agent kind, e.g. `claude` or `codex`. Must match `^[a-z][a-z0-9_-]{0,23}$`. |
| `windows`  | array  | yes      | 1–6 windows with unique `id`s (`^[a-z][a-z0-9_-]{0,31}$`). |
| `usedPct`  | number | yes      | Percent of the limit consumed. Clamped to 0–100. |
| `label`    | string | no       | Display name; defaults to `id`. Truncated to 48 chars. |
| `resetsAt` | number | no       | Epoch ms when the window resets; anything invalid becomes `null`. |

The server keeps the latest report per `source` (a re-post replaces the
previous one), broadcasts the full usage list as an SSE `usage` event, and
answers `{ok: true}`. Usage posts share the webhook rate-limit budget.
Reports older than 24 hours are dropped from reads — stale percentages
mislead. `GET /api/usage` (legacy) and `GET /w/<token>/api/usage` return the
current list:

```json
[ { "source": "claude", "windows": [ ... ], "updatedAt": 1752096030000 } ]
```

## Usage history and per-project spend

Two series back the usage detail screen, and they are **different measures**.

**The limit over time.** Every report is kept, not just the newest, but only
when a window's `usedPct` actually moved — a plan limit is a step function and
reports arrive far more often than it changes. Nothing is retroactive: a board
has limit history from the moment it first receives a report.

**Where the tokens went.** Neither agent's usage API says which project spent
the quota, so the hook derives it from the logs each agent already writes
locally and reports daily totals with `POST /usage/projects` (legacy, same
secret rules as the webhook) or `POST /w/<token>/usage/projects`:

```json
{
  "source": "claude",
  "days": [
    { "project": "jobsearch", "day": "2026-09-07", "tokens": 87600000 },
    { "project": "claude-status", "day": "2026-09-07", "tokens": 18700000 }
  ]
}
```

| Field     | Type   | Required | Notes |
| --------- | ------ | -------- | ----- |
| `source`  | string | yes      | Agent kind, same rule as plan usage. |
| `days`    | array  | yes      | 1–200 rows. The cap keeps a report inside the 16kb body limit; a longer backfill sends several. |
| `project` | string | yes      | Project folder name, truncated to 120 chars. |
| `day`     | string | yes      | `YYYY-MM-DD`, UTC. |
| `tokens`  | number | yes      | Tokens spent that day. Clamped to ≥ 0 and floored. |

A day is **replaced**, not accumulated, so re-running a backfill converges
instead of double-counting. Reported tokens are input + output + cache
creation; cache reads are excluded because they are ~94% of raw token volume
but a small share of what a plan limit charges.

`GET /api/usage/history` and `GET /w/<token>/api/usage/history` return both
series. `?days=N` selects the range (default 30, capped at 90):

```json
{
  "days": 30,
  "history": [
    { "source": "claude", "windowId": "week",
      "points": [ { "at": 1752096030000, "usedPct": 54 } ] }
  ],
  "projects": [
    { "source": "claude", "project": "jobsearch", "day": "2026-09-07", "tokens": 87600000 }
  ]
}
```

Each series keeps the last reading from *before* the requested range as its
first point, so a step chart has a value to start from. Both are retained for
90 days.

## Session history

`GET /api/sessions/:id/history` (legacy) and
`GET /w/<token>/api/sessions/:id/history` return a session's timeline —
one entry per status/message transition, newest first (identical
keep-alive re-posts are not recorded):

```json
[
  { "seq": 2, "status": "testing", "message": "npm test", "at": 1752096030000 },
  { "seq": 1, "status": "coding", "message": "Editing server.ts", "at": 1752096010000 },
  { "seq": 0, "status": "idle", "message": "Session started", "at": 1752096000000 }
]
```

`seq` increases monotonically per session and is a stable identity for
clients. The last 100 entries are kept per session (older ones are
soft-deleted); dismissing or expiring a session drops its history. Unknown
sessions return `[]`.

## Focus commands

Focus lets a tap on a card bring the session's terminal to the front on the
machine running it (design: [docs/design/focus-protocol.md](design/focus-protocol.md)).
Three parties take part: a **viewer** (the phone or web board), the
**server**, and a **listener** — the AgStatus process on each machine that
opted in. A session can be focused only when its `host` is set and that
machine's listener is online.

```
viewer   ─▶ POST …/commands {id, type, session_id}      server attaches machine_id from session.host
server   ─▶ SSE `command` ─▶ listener                     only the listener for that machine
listener ─▶ POST …/commands/:id/claim                    exactly-once, then acts locally
listener ─▶ POST …/commands/:id/ack {result, reach, reason}
server   ─▶ SSE `command_ack` ─▶ everyone                 or {result: "failed", reason: "expired"} at the TTL
viewer   ─▶ GET …/commands/:id                           polling, for a phone that backgrounded
```

Commands carry **ids only** — never a path, a binary or an argument — and
live **in memory only**, like pairing codes: a restart drops them, and the
phone simply sees its command time out. The paths below are shown for
multi-tenant mode; legacy mode mounts the same handlers at the root
(`POST /commands`, `POST /commands/:id/claim`, …) with the `POST`s behind
`X-Webhook-Secret` when `WEBHOOK_SECRET` is set, like the webhook.

### Listener presence

A listener subscribes to the ordinary event stream with a `listener` query
parameter and the machine's key:

```
GET /w/<token>/events?listener=<machine_id>&key=<machine_key>&name=<label>
```

| Param      | Rule |
| ---------- | ---- |
| `listener` | Required. The machine id the hook reports in `host.machine.id`; must match `^[0-9a-f]{32}$` (`400` otherwise). |
| `key`      | Required. The **machine key**: 64 lowercase hex, the value the id is derived from (`machine_id = sha256(key)[0..32]`, see the [design](design/focus-protocol.md#32-wire-summary--the-host-webhook-field)). `400` when malformed; `403 {"error": "wrong_key"}` when it does not hash to `listener`. Only the machine holds the key — every viewer sees the id in the snapshot, so the id alone proves nothing, and a viewer can neither take a machine's slot nor end its stream. |
| `name`     | Label shown on the board; control characters stripped, trimmed, truncated to 32 chars; blank → `Machine`. Nothing else from the query reaches the board. |

Listener slots are separate from the 10 viewer slots: at most **5 listeners
per workspace** (`429 {"error": "too many listeners"}` for a 6th machine),
one per `machine_id` — a new connection for a machine that is already
connected replaces the old stream (the old one is ended without an
`offline` event). Connects are limited to **30/min per workspace**
(`429 {"error": "rate limit exceeded"}`; the listener should sleep 60 s),
since every one is broadcast to every viewer. On connect the listener
receives `snapshot`, then a `commands` frame with the unclaimed commands
waiting for that machine, and every viewer (and listener) receives
`machine {online: true}`. When the stream closes everyone receives
`machine {online: false}`. After that the listener gets every event a viewer
gets, plus `command` frames addressed to its machine, and the same 25 s
keepalive.

`GET /w/<token>/api/machines` (legacy: `GET /api/machines`) returns the
machines currently online, the same array a viewer gets in its `machines`
frame — id, label, and since when; no platform or version:

```json
[ { "id": "9f2c…", "name": "MacBook", "online": true, "since": 1752096000000 } ]
```

### Command endpoints

| Method & path                          | Purpose |
| -------------------------------------- | ------- |
| `POST /w/<token>/commands`             | Send a command. Body `{"id": "<client uuid>", "type": "focus"\|"resume", "session_id": "<id>"}`. `id` is a UUID the client mints (normalized to lowercase) so a retry can be told from a second tap. `200 {id, delivered, expires_in_ms}` — `delivered` is whether a listener for the session's machine is connected right now. |
| `POST /w/<token>/commands/:id/claim`   | Listener only. Body `{"machine_key": "<64 hex>"}` — the key of the machine the command was routed to (see [presence](#listener-presence)). Moves `pending → claimed`; a second claim fails, so execution is exactly-once across a LaunchAgent and a stray manual run. `200 {ok: true, expires_in_ms}`. Nothing is broadcast. |
| `POST /w/<token>/commands/:id/ack`     | Listener only. Body `{"machine_key", "result", "reach"?, "reason"?}` — **enums only, no other keys** (see below). Moves `claimed → done`, answers `200 {ok: true}` and broadcasts `command_ack`. |
| `GET /w/<token>/commands/:id`          | `200 {id, type, session_id, machine_id, state, result, reach, reason, created_at, expires_at, claimed_at, done_at}` (unset values are `null`); `404` when unknown or already swept. |

**Status codes.** `POST /commands`: `400` on a malformed `id`, `type` or
`session_id`; `404 {"error": "unknown_session"}`; `409 {"error": "no_host"}`
when the session's hook has not opted in to Focus; `409 {"error": "duplicate_id"}`;
`429 {"error": "rate limit exceeded"}` past 10 commands/min per workspace;
`429 {"error": "too_many_pending"}` at 10 pending commands per workspace (a
re-tap on a card that is already waiting replaces its predecessor and is not
counted). `claim`: `400` bad `machine_key`; `404 {"error": "not_found"}`;
`403 {"error": "wrong_machine"}` when `machine_key` is not the key of the
machine the command was routed to — the public `machine_id` is no
credential; `409 {"error": "already_claimed"}` unless the command is pending;
`410 {"error": "expired"}`. `ack`: `400` on an unknown body key, a bad
`machine_key`, a value outside its enum, or `result: "failed"` without a
`reason`; `404`/`403` as for claim; `409 {"error": "not_claimed"}` while
still pending; `409 {"error": "already_done"}`; `410 {"error": "expired"}`.

**Enums.** `type` ∈ `focus | resume`. `result` ∈
`focused | activated | selected | resumed | failed`. `reach` (how far the
listener got) ∈ `pane | tab | window | app | thread`. `reason` (required when
`result` is `failed`) ∈ `no-record | remote | not-running | app-not-running |
consent-needed | mux-detached | ambiguous | unsupported-host | bad-record |
respawn-failed | unsupported-type | superseded | expired`. There is no free
text anywhere on this channel: a message field would put the machine's cwd,
tty or stderr in front of every board viewer.

**Lifecycle.** `pending → claimed → done`, or `→ expired` from either live
state once `COMMAND_TTL_MS` (default 120000, 2 minutes; whole milliseconds,
at least 1000) has passed — the server then broadcasts
`command_ack {result: "failed", reason: "expired"}` so every command
terminates observably. A session that leaves the board (dismissed, cleared,
evicted or expired) takes its pending commands with it: each is finished as
`failed / superseded` and its `command_ack` follows the `remove` (or
`snapshot`) event, so the listener never raises a window for a card nobody
is looking at; a claimed one is left to ack or expire. The `machine_id` always comes from
`session.host` on the server; a client cannot aim a command at a machine of
its choosing. A second command for the same `(session_id, type, machine_id)`
while the first is still pending **supersedes** it: the older one is
finished as `failed / superseded` (its `command_ack` is broadcast) and the
new one goes out. Done and expired commands stay readable through `GET` for
10 minutes, then are forgotten.

## Legacy (single-tenant) endpoints

| Method & path          | Purpose                                        | Auth |
| ---------------------- | ---------------------------------------------- | ---- |
| `POST /webhook`        | Create/update a session (see above; `host` included). | yes* |
| `POST /usage`          | Report plan usage (see [Plan usage](#plan-usage)). | yes* |
| `POST /usage/projects` | Report per-project token spend (see [Usage history](#usage-history-and-per-project-spend)). | yes* |
| `GET /events`          | SSE stream (see [format](#sse-event-format)); `?listener=` subscribes a Focus listener (see [presence](#listener-presence)). | no; yes* with `?listener=` |
| `GET /api/sessions`    | JSON list of all sessions.                     | no   |
| `GET /api/machines`    | Focus listeners currently online.              | no   |
| `POST /commands`       | Send a Focus command (see [Focus commands](#focus-commands)). | yes* |
| `POST /commands/:id/claim` | Listener claims a command.                 | yes* |
| `POST /commands/:id/ack` | Listener reports the outcome.                | yes* |
| `GET /commands/:id`    | Command state, for polling.                    | no   |
| `GET /api/usage`       | Current plan usage list.                       | no   |
| `GET /api/usage/history` | Limit history + per-project spend.           | no   |
| `GET /api/sessions/:id/history` | Session timeline (see [Session history](#session-history)). | no |
| `DELETE /sessions/:id` | Remove one session. Returns `{ok: boolean}`.   | no   |
| `POST /sessions/clear` | Remove all sessions. Returns `{ok: true}`.     | yes* |

\* Only when `WEBHOOK_SECRET` is configured: send `X-Webhook-Secret: <value>`,
else `401`. Reads and `DELETE /sessions/:id` stay open so the dashboard can
list and dismiss cards. Focus is otherwise identical in legacy mode.

## Multi-tenant: workspace endpoints

There are no accounts — a workspace is identified by an unguessable token
embedded in its URLs (`ags_` + 32 URL-safe characters). Anyone who has the
URL can view and update that workspace; treat it like a secret. The server
stores only a SHA-256 hash of the token; the raw token is returned exactly
once, at creation.

### Create a workspace

```bash
curl -X POST https://agstatus.online/api/workspaces
```

**Response** — `201 Created`:

```json
{
  "ok": true,
  "token": "ags_...",
  "dashboardUrl": "https://.../w/ags_...",
  "webhookUrl": "https://.../w/ags_.../webhook"
}
```

Save the token — it is not shown again. Creation is rate limited to 20 per
hour per IP (`429` beyond) and returns `503` at the `MAX_WORKSPACES` cap.

### Workspace-scoped endpoints

Everything under `/w/<token>/...` mirrors the legacy API, scoped to one
workspace:

| Method & path                    | Purpose |
| -------------------------------- | ------- |
| `GET /w/<token>`                 | Dashboard UI for this workspace. |
| `GET /w/<token>/api/sessions`    | JSON list of the workspace's sessions (newest first). |
| `GET /w/<token>/events`          | SSE stream (see [format](#sse-event-format)). `429` past 10 concurrent connections. `?listener=<machine_id>` subscribes a Focus listener instead, in its own slot budget (see [presence](#listener-presence)). |
| `POST /w/<token>/webhook`        | Create/update a session (same body as legacy, `host` included). `200` with `{ok, session}`; `400` on validation errors; `429` over the rate limit. |
| `POST /w/<token>/usage`          | Report plan usage (see [Plan usage](#plan-usage)). |
| `POST /w/<token>/usage/projects` | Report per-project token spend (see [Usage history](#usage-history-and-per-project-spend)). |
| `GET /w/<token>/api/usage`       | Current plan usage list. |
| `GET /w/<token>/api/usage/history` | Limit history + per-project spend. `?days=N` (default 30, max 90). |
| `GET /w/<token>/api/sessions/:id/history` | Session timeline (see [Session history](#session-history)). |
| `GET /w/<token>/api/machines`    | Focus listeners currently online (see [presence](#listener-presence)). |
| `POST /w/<token>/commands`       | Send a Focus command (see [Focus commands](#focus-commands)). |
| `POST /w/<token>/commands/:id/claim` | Listener claims a command. |
| `POST /w/<token>/commands/:id/ack` | Listener reports the outcome. |
| `GET /w/<token>/commands/:id`    | Command state, for polling. |
| `DELETE /w/<token>/sessions/:id` | Remove one session. Returns `{ok: boolean}`. |
| `POST /w/<token>/sessions/clear` | Remove all sessions in the workspace. Returns `{ok: true}`. |
| `DELETE /w/<token>`              | Delete the whole workspace: all sessions, device registrations and pending commands removed, event and listener streams closed. Returns `{ok: true}`. |

Any request with an invalid or unknown token returns
`404 {"error": "unknown workspace"}`. All `/w/...` routes send permissive
CORS headers (`Access-Control-Allow-Origin: *`; methods
`GET,POST,DELETE,OPTIONS`; `OPTIONS` answers `204`) — the token in the path
is the credential, so origins add nothing.

### Pairing endpoints

Pairing lets a device that owns a workspace (e.g. the iOS app) hand it to
another machine (the CLI) via a short, typeable code. Codes are 8 characters
from an ambiguity-free alphabet (no `I`/`L`/`O`/`0`/`1`), displayed grouped
as `XXXX-XXXX`, single-use, held in memory only, and expire after 15 minutes.

| Method & path          | Purpose |
| ---------------------- | ------- |
| `POST /w/<token>/pair` | Create a pairing code for this workspace. `201` with `{ok: true, code: "XXXX-XXXX", expiresInSeconds: 900}`. Max 3 outstanding codes per workspace (`429` beyond); creating a new code does not invalidate the others. |
| `POST /api/pair/claim` | Body `{"code": "XXXX-XXXX"}` (case, dashes, and whitespace are normalized away). `200` with the same `{ok, token, dashboardUrl, webhookUrl}` shape as workspace creation; the code is consumed. `400` on a missing/non-string code; `404` on unknown/expired/already-used codes. Rate limited to 10 attempts per minute per IP (`429`). |

### Device (push) endpoints

Multi-tenant mode only. Devices register per workspace to receive APNs
notifications; see [docs/self-hosting.md](self-hosting.md#push-notifications-apns)
for the server-side setup and trigger rules.

| Method & path                            | Purpose |
| ---------------------------------------- | ------- |
| `POST /w/<token>/devices`                | Register/update a device. Body: `{"device_token": "<hex>", "platform": "ios", "notify_done": false}`. `device_token` must match `^[0-9a-fA-F]{16,200}$` and `platform` must be `"ios"` (`400` otherwise). Upserts by (workspace, token) — re-POST updates `notify_done`. Max 10 devices per workspace: `429` for a new device past the cap; updates to existing devices always succeed. Returns `{ok: true}`. |
| `DELETE /w/<token>/devices/:deviceToken` | Unregister. Returns `{ok: boolean}`. |

Deleting the workspace purges its device registrations. Tokens Apple reports
as expired or unregistered are pruned automatically.

## SSE event format

`GET /events` (legacy) and `GET /w/<token>/events` (multi-tenant) are
standard `text/event-stream` responses:

```
event: snapshot
data: [ { ...session }, ... ]

event: session
data: { ...session }

event: remove
data: { "id": "sess-abc" }

event: usage
data: [ { "source": "claude", "windows": [ ... ], "updatedAt": 1752096030000 } ]

event: machines
data: [ { "id": "9f2c…", "name": "MacBook", "online": true, "since": 1752096000000 } ]

event: machine
data: { "id": "9f2c…", "name": "MacBook", "online": true, "since": 1752096000000 }

event: machine
data: { "id": "9f2c…", "online": false, "lastSeen": 1752096900000 }

event: commands
data: [ { "id": "6c1f…", "type": "focus", "session_id": "sess-abc", "machine_id": "9f2c…", "expires_in_ms": 98000 } ]

event: command
data: { "id": "6c1f…", "type": "focus", "session_id": "sess-abc", "machine_id": "9f2c…", "expires_in_ms": 120000 }

event: command_ack
data: { "id": "6c1f…", "session_id": "sess-abc", "machine_id": "9f2c…", "type": "focus", "result": "focused", "reach": "tab", "reason": null }

: keepalive
```

- `snapshot` — the full session list. Sent once on connect and again (empty)
  after `sessions/clear` or workspace deletion.
- `session` — a session was created or updated.
- `remove` — a session was deleted, evicted, or expired.
- `usage` — the full plan-usage list (see [Plan usage](#plan-usage)). Sent
  on connect when non-empty, and after every usage report.
- `machines` — every Focus listener currently online. Sent to viewers once,
  right after `snapshot` (an empty array when none is connected).
- `machine` — a listener came online (`{id, name, online: true, since}`) or
  went away (`{id, online: false, lastSeen}`). Sent to everyone.
- `commands` — the unclaimed commands waiting for a listener's machine. Sent
  to that listener once, right after its `snapshot`.
- `command` — a new command for the listener's machine. Sent **only** to
  that listener; viewers never see it.
- `command_ack` — a command finished: the listener acked it, a re-tap or the
  session's removal superseded it, or it expired
  (`{result: "failed", reason: "expired"}`). Sent to everyone. See
  [Focus commands](#focus-commands).
- A `: keepalive` comment line is sent every 25 s, on listener streams too.

The server sets `Cache-Control: no-cache, no-transform` and
`X-Accel-Buffering: no` so reverse proxies don't buffer the stream. When a
workspace is deleted, its open streams receive a final empty `snapshot` and
are closed.

## Limits

To keep a shared instance healthy, multi-tenant workspaces are capped:

| Limit | Value | Behavior at the limit |
| ----- | ----- | --------------------- |
| Sessions per workspace | 50 | A new session evicts the oldest-updated one (a `remove` event is broadcast for it). |
| Concurrent SSE connections per workspace | 10 | The 11th gets `429` before the stream starts. |
| Webhook requests per workspace | 120/min | `429`. |
| Devices per workspace | 10 | `429` for new devices. |
| Outstanding pairing codes per workspace | 3 | `429`. |
| Focus commands per workspace | 10/min | `429` (its own budget, separate from the webhook's). |
| Pending Focus commands per workspace | 10 | `429 {"error": "too_many_pending"}`. |
| Focus listeners per workspace | 5 (one per machine) | `429` for a 6th machine; a reconnect replaces the machine's old stream. |
| Focus listener connects per workspace | 30/min | `429`; the listener sleeps 60 s. |
| Focus command TTL | 2 min (`COMMAND_TTL_MS`) | Unclaimed or unacked commands fail as `expired` (a `command_ack` is broadcast); finished ones are forgotten 10 min later. Commands are in memory only — a restart drops them. |
| Workspace creations | 20/hour/IP | `429`. |
| Pair-code claims | 10/min/IP | `429`. |
| Session TTL | 24 h (`SESSION_TTL_MS`) | Expired sessions are swept and `remove` events broadcast. |
| Idle workspaces | 60 days | Deleted by a periodic sweep (every 6 hours). |
| Live workspaces | `MAX_WORKSPACES` (default 10000) | Creation returns `503`. |
| Request body | 16 KB | `413`. |

In both modes: `name`/`project` truncate to 120 chars, `message` to 300,
`host.machine.name`/`host.app.name` to 32; control characters are stripped.
Push alerts per (session, kind) are debounced to one per minute.
