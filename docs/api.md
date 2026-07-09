# HTTP API reference

The server runs in one of two modes:

- **Legacy (single-tenant)** — the default. One global board; the endpoints
  under [Legacy endpoints](#legacy-single-tenant-endpoints) apply.
- **Multi-tenant** (`MULTI_TENANT=true`) — boards ("workspaces") live under
  `/w/<token>/...`. The global `/webhook`, `/events`, `/api/sessions`, and
  `/sessions/...` endpoints return `404`. The hosted instance at
  `https://claude-status.kardan.ddns.net` runs in this mode.

`GET /api/config` tells you which mode a server is in.

## The session object

```json
{
  "id": "sess-abc",
  "name": "Refactor auth",
  "status": "coding",
  "message": "Editing server.ts",
  "project": "my-repo",
  "createdAt": 1752096000000,
  "updatedAt": 1752096030000
}
```

Timestamps are epoch milliseconds. `status` is one of `idle`, `planning`,
`coding`, `testing`, `blocked`, `done`.

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

Control characters are stripped from all string fields. Omitted optional
fields carry the previous value forward on update. The JSON body is capped at
16 KB.

**Response** — `200 OK`:

```json
{ "ok": true, "session": { "id": "sess-abc", "status": "coding", ... } }
```

**Errors** — `400` on missing/malformed `session_id` or invalid `status`;
`401` on bad secret (legacy mode with `WEBHOOK_SECRET` set); `404` unknown
workspace (multi-tenant); `413` on bodies over 16 KB; `429` over the
per-workspace rate limit (multi-tenant).

## Legacy (single-tenant) endpoints

| Method & path          | Purpose                                        | Auth |
| ---------------------- | ---------------------------------------------- | ---- |
| `POST /webhook`        | Create/update a session (see above).           | yes* |
| `GET /events`          | SSE stream (see [format](#sse-event-format)).  | no   |
| `GET /api/sessions`    | JSON list of all sessions.                     | no   |
| `DELETE /sessions/:id` | Remove one session. Returns `{ok: boolean}`.   | no   |
| `POST /sessions/clear` | Remove all sessions. Returns `{ok: true}`.     | yes* |

\* Only when `WEBHOOK_SECRET` is configured: send `X-Webhook-Secret: <value>`,
else `401`. Reads and `DELETE /sessions/:id` stay open so the dashboard can
list and dismiss cards.

## Multi-tenant: workspace endpoints

There are no accounts — a workspace is identified by an unguessable token
embedded in its URLs (`ags_` + 32 URL-safe characters). Anyone who has the
URL can view and update that workspace; treat it like a secret. The server
stores only a SHA-256 hash of the token; the raw token is returned exactly
once, at creation.

### Create a workspace

```bash
curl -X POST https://claude-status.kardan.ddns.net/api/workspaces
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
| `GET /w/<token>/events`          | SSE stream (see [format](#sse-event-format)). `429` past 10 concurrent connections. |
| `POST /w/<token>/webhook`        | Create/update a session. `200` with `{ok, session}`; `400` on validation errors; `429` over the rate limit. |
| `DELETE /w/<token>/sessions/:id` | Remove one session. Returns `{ok: boolean}`. |
| `POST /w/<token>/sessions/clear` | Remove all sessions in the workspace. Returns `{ok: true}`. |
| `DELETE /w/<token>`              | Delete the whole workspace: all sessions and device registrations removed, event streams closed. Returns `{ok: true}`. |

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

: keepalive
```

- `snapshot` — the full session list. Sent once on connect and again (empty)
  after `sessions/clear` or workspace deletion.
- `session` — a session was created or updated.
- `remove` — a session was deleted, evicted, or expired.
- A `: keepalive` comment line is sent every 25 s.

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
| Workspace creations | 20/hour/IP | `429`. |
| Pair-code claims | 10/min/IP | `429`. |
| Session TTL | 24 h (`SESSION_TTL_MS`) | Expired sessions are swept and `remove` events broadcast. |
| Idle workspaces | 60 days | Deleted by a periodic sweep (every 6 hours). |
| Live workspaces | `MAX_WORKSPACES` (default 10000) | Creation returns `503`. |
| Request body | 16 KB | `413`. |

In both modes: `name`/`project` truncate to 120 chars, `message` to 300;
control characters are stripped. Push alerts per (session, kind) are
debounced to one per minute.
