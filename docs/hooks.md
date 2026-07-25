# Claude Code & Codex integration

AgStatus watches your agents through their hook systems — Claude Code's
[hooks](https://code.claude.com/docs/en/hooks) and OpenAI Codex's
[lifecycle hooks](https://developers.openai.com/codex/config-reference) use
the same shape (event JSON on stdin with `hook_event_name`, `session_id`,
`cwd`), so one small script serves both: it receives each event and posts a
status webhook to your board. Two ways to set it up:

1. **`npx agstatus init`** (recommended) — installs a dependency-free Node
   hook and wires up Claude Code, plus Codex when `~/.codex` exists.
2. **Manual bash hook** — the original `hooks/claude-status-hook.sh`, for
   people who want to see and customize every moving part (Claude Code only).

Both hooks are deliberately non-blocking: any failure (server down, bad
secret, malformed payload) is swallowed and the agent continues normally.
The Node hook additionally enforces a 3 s HTTP timeout, a ~4 s overall
safety timeout, and never writes to stdout (Codex interprets hook stdout as
behavior-control decisions).

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
| `--codex`          | Also set up OpenAI Codex even when `~/.codex` isn't detected (creates it). |
| `--no-codex`       | Skip Codex setup. Default: auto-configure when `~/.codex` exists. |
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

The Node hook applies this mapping. The bash hook covers the same Claude Code
events but predates Codex support, so it has no `PermissionRequest` or
`apply_patch` handling (the last two rows below are Codex-only):

| Hook event                                                     | Board status   | Notes |
| -------------------------------------------------------------- | -------------- | ----- |
| `SessionStart`                                                  | `idle`         | New session appears as soon as Claude starts. |
| `PreToolUse` — `Edit` / `Write` / `MultiEdit` / `NotebookEdit`  | `coding`       | Card shows the tool name. |
| `PreToolUse` — `Bash` (test runner)                             | `testing`      | Detected via `pytest`/`jest`/`vitest`/`go test`/`cargo test`/etc. |
| `PreToolUse` — `Bash` (other)                                   | `coding`       | Card shows the command, truncated to 120 chars (tool name only with `--minimal`). |
| `PreToolUse` — `Task` / `WebSearch` / `WebFetch`                | `planning`     | Investigation tools. |
| `Notification`                                                  | `blocked`      | Claude Code: permission prompts and other attention-needed events — this is what triggers a push. |
| `PermissionRequest`                                             | `blocked`      | Codex: fires before approval prompts — same push trigger. |
| `PreToolUse` — `apply_patch`                                    | `coding`       | Codex's file-edit tool; the card shows "Editing files". |
| `Stop`                                                          | `idle`         | Turn finished, waiting for the next prompt. |
| `SessionEnd`                                                    | _card removed_ | Claude Code only — the hook calls `DELETE /sessions/:id` so the card disappears. Codex has no session-end hook; its cards expire via the server's session TTL instead. |

Other tools and events are ignored. The card `name` and `project` default to
the basename of the session's working directory, so multiple sessions are
easy to tell apart.

## Plan-usage bars

The Node hook also feeds the dashboard's plan-limit bars (the 5-hour session
window and the weekly caps you see in `/usage` inside Claude Code):

1. On quiet events (`SessionStart`, `Stop`, `Notification` — never
   `PreToolUse`), at most once every 5 minutes, the hook reads the Claude
   Code OAuth token locally: `~/.claude/.credentials.json`, or the macOS
   login keychain (`Claude Code-credentials`). macOS may ask once to allow
   `security` access — choose "Always Allow".
2. It asks Anthropic's usage endpoint (`api.anthropic.com/api/oauth/usage`)
   for utilization percentages. The structured `limits` array is preferred
   (it carries model-scoped weekly caps such as **Fable**, which the legacy
   `five_hour`/`seven_day` keys never mention), with a fallback to those
   legacy keys for older responses.
3. It POSTs only the percentages and reset times to your board
   (`POST <board>/usage` — see [docs/api.md](api.md#plan-usage)). **The
   token itself never leaves your machine.**

Set `AGSTATUS_USAGE=off` in the settings `env` block to turn this off
entirely. The bash hook and Codex plans are not covered (the endpoint is
Claude-specific); a board simply shows no bars until something reports usage.

Dashboards only show the bars of agents that currently have sessions on the
board (each session carries a `source` tag: `claude`, or `codex` via the
`AGSTATUS_SOURCE=codex` prefix the Codex integration embeds) — a Claude-only
evening doesn't display Codex limits, and vice versa.

Caveat: the usage endpoint is undocumented and has changed before. The hook
degrades silently — unknown response shapes mean missing bars, never a
blocked agent.

## OpenAI Codex specifics

`agstatus init` configures Codex automatically when `~/.codex` exists
(`CODEX_HOME` is respected; `--no-codex` opts out, `--codex` forces it):

1. The same hook script is copied to `~/.codex/hooks/agstatus-hook.js`.
2. Hook registrations are merged into `~/.codex/hooks.json` (backup written
   alongside; existing hooks are preserved; re-running replaces only the
   AgStatus entries). Codex has no settings `env` block, so the board URL is
   embedded in the registered command string — you can read or change it
   right in `hooks.json`.
3. **One-time step:** Codex requires you to trust new hooks. Run `/hooks`
   inside Codex and approve the AgStatus entries — until then they won't fire.

Events wired: `SessionStart`, `PreToolUse` (matcher
`^(Bash|apply_patch|Edit|Write)$`), `PermissionRequest`, and `Stop`, each with
a 10 s timeout (the script itself exits within ~4 s).

### Environment variables read by the hooks

| Variable               | Purpose |
| ---------------------- | ------- |
| `CLAUDE_STATUS_URL`    | Required. Base URL the hook posts to — a board URL (`https://<host>/w/<token>`) or a legacy server origin. The hook appends `/webhook` and `/sessions/<id>` itself, and tolerates a trailing `/` or `/webhook`. |
| `CLAUDE_STATUS_SECRET` | Optional. Sent as `X-Webhook-Secret` (legacy servers with `WEBHOOK_SECRET` set). Workspace boards don't need it — the token in the URL is the auth. |
| `AGSTATUS_DETAIL=off`  | Node hook only. Send tool names instead of command text (what `--minimal` sets). |
| `AGSTATUS_USAGE=off`   | Node hook only. Never read or report plan usage (see [Plan-usage bars](#plan-usage-bars)). |
| `AGSTATUS_SOURCE`      | Node hook only. Agent kind tag on sessions (default `claude`; the Codex integration sets `codex`). Scopes which limit bars a dashboard shows. |

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
