# Claude Code & Codex integration

AgStatus watches your agents through their hook systems — Claude Code's
[hooks](https://code.claude.com/docs/en/hooks) and OpenAI Codex's
[lifecycle hooks](https://developers.openai.com/codex/config-reference) use
the same shape (event JSON on stdin with `hook_event_name`, `session_id`,
`cwd`), so one small script serves both: it receives each event and posts a
status webhook to your board. Ways to set it up:

1. **`npx agstatus init`** (recommended) — installs a dependency-free Node
   hook and wires up Claude Code, plus Codex when `~/.codex` exists. Homebrew
   users can `brew install kardanovir/tap/agstatus` and run `agstatus init` —
   same CLI, on your PATH.
2. **Claude Code plugin** — hooks bundled as a plugin, no settings.json
   surgery; see [Claude Code plugin](#claude-code-plugin) below. Claude Code
   only (Codex still needs `agstatus init`).
3. **Manual bash hook** — *deprecated.* The original
   `hooks/claude-status-hook.sh`, still shipped and still working, for people
   who want to see and customize every moving part. It reports status only:
   no plan-usage bars, no card removal at session end, and no Codex support.
   Prefer 1 or 2; see [Manual setup: the bash hook](#manual-setup-the-bash-hook-deprecated).

Both hooks are deliberately non-blocking: any failure (server down, bad
secret, malformed payload) is swallowed and the agent continues normally.
The Node hook additionally enforces a 3 s HTTP timeout, a ~4 s overall
safety timeout, and never writes to stdout (Codex interprets hook stdout as
behavior-control decisions).

## `npx agstatus init`

```bash
npx agstatus init
```

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
| `--url <base>`     | Server to use (default: `https://agstatus.online`; the `AGSTATUS_URL` env var also overrides it, with `--url` winning). |
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

## Claude Code plugin

The same hook, packaged as a Claude Code plugin — nothing touches
`~/.claude/settings.json`. Inside Claude Code:

```
/plugin marketplace add KardanovIR/claude-status-dashboard
/plugin install agstatus@agstatus
/agstatus:setup
```

`/agstatus:setup` creates a private board (or pairs with one:
`/agstatus:setup XXXX-XXXX` with a code from the iOS app) and writes the
board URL to `~/.agstatus.json`, which the hook reads whenever the
`CLAUDE_STATUS_URL` env var is absent. Reporting starts immediately — the
session you run it in appears on the board.

Don't combine the plugin with an `agstatus init` install on the same
machine: both hooks would fire and every status would post twice. Pick one
(`npx agstatus uninstall` removes the other). The plugin covers Claude Code
only; for Codex, use `agstatus init`.

## How events map to statuses

The Node hook applies this mapping. The bash hook covers the same Claude Code
events but predates Codex support, so it has no `PermissionRequest` or
`apply_patch` handling (the last two rows below are Codex-only):

| Hook event                                                     | Board status   | Notes |
| -------------------------------------------------------------- | -------------- | ----- |
| `SessionStart`                                                  | `idle`         | New session appears as soon as Claude starts. |
| `UserPromptSubmit`                                              | `planning`     | Fires the moment you submit a prompt, so the card leaves `blocked`/`idle` immediately instead of waiting for the first tool call. Shows the prompt text (truncated); minimal mode shows "Processing prompt". |
| `PreToolUse` — `Edit` / `Write` / `MultiEdit` / `NotebookEdit`  | `coding`       | Card shows the file being touched — "Editing store.ts", "Writing landing.html". |
| `PreToolUse` — `Bash` (test runner)                             | `testing`      | Detected via `pytest`/`jest`/`vitest`/`go test`/`cargo test`/etc. Classification always reads the command, never the description. |
| `PreToolUse` — `Bash` (other)                                   | `coding`       | Card shows the agent's own one-line description of the command ("Show working tree status"), falling back to the command text when none was supplied. |
| `PreToolUse` — `Task` / `WebSearch` / `WebFetch`                | `planning`     | Card shows what is being looked for — the subagent's task description, "Searching: &lt;query&gt;", or "Reading &lt;host&gt;". |

Messages are capped at 120 characters. With `--minimal` (`AGSTATUS_DETAIL=off`) every card shows
only the tool name — no descriptions, file names, queries, or command text.

> **Why descriptions instead of commands?** Agents write a short description of
> each command they run, which reads better on a phone than a shell one-liner —
> and keeps flags, paths, and anything secret in the command out of the board.
| `Notification`                                                  | `blocked`      | Claude Code: permission prompts and other attention-needed events — this is what triggers a push. |
| `PermissionRequest`                                             | `blocked`      | Codex: fires before approval prompts — same push trigger. |
| `PreToolUse` — `apply_patch`                                    | `coding`       | Codex's file-edit tool; the card shows "Editing files". |
| `Stop`                                                          | `idle`         | Turn finished, waiting for the next prompt. |
| `SessionEnd`                                                    | _card removed_ | Claude Code only — the hook calls `DELETE /sessions/:id` so the card disappears. Codex has no session-end hook; its cards expire via the server's session TTL instead. |

Other tools and events are ignored. The card `name` and `project` default to
the basename of the session's working directory, so multiple sessions are
easy to tell apart.

## Plan-usage bars

The Node hook also feeds the dashboard's plan-limit bars. It runs on quiet
events (`SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`,
`PermissionRequest`), at most once every 5 minutes per board and source, and
reports only percentages and reset times
(`POST <board>/usage` — see [docs/api.md](api.md#plan-usage)).

Where the numbers come from depends on which agent is running:

**Claude** (the 5-hour session window and the weekly caps you see in `/usage`
inside Claude Code):

1. The hook reads the Claude Code OAuth token locally:
   `~/.claude/.credentials.json`, or the macOS login keychain
   (`Claude Code-credentials`). macOS may ask once to allow `security`
   access — choose "Always Allow".
2. It asks Anthropic's usage endpoint (`api.anthropic.com/api/oauth/usage`)
   for utilization percentages. The structured `limits` array is preferred
   (it carries model-scoped weekly caps such as **Fable**, which the legacy
   `five_hour`/`seven_day` keys never mention), with a fallback to those
   legacy keys for older responses.
3. **The token itself never leaves your machine.**

**Codex** (its `primary` and `secondary` rate-limit windows):

1. Codex has no usage API, but it already records a `rate_limits` block in
   its own session rollout log —
   `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<session_id>.jsonl`
   — after every turn. The hook reads the newest block from the tail of that
   file. **Entirely local: no credentials, no network call.** A Codex run
   never touches Claude's credentials, and vice versa.
2. The session id in the hook payload names the file directly. Recent
   sibling logs are tried next — Codex rate limits are account-wide rather
   than per-session, so a sibling carries the same numbers. That matters at
   `SessionStart`, when the session's own log exists but has no
   `rate_limits` yet: Codex writes the first one when a turn completes.
3. Blocks older than 12 hours are ignored rather than reported as current,
   and a window that has already reset is sent with no reset time. Relative
   countdowns (`resets_in_seconds`, older Codex builds) are anchored to when
   the block was written, not to when the hook runs.
4. Windows keep positional ids (`primary`, `secondary`) because nothing
   guarantees `primary` is the shorter one; labels come from
   `window_minutes`, e.g. "5h limit", "Weekly limit".

`PreToolUse` is excluded for Claude, whose report costs a network round trip
and which fires between every tool call. Codex reads a local file, and
`PreToolUse` is most of what it fires at all, so it reports there too — the
throttle bounds the work either way.

Set `AGSTATUS_USAGE=off` in the settings `env` block (Claude Code) or add it
to the command prefix in `hooks.json` (Codex) to turn this off entirely. The
bash hook reports no usage at all; a board simply shows no bars until
something reports it.

### Where the tokens went

The bars answer "how much of the plan is left", not "which project spent it" —
no usage API breaks the limit down by project. So the hook also reads the logs
each agent already keeps locally (`~/.claude/projects/**/*.jsonl`,
`$CODEX_HOME/sessions/**/rollout-*.jsonl`), totals tokens per project per UTC
day, and reports those (`POST <board>/usage/projects`). Only a folder name, a
date and a number leave your machine — never prompts, code or conversation.

Reported tokens are input + output + cache creation. Cache reads are excluded:
they are ~94% of raw token volume but a small share of what a limit charges,
and counting them ranks projects by context size rather than by spend.

Scanning is incremental — the hook remembers how far into each log it has read
and each run costs only what was appended since — and is capped at 8 MB per
run so a first run cannot stall an agent. To load the history that already
exists on disk, run the backfill once per agent:

```bash
CLAUDE_STATUS_URL="https://<server>/w/<token>" node ~/.claude/hooks/agstatus-hook.js --backfill
CLAUDE_STATUS_URL="https://<server>/w/<token>" AGSTATUS_SOURCE=codex \
  node ~/.codex/hooks/agstatus-hook.js --backfill
```

It reads every log from the start and reports the lot; re-running it is safe,
because the server replaces whole days rather than adding to them.

Dashboards only show the bars of agents that currently have sessions on the
board (each session carries a `source` tag: `claude`, or `codex` via the
`AGSTATUS_SOURCE=codex` prefix the Codex integration embeds) — a Claude-only
evening doesn't display Codex limits, and vice versa.

Caveat: neither source is a documented, stable interface — the Anthropic
usage endpoint has changed before, and the Codex rollout format is internal.
The hook degrades silently on both: unknown shapes mean missing bars, never a
blocked agent. Run with `AGSTATUS_DEBUG=1` to see on stderr what it read and
reported.

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
| `AGSTATUS_DEBUG=1`     | Node hook only. Prints diagnostics to **stderr** (never stdout). The hook fails silently by design, so this is how you find out why plan-usage bars stopped appearing. |

## Manual setup: the bash hook (deprecated)

> **Deprecated.** This hook still ships and still works, and nothing here has
> stopped being true — but it is no longer where new features land, and it is
> missing three that the Node hook has: **plan-usage bars** (it reports no
> usage at all), **card removal on `SessionEnd`**, and **Codex support** (no
> `PermissionRequest` or `apply_patch` handling). Prefer
> [`npx agstatus init`](#npx-agstatus-init) or the
> [Claude Code plugin](#claude-code-plugin); keep reading only if you want a
> hook you can read end to end in one sitting, or you would rather not have
> Node in the loop.

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
    "UserPromptSubmit": [
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
export CLAUDE_STATUS_URL='https://agstatus.online/w/ags_yourtoken'
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
