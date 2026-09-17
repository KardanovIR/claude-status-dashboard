# Claude Code & Codex integration

AgStatus watches your agents through their hook systems — Claude Code's
[hooks](https://code.claude.com/docs/en/hooks) and OpenAI Codex's
[lifecycle hooks](https://developers.openai.com/codex/config-reference) use
the same shape (event JSON on stdin with `hook_event_name`, `session_id`,
`cwd`), so one small script serves both: it receives each event and posts a
status webhook to your board. Ways to set it up:

1. **The installer** (recommended) — one command; installs the CLI and a
   dependency-free Node hook, and wires up Claude Code, plus Codex when
   `~/.codex` exists. See [Install](#install) below.
2. **Claude Code plugin** — hooks bundled as a plugin, no settings.json
   surgery; see [Claude Code plugin](#claude-code-plugin) below. Claude Code
   only (Codex needs [the installer](#install)).
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

## Install

macOS and Linux:

```bash
curl -fsSL https://agstatus.online/install.sh | sh
```

Windows (PowerShell 5.1 or newer):

```powershell
irm https://agstatus.online/install.ps1 | iex
```

Both scripts do the same two things: unpack the CLI, then run `agstatus init`.
Nothing is installed system-wide and nothing needs `sudo` — everything lands
under one prefix you own:

```
~/.agstatus/            # or $AGSTATUS_HOME; on Windows, %LOCALAPPDATA%\AgStatus
├── bin/agstatus        # the launcher you run (agstatus.cmd on Windows)
└── lib/
    ├── agstatus/       # the CLI and the hook it installs
    └── node_modules/   # its one runtime dependency
```

The installer puts `~/.agstatus/bin` on your `PATH` for you — a marked block
appended to your shell profile on macOS and Linux, the persistent user `PATH`
on Windows — so open a new terminal before typing `agstatus` yourself. Re-run
the installer to upgrade: it is the same command for a first install and an
update, and it replaces only `bin/` and `lib/`, leaving the state the hook
keeps under the same prefix alone.

Self-hosting? Every board serves both scripts, so
`curl -fsSL https://status.example.com/install.sh | sh -s -- --url https://status.example.com`
installs from your own instance — see
[Pointing clients at your instance](self-hosting.md#pointing-clients-at-your-instance).

`init` then runs, in order:

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

On macOS the installer also sets up the [Focus listener](#focus-optional-opt-in)
so a tap on a board card brings that session's terminal to the front. It is
not a prompt — it prints the exact host summary your machines will start
sending, and `--no-focus` skips it.

### Passing flags to the installer

Everything after `--` goes to `agstatus init`, so the flags in the next table
work through the one-liner:

```bash
curl -fsSL https://agstatus.online/install.sh | sh -s -- --code AB12-CD34
```

PowerShell cannot pass arguments through `iex`, so on Windows fetch the
script into a script block and call that instead:

```powershell
& ([scriptblock]::Create((irm https://agstatus.online/install.ps1))) -Code AB12-CD34
```

`--no-focus` and `--focus` are the shell installer's own flags (last one
wins) and are consumed before the rest is handed on. They are macOS-only, so
`install.ps1` has no equivalent; its parameters are `-Code`, `-Url`,
`-Secret` and `-Minimal`.

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
agstatus status      # show configured URL, hook file, server reachability + session count
agstatus uninstall   # remove the hook file and AgStatus settings entries (backup kept), and the Focus listener if installed
agstatus listener …  # the Focus listener, see below (install | uninstall | status | doctor | plan | run)
agstatus help        # usage
```

`uninstall` removes only AgStatus's hook registrations and the
`CLAUDE_STATUS_URL` / `CLAUDE_STATUS_SECRET` / `AGSTATUS_DETAIL` env keys —
everything else in `settings.json` is left untouched. When the
[Focus listener](#installing-the-listener-macos) is installed it runs
`listener uninstall` too, so the LaunchAgent stops and `"focus"` is set to
`false`.

### Other ways in

The [Claude Code plugin](#claude-code-plugin) is a separate, fully supported
channel — it needs no installer and no terminal, and it is the right choice on
a Claude Code-only machine.

AgStatus used to ship through npm and a Homebrew tap. Neither gets new
releases any more, and the installer above replaces both. Nothing was
unpublished, though: `agstatus@1.3.0` stays resolvable on the npm registry, so
an `npx agstatus init` in somebody's notes, a script, or a screenshot from
last year still runs and still works — it just installs 1.3.0 rather than the
current release. Re-run the installer to move a machine onto current: it
writes its own copy under `~/.agstatus` and rewires the hook, leaving any
global npm install to be removed with `npm rm -g agstatus` whenever you get
around to it.

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

`~/.agstatus.json` is also the home of the optional `"focus": true` key that
turns on [Focus](#focus-optional-opt-in) for this machine — every install
channel shares the file, and the hook checks that key whichever way the
board URL arrived. `agstatus listener install` is the sanctioned writer
of the key; setting it by hand does nothing on its own — without the machine
id file that installer creates, the hook adds no `host` object and writes no
record.

Don't combine the plugin with an `agstatus init` install on the same
machine: both hooks would fire and every status would post twice. Pick one
(`agstatus uninstall` removes the CLI-installed hook and leaves the plugin
alone). The plugin covers Claude Code only; for Codex, use
[the installer](#install).

## How events map to statuses

The Node hook applies this mapping; the `PermissionRequest` and `PreToolUse` —
`apply_patch` rows are Codex-only. The bash hook covers the same Claude Code
events but predates Codex support, so it handles neither of those, and being
frozen it still reports `Stop` as `idle` rather than `done` and renames a card
from the working directory of every event instead of pinning the name at
`SessionStart`:

| Hook event                                                     | Board status   | Notes |
| -------------------------------------------------------------- | -------------- | ----- |
| `SessionStart`                                                  | `idle`         | New session appears as soon as Claude starts. The only event that sends `idle`, so a card wears it just for the seconds between starting an agent and submitting the first prompt. |
| `UserPromptSubmit`                                              | `planning`     | Fires the moment you submit a prompt, so the card leaves `blocked`/`idle` immediately instead of waiting for the first tool call. Shows the prompt text (truncated); minimal mode shows "Processing prompt". |
| `PreToolUse` — `Edit` / `Write` / `MultiEdit` / `NotebookEdit`  | `coding`       | Card shows the file being touched — "Editing store.ts", "Writing landing.html". |
| `PreToolUse` — `Bash` (test runner)                             | `testing`      | Detected via `pytest`/`jest`/`vitest`/`go test`/`cargo test`/etc. Classification always reads the command, never the description. |
| `PreToolUse` — `Bash` (other)                                   | `coding`       | Card shows the agent's own one-line description of the command ("Show working tree status"), falling back to the command text when none was supplied. |
| `PreToolUse` — `Task` / `WebSearch` / `WebFetch`                | `planning`     | Card shows what is being looked for — the subagent's task description, "Searching: &lt;query&gt;", or "Reading &lt;host&gt;". |
| `Notification`                                                  | `blocked`      | Claude Code: permission prompts and other attention-needed events — this is what triggers a push. |
| `PermissionRequest`                                             | `blocked`      | Codex: fires before approval prompts — same push trigger. |
| `PreToolUse` — `apply_patch`                                    | `coding`       | Codex's file-edit tool; the card shows "Editing files". |
| `Stop`                                                          | `done`         | The agent finished its turn: the answer is on screen and it is waiting for your next prompt. The card reads "Turn finished", and this is the transition an opt-in push fires on. A turn you interrupt fires no `Stop` at all, so that card keeps its last tool status until the session's next event. |
| `SessionEnd`                                                    | _card removed_ | Claude Code only — the hook calls `DELETE /sessions/:id` so the card disappears. Codex has no session-end hook; its cards expire via the server's session TTL instead. |

Other tools and events are ignored. Messages are capped at 120 characters.
With `--minimal` (`AGSTATUS_DETAIL=off`) every card shows only the tool name —
no descriptions, file names, queries, or command text.

> **Why descriptions instead of commands?** Agents write a short description of
> each command they run, which reads better on a phone than a shell one-liner —
> and keeps flags, paths, and anything secret in the command out of the board.

### What each status means

| Status     | What the card is telling you |
| ---------- | ---------------------------- |
| `idle`     | The session exists and has not been asked to do anything yet. Only `SessionStart` sends it, so on a working board it is rare: a card shows `idle` until you submit the first prompt and normally never again. |
| `planning` | Thinking, reading or searching — your submitted prompt, a subagent, a web search or a fetch. |
| `coding`   | Editing a file, or running a command that isn't a test. |
| `testing`  | Running a test command (`pytest`, `jest`, `vitest`, `go test`, `cargo test`, …). |
| `blocked`  | The agent has stopped and needs a human: a permission prompt, or another attention-needed notification. Every registered device is pushed on this one. |
| `done`     | The turn is finished and the agent is waiting for your next prompt. `Stop` fires at the end of every turn, so this is the state a card rests in most of the time. |

`Stop` used to report `idle`, which folded two different situations into one
word: "nothing has happened here yet" and "your answer is ready". A program
cannot tell those apart; a person glancing at a phone cares about little else —
an `idle` card is one you have not started, a `done` card is one waiting to be
read. So `done` is now the ordinary end-of-turn state (boards colour it
green, and a device that opted in with `notify_done` is pushed each time a turn
finishes — see [docs/api.md](api.md#device-push-endpoints)), and `idle` is left
to mean only what it says: a session that has not been given any work.

### Card names and projects

A card's `name` is **pinned when the session starts**. The hook takes the
basename of the working directory at `SessionStart`, and that stays the card's
title for the life of the session. A session that starts in `~/work/backend`
and later `cd`s into `~/work/docs` is still the card called "backend": the card
you glanced at a minute ago is the same card now, and the name you learned to
recognise stays a handle on that piece of work.

That is new. The name used to be recomputed from the working directory on
every event, so a session that moved renamed its own card mid-turn — one live
session showed "backend" and later "docs", and two cards on the same board
could swap identities while you watched. Directory changes are ordinary (a
`cd` into a subproject, a build in a sibling checkout), and none of them mean
the session became a different session.

The pin is the hook's own, not the server's: it keeps a small map of session
id to name in the system temp directory (`agstatus-names-<hash>.json`, one file
per board and agent, capped at 200 sessions, entries dropped 24 hours after
their last event — the server's session TTL — and dropped outright at
`SessionEnd`). Every post carries the pinned name, so nothing depends on the
server remembering one. Two consequences worth knowing:

- **A pin on file always wins, including against a later `SessionStart`.**
  Claude Code fires that event again mid-session for `/compact`, `/clear` and
  `--resume`, and a session that had changed directory by then would be renamed
  by the re-pin — the exact bug the pinning exists to prevent. A genuinely new
  session brings a new id, finds no entry, and pins normally, so the title
  changes when the session does and not before.
- **A lost pin costs one name, not correctness.** If the map is missing or
  unreadable — the hook was installed mid-session, the temp directory was
  swept, this is the first run — the next event pins the live directory name,
  which is exactly what the hook posted before pinning existed.

`project` is deliberately **not** pinned: it is still read from the live
working directory on every event, so it says where the session is right now.
After a `cd` the two disagree, and that is correct — the card keeps the name it
was born with while the project underneath it follows the session. The
per-project token totals depend on it; see
[Where the tokens went](#where-the-tokens-went).

The split is visible on the cards. The web board always prints the project
beside the title, so it simply changes when the session moves. The iOS card
prints the project only when it differs from the name, so a session that moved
grows a second line naming the folder it moved into — exactly when that is
worth saying — and a session that never left home shows nothing extra.

## Plan-usage bars

The Node hook also feeds the dashboard's plan-limit bars. It runs on quiet
events (`SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`,
`PermissionRequest`), at most once every 5 minutes per board and source, and
reports only percentages and reset times
(`POST <board>/usage` — see [docs/api.md](api.md#plan-usage)).

A bar belongs to the board and the agent, never to a card. The server keeps
one set of windows per board per agent, and every session of that agent
reports into the same set, so the bars do not change when you switch cards and
dismissing a card does not clear them. In particular, the window whose id is
`session` is the **plan's 5-hour rolling window** — that is the plan's own
name for it, not a statement about the agent session in front of you. It keeps
counting across restarts, and ending a session does not reset it.

Where the numbers come from depends on which agent is running:

**Claude** (the 5-hour rolling window and the weekly caps you see in `/usage`
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

**These totals are keyed by folder, never by card name or session id.** Tokens
are bucketed per project folder per UTC day and summed across every session
that spent them there, so one row on the usage screen can be the work of three
sessions, and one session can appear in two rows. Claude Code stamps every
assistant record in its transcript with the directory it was made in, so a
session that starts in one project and `cd`s into another has its spend split
at the moment it moved: part lands under the first folder, the rest under the
second. Next to a card that kept its original name
([Card names and projects](#card-names-and-projects)) that looks like a bug,
and it is not one: the session really did spend tokens in both places, and
this is the screen that has to say so. (Codex is coarser: a rollout log
records its working directory once, at the top, so a Codex session that moves
keeps all of its spend under the folder it started in.)

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

## Focus (optional, opt-in)

Focus lets a tap on a session card bring that session's terminal to the
front on the machine running it. It is **off by default and opt-in per
machine**: until `"focus": true` is in a machine's `~/.agstatus.json`, the
hook on that machine sends exactly the payload the rest of this page
describes — nothing about the feature changes it for anyone else. (A machine
that turns Focus off again sends `host: null` so a live card clears.)

When a machine opts in, each status update additionally carries a `host`
object:

- `machine` — the short label chosen at install (default `Mac` / `PC` /
  `Linux`, never the hostname) and a random id that is specific to this
  board and this machine, so it links nothing across boards.
- `app` — the app the agent is running in: a `slug` from a fixed list
  (`agterm`, `iterm2`, `kitty`, `vscode`, `herdr`, `tmux`, …), a display
  `name`, and a `kind` (`terminal`, `multiplexer`, `ide`, `desktop-app`,
  `unknown`). Sessions inside Herdr, tmux, zellij or screen report the
  multiplexer; the listener on that machine works out the outer terminal
  itself when a tap arrives.

Everything the machine needs in order to act on a tap — pid, tty, working
directory, terminal and pane ids, socket paths — never goes on the wire. The
hook writes it to a local record under the per-machine state directory, one
file per session and agent process, mode `0600`:

| OS      | Location |
| ------- | -------- |
| macOS   | `~/Library/Application Support/AgStatus/sessions/` |
| Linux   | `$XDG_STATE_HOME/agstatus/sessions/` (`~/.local/state/agstatus/sessions/` when the variable is unset) |
| Windows | `%LOCALAPPDATA%\AgStatus\sessions\` |

The record is written only while Focus is on and is read by nothing but the
listener on that machine. `SessionEnd` (Claude Code) stamps `ended_at` on
the record and keeps the file, so the listener still knows where the session
last ran if it is resumed later; the listener's garbage collection sweeps a
record 7 days after `ended_at`, or once it has sat idle for 30 days with a
dead pid — which is also how Codex records go away, since Codex has no
session-end hook. `AGSTATUS_FOCUS=off` in the
environment switches off both the `host` object and the record even when the
file says `true`. The full protocol — what the listener may run, how it
validates a command, which terminals get pane-level focus — is in
[docs/design/focus-protocol.md](design/focus-protocol.md).

Codex users: what Codex trusts is a hash of the registered command string, so
an upgrade that changes that command leaves the stored hash stale and the hook
unrun — silently. If Codex sessions stop reporting after an upgrade, run
`/hooks` inside Codex and re-approve the AgStatus entries; see
[OpenAI Codex specifics](#openai-codex-specifics).

### Installing the listener (macOS)

The listener is the process on your Mac that receives a tap from the board
and brings the right terminal to the front. It runs as a LaunchAgent under
your user, starts at login and is restarted if it dies. On macOS the
installer sets it up for you, so usually there is nothing to do here. Run it
yourself to give the machine a name, to turn Focus on after installing with
`--no-focus`, or on a machine set up through the plugin — any time after
`agstatus init` (or the plugin's `/agstatus:setup`) has configured a board:

```bash
agstatus listener install --name "Studio"   # --name is the label shown on the board; default "Mac"
```

`install` is the only thing that turns Focus on. It

- creates `machine.json` in the state directory (see the table above) with
  a random machine id — the raw id never leaves the file; the board sees
  only a hash of it and the board URL, so it links nothing across boards;
- sets `"focus": true` in `~/.agstatus.json`, keeping every other key (and
  writes `url` there only if the file had none);
- writes the resume launcher `agstatus-resume` (mode `0700`) into the state
  directory — the only thing a Resume tap can ever start, see
  [Resume](#resume) below; `--no-resume` writes `"resume": false` instead and
  writes no launcher at all;
- writes and loads `~/Library/LaunchAgents/com.agstatus.listener.plist`,
  which runs `~/.agstatus/bin/agstatus listener run`. That first argument is
  an absolute path on purpose: launchd resolves a job's program against its
  own `/usr/bin:/bin:/usr/sbin:/sbin` and never against the job's
  `EnvironmentVariables.PATH` (see
  [docs/design/focus-protocol.md](design/focus-protocol.md), "A LaunchAgent's
  PATH"), and no nvm, fnm or Volta install of Node lives in those four
  directories. The launcher is a small `sh` script that finds a Node ≥ 18 at
  every start rather than baking one in, so upgrading Node does not silently
  take Focus down. The plist still carries the `PATH` of the shell you
  installed from, so the terminal tools the listener may call resolve the
  same way under launchd;
- prints the exact `host` object every status post now carries.

The board URL comes from the same places the hook reads it, in this order:
`CLAUDE_STATUS_URL` in the environment, `~/.claude/settings.json`, the
Codex `hooks.json` command, `~/.agstatus.json` (`--url` overrides them
all, and is kept in the LaunchAgent's arguments so `listener run` follows
the same board; the hook still follows the files, so the installer warns
when a `--url` names a different board than `settings.json` or
`hooks.json`). If Claude Code and Codex are configured for different boards
the installer refuses rather than guess — re-run `agstatus init`, or pass
`--url`.

```bash
agstatus listener status               # loaded? pid, machine label + public id, board, last log lines
agstatus listener doctor               # which tools resolved and which strategies that enables, config sanity
agstatus listener plan <session_id>    # dry run: print what a tap on that session would execute, run nothing
agstatus listener plan <id> --resume   # the same for the Resume tap: what a respawn would launch
agstatus listener uninstall [--purge]  # stop and remove the agent, set "focus": false (cards clear)
```

`uninstall` keeps the session records and the log (and `machine.json`, so a
reinstall keeps the same id); `--purge` removes the records and the log. The
resume launcher goes either way: nothing that can start a session is left on
a machine whose listener has been taken down.
`agstatus uninstall` — the hook uninstall — runs `listener uninstall`
as well whenever the LaunchAgent is present or `"focus": true` is still
set, so switching AgStatus off on a machine switches Focus off with it.
`plan` and `doctor` are the way to find out what a host can do before you
tap anything: the listener never runs a shell and only ever launches tools
by absolute path with argument arrays, so `plan` shows you the literal
argument lists. Before anything runs, the record is treated as data: every
field must match its expected shape, a socket path must be a live socket
you own and a project root a directory you own (anything else is ignored
or fails the tap as `bad-record`), and the bundle id handed to `open -b`
must be one from the listener's own table — an app it does not know is
never activated, and the tap answers `unsupported-host`.

What v1 can reach on macOS: the exact pane in **agterm**, **Herdr**, and
**tmux** (through the multiplexer, then the outer terminal); the exact
window in **kitty** when `allow_remote_control` and a `listen_on unix:`
socket are configured; the session in **iTerm2** (its `iterm2:reveal` URL)
and **WezTerm** (its CLI) — both marked experimental until verified on real
setups; the thread in **Codex Desktop** (its `codex://threads/` link); the
project window in **JetBrains IDEs** and **Zed**; and plain app activation
(`open -b`) for the other apps in the listener's table — Terminal.app,
Ghostty, Alacritty, Warp, Hyper, Tabby, Rio, Xcode, VS Code, Cursor,
Windsurf, Claude Desktop (inside a multiplexer whose outer terminal is not
in the table, the pane is selected and the window stays where it is).
Tab-exact focus in Terminal.app and
Ghostty needs Apple Events, which a plain Node process cannot send without
prompting for every app; that arrives with the signed listener app in a
later release. A tap on a session that is no longer running answers "not
running", and the board then offers [Resume](#resume). Linux and Windows
have no LaunchAgent equivalent yet; `agstatus listener run` works there in
the foreground, without the terminal-specific strategies.

### Resume

When a tap comes back "not running" — the terminal was closed, or the
machine rebooted — the board offers **Resume**: a second, deliberate tap
that starts the session again on that machine. It is on by default once the
listener is installed, and it can do exactly one thing.

`agstatus listener install` writes a launcher, `agstatus-resume`, into the
state directory (mode `0700`, owned by you). Its entire content is three
fixed lines, with the absolute paths of Node and of the CLI baked in at
install time and nothing else interpolated, ever:

```sh
#!/bin/sh
# AgStatus Focus resume launcher — written by `agstatus listener install`.
exec "<node>" "<cli.js>" listener resume-exec "$1"
```

A Resume plan opens a terminal and hands it that launcher and the session
id — nothing else. The launcher checks that the id is a uuid, reads the
local record itself, and runs the recorded agent binary with exactly
`--resume <id>` (Claude Code) or `resume <id>` (Codex) in the directory the
session ran in: never a prompt, never a `-c` override, never a shell. Hosts
that take an argument list get `<launcher> <id>`; the two that only take a
command *string* (agterm's `--command`, `tmux new-window`) get the fixed
text `'<launcher>' <id>` — an absolute path the installer wrote plus a
token that has already matched the uuid pattern, so there is nothing in it
to quote or escape. Nothing from the record is ever part of a command
string. If the launcher is missing, or is not a `0700` file you own, every
Resume tap answers `unsupported-host`.

Two more things follow from those three fixed lines. The launcher is started
by a terminal, a multiplexer server or LaunchServices, so it is handed no
environment of yours: it reads the *default* state directory (the table
above), whatever `AGSTATUS_STATE_DIR` said at install time. An install that
moved the state directory therefore keeps Focus and refuses Resume — no
launcher is written, `status` and `doctor` say why, and every tap answers
`unsupported-host` rather than opening a window that closes again. And
because the launcher is a wrapper rather than a real `exec`, it stays out of
the way of the terminal's own signals: Ctrl-C in the resumed window
interrupts the agent's turn as usual and does not close the window with it.

`resume-exec` re-checks two things before it starts anything: that resume is
still switched on, and that the session is not already running (a command the
board re-sent must not put two `--resume <id>` on one transcript). Both
answer with one line and exit.

What can resume in v1: **agterm**; **kitty** (with `allow_remote_control`
and a `listen_on unix:` socket, otherwise a new window); **WezTerm**;
**Ghostty**, **Alacritty** and **Rio** (a new window through `open -n`);
**tmux** and **Herdr** (a new pane in the same session, then the outer
terminal is raised); and **Codex Desktop**, whose `codex://threads/` link
reopens the thread without starting anything. Every row that starts a
process ships as experimental until it has been checked on a real setup —
the ack carries that and the board shows it.

What cannot, and why:

- **Terminal.app** and **iTerm2** can only be handed a command through
  Apple Events or a file on disk. Both wait for the signed listener app —
  the same release that brings tab-exact focus there.
- **VS Code, Cursor, Windsurf, JetBrains IDEs, Zed** have no agent session
  to resume from outside, and **Warp, Hyper, Tabby, Xcode** take no command
  from `open`: a Resume tap on them answers `unsupported-host`.
- **Claude Desktop** keeps its own conversation list and documents no
  resume link, so the tap just brings the app to the front.
- Headless runs — `claude -p` and the Agent SDK, `codex exec` — are never
  respawned; there is no terminal they belonged to.
- A session whose working directory is gone answers `respawn-failed`. The
  directory comes from the record, or from the session's own transcript
  (`~/.claude/projects/…/<id>.jsonl`, or Codex's `session_meta` line), and
  it has to be a directory you own.

A respawn has to prove itself before the board hears `resumed`. `open -n -b`
exits as soon as macOS accepts the request, and `agtermctl session new`
exits as soon as the pane exists, so the listener waits (up to twelve
seconds) for the hook to write a record for that session — the sign that an
agent actually came up. Nothing arrives, the tap answers `respawn-failed`.
The step that raises the window afterwards is best-effort: a session sitting
in a new pane is not "nothing started" because `open -b` failed.

Guards, enforced on the machine and logged: one resume per session per
minute and at most five per machine per ten minutes — counted in
`respawns.json` in the state directory, so a listener that restarts (the
LaunchAgent comes back ten seconds after any exit) does not start the count
again — on top of the focus limits (one tap per session and command type per
two seconds, and a breaker that ignores the board for five minutes after
twenty taps in a minute). A refused tap starts nothing and answers
`respawn-failed`.

To keep Focus but switch Resume off, so those taps come back refused:

```bash
agstatus listener install --no-resume   # writes "resume": false in ~/.agstatus.json
```

Setting `"resume": false` in `~/.agstatus.json` by hand does the same at any
time — re-run `install` afterwards and the launcher is deleted, so "off"
means the file that starts sessions is gone, not merely unused.
`AGSTATUS_RESUME=off` overrides the file, and because the LaunchAgent has
only the environment the installer gave it, that variable has to be set when
you run `install`: it is then copied into the agent's plist. Setting it in a
shell rc afterwards changes nothing for the running listener, and
`status`/`doctor` say so instead of reporting an "off" that is not. Both
commands print which switch is in force, where the launcher is, and
`agstatus listener uninstall` removes it.

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
   Codex trusts a hook by hashing its command, so a release that changes that
   command invalidates the stored hash: an existing install stays silent —
   no error anywhere — until you re-run `/hooks`. Both `agstatus init` and
   the installer say so when they finish setting Codex up.

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
| `AGSTATUS_FOCUS=off`   | Node hook only. Never add the `host` object to the payload or write the local session record, even when `~/.agstatus.json` has `"focus": true` (see [Focus](#focus-optional-opt-in)). |
| `AGSTATUS_SOURCE`      | Node hook only. Agent kind tag on sessions (default `claude`; the Codex integration sets `codex`). Scopes which limit bars a dashboard shows. |
| `AGSTATUS_DEBUG=1`     | Node hook only. Prints diagnostics to **stderr** (never stdout). The hook fails silently by design, so this is how you find out why plan-usage bars stopped appearing. |

## Manual setup: the bash hook (deprecated)

> **Deprecated.** This hook still ships and still works, and nothing here has
> stopped being true — but it is no longer where new features land, and it is
> missing three that the Node hook has: **plan-usage bars** (it reports no
> usage at all), **card removal on `SessionEnd`**, and **Codex support** (no
> `PermissionRequest` or `apply_patch` handling). Prefer
> [the installer](#install) or the
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
card transitioning through `idle → coding → done` as you work. If it doesn't:

```bash
# Check the CLI-installed setup end to end:
agstatus status

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
