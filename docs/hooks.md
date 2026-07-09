# Claude Code integration

AgStatus watches your agents through Claude Code's
[hook system](https://code.claude.com/docs/en/hooks): a small script receives
each hook event on stdin and posts a status webhook to your board. Two ways
to set it up:

1. **`npx agstatus init`** (recommended) — installs a dependency-free Node
   hook and wires everything up in one command.
2. **Manual bash hook** — the original `hooks/claude-status-hook.sh`, for
   people who want to see and customize every moving part.

Both hooks are deliberately non-blocking: any failure (server down, bad
secret, malformed payload) is swallowed and Claude Code continues normally.
The Node hook additionally enforces a 3 s HTTP timeout and a ~4 s overall
safety timeout.

## `npx agstatus init`

```bash
npx agstatus init
```

> Until the package is published to npm, run it from a clone of this repo:
>
> ```bash
> npm --prefix cli install && npm --prefix cli run build && node cli/dist/cli.js init
> ```

What it does, in order:

1. Contacts the server (`GET /api/config`) — the hosted instance by default.
2. Acquires a board: claims your pairing code (`--code`), creates a new
   private board (multi-tenant servers), or targets the server's single board
   (legacy servers).
3. Copies the hook to `~/.claude/hooks/agstatus-hook.js` (plain Node,
   no dependencies).
4. Merges the hook registrations and env vars into `~/.claude/settings.json`,
   writing a backup to `settings.json.agstatus-backup` first. Your existing
   settings and hooks are preserved; re-running `init` replaces only the
   AgStatus entries.
5. Prints your dashboard URL and a QR code to open it on your phone.

### Flags

| Flag               | Purpose |
| ------------------ | ------- |
| `--url <base>`     | Server to use (default: `https://claude-status.kardan.ddns.net`; the `AGSTATUS_URL` env var also overrides it, with `--url` winning). |
| `--code XXXX-XXXX` | Pair with a board created elsewhere (e.g. the iOS app) instead of creating a new one. Case and dashes don't matter. |
| `--secret <s>`     | Webhook secret for self-hosted single-tenant servers that set `WEBHOOK_SECRET` (stored as `CLAUDE_STATUS_SECRET`). |
| `--minimal`        | Privacy mode: send tool names only, never command text (sets `AGSTATUS_DETAIL=off`; re-running without the flag removes it). |
| `--no-qr`          | Skip the QR code (narrow terminals, scripts). |

### Pairing codes

Boards created elsewhere can hand you a short-lived code instead of a URL:
the board owner taps "Pair your computer" in the iOS app (or calls
`POST /w/<token>/pair`) and gets a single-use code valid for 15 minutes
(max 3 outstanding per board). `agstatus init --code XXXX-XXXX` exchanges it
via `POST /api/pair/claim` for the board's URLs. Claims are rate limited to
10/min/IP. Details in [docs/api.md](api.md#pairing-endpoints).

### Other commands

```bash
npx agstatus status      # show configured URL, hook file, server reachability + session count
npx agstatus uninstall   # remove the hook file and AgStatus settings entries (backup kept)
npx agstatus help        # usage
```

`uninstall` removes only AgStatus's hook registrations and the
`CLAUDE_STATUS_URL` / `CLAUDE_STATUS_SECRET` / `AGSTATUS_DETAIL` env keys —
everything else in `settings.json` is left untouched.

## How events map to statuses

Both the Node hook and the bash hook apply the same mapping:

| Hook event                                                     | Board status   | Notes |
| -------------------------------------------------------------- | -------------- | ----- |
| `SessionStart`                                                  | `idle`         | New session appears as soon as Claude starts. |
| `PreToolUse` — `Edit` / `Write` / `MultiEdit` / `NotebookEdit`  | `coding`       | Card shows the tool name. |
| `PreToolUse` — `Bash` (test runner)                             | `testing`      | Detected via `pytest`/`jest`/`vitest`/`go test`/`cargo test`/etc. |
| `PreToolUse` — `Bash` (other)                                   | `coding`       | Card shows the command, truncated to 120 chars (tool name only with `--minimal`). |
| `PreToolUse` — `Task` / `WebSearch` / `WebFetch`                | `planning`     | Investigation tools. |
| `Notification`                                                  | `blocked`      | Permission prompts and other attention-needed events — this is what triggers a push. |
| `Stop`                                                          | `idle`         | Turn finished, waiting for the next prompt. |
| `SessionEnd`                                                    | _card removed_ | The hook calls `DELETE /sessions/:id` so the card disappears. |

Other tools and events are ignored. The card `name` and `project` default to
the basename of the session's working directory, so multiple sessions are
easy to tell apart.

### Environment variables read by the hooks

| Variable               | Purpose |
| ---------------------- | ------- |
| `CLAUDE_STATUS_URL`    | Required. Base URL the hook posts to — a board URL (`https://<host>/w/<token>`) or a legacy server origin. The hook appends `/webhook` and `/sessions/<id>` itself, and tolerates a trailing `/` or `/webhook`. |
| `CLAUDE_STATUS_SECRET` | Optional. Sent as `X-Webhook-Secret` (legacy servers with `WEBHOOK_SECRET` set). Workspace boards don't need it — the token in the URL is the auth. |
| `AGSTATUS_DETAIL=off`  | Node hook only. Send tool names instead of command text (what `--minimal` sets). |

## Manual setup: the bash hook

The original hook at [`hooks/claude-status-hook.sh`](../hooks/claude-status-hook.sh)
does the same job with `curl` + `jq`, and is the easiest one to customize.

### 1. Prerequisites

- A reachable AgStatus server (see [docs/self-hosting.md](self-hosting.md)).
- `curl` and `jq` installed (`brew install jq` on macOS).

### 2. Install the script

```bash
mkdir -p ~/.claude/hooks
cp hooks/claude-status-hook.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/claude-status-hook.sh
```

### 3. Configure `~/.claude/settings.json`

For all sessions (user scope), edit `~/.claude/settings.json`. For one
project, use `.claude/settings.json` in that repo instead.

```json
{
  "env": {
    "CLAUDE_STATUS_URL": "https://status.example.com",
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

Replace `CLAUDE_STATUS_URL` with your server or board URL. Drop
`CLAUDE_STATUS_SECRET` if you didn't set `WEBHOOK_SECRET` on the server.

**Using a multi-tenant instance?** Point `CLAUDE_STATUS_URL` at your board:

```json
"CLAUDE_STATUS_URL": "https://<host>/w/<token>"
```

No script changes needed, and no secret — the token in the URL is the auth.

## Troubleshooting

Start a fresh Claude Code session in any project. The board should show a new
card transitioning through `idle → coding → idle` as you work. If it doesn't:

```bash
# Check the CLI-installed setup end to end:
npx agstatus status

# Run the Node hook manually with a fake payload (put your board URL first):
export CLAUDE_STATUS_URL='https://claude-status.kardan.ddns.net/w/ags_yourtoken'
echo '{"hook_event_name":"SessionStart","session_id":"manual-test","cwd":"'"$PWD"'"}' \
  | node ~/.claude/hooks/agstatus-hook.js

# Or the bash hook:
echo '{"hook_event_name":"SessionStart","session_id":"manual-test","cwd":"'"$PWD"'"}' \
  | ~/.claude/hooks/claude-status-hook.sh

# Tail Claude Code's logs (path may vary by OS):
tail -f ~/.claude/logs/*.log
```

A `manual-test` card appearing on the board means the hook and server are
fine and the problem is in `settings.json` — check that the `hooks` entries
survived any hand-edits, and remember Claude Code reads settings at session
start, so restart the session after changes.
