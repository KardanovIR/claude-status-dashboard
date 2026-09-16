# Focus Protocol — bring the session's window to the front from the phone

Status: **design, reviewed; steps 1–6 implemented — hook local record + opt-in `host` summary and server `host` field (2026-09-13), server commands + presence, listener core, boards, and step 5 (respawn: the `agstatus-resume` launcher, the respawn rows, the guards, the `"resume": false` switch) on 2026-09-15, hardened after an adversarial review on 2026-09-16 (§9 step 5). Step 7 (signed sender for the AppleScript rows, Windows, Linux) not started.** Written 2026-09-13 from a 7-lane research pass (host detection, macOS focus, IDEs + multiplexers, Windows/Linux, Codex, codebase touchpoints, prior art) and a 6-lens adversarial review (security, privacy, protocol/compat, cross-platform honesty, implementer feasibility, completeness). Every claim below is tagged **[V]** verified on a Mac in this repo's dev environment, **[D]** docs/source-only, or **[I]** inferred. Untagged statements are design decisions. Herdr (§2, §3.2, §4–§6, §10, §11) added 2026-09-13 after checking 0.7.0 on the same Mac.

## 1. What this is

Tap a session on the AgStatus board → the computer running it brings the hosting app to the front and, where the host allows, raises the exact window/tab/pane. If the session is gone, a second explicit tap can resume it in a new terminal.

Scope: *have the right window in front when I get back to the desk.* Not a reply channel — Claude Code Remote Control and `codex remote-control` already cover "answer the blocked prompt from my phone" and neither raises a window **[V]**, so the two are complementary.

Non-negotiables that survived review:

1. **Two records.** Everything the machine needs to act (pid, tty, cwd, terminal ids, socket paths) stays in a **local record** on that machine. The wire carries a **small opt-in summary** — enough to label the card and route the tap — and nothing executable.
2. **Commands carry only ids.** A tap is `{id, type, session_id}`. The listener derives every action from its local record and its own allow-listed strategy table. The wire can never name a directory, a binary, or an argument.
3. **The listener never builds shell or AppleScript source from record fields.** argv arrays only; a fixed launcher for hosts that need a command *string*.
4. **Focus never respawns.** `focus` on a dead session fails honestly; `resume` is its own command type and its own tap.
5. **The phone renders the acknowledgement, not a hint.** Nothing pre-tap promises more than the machine later reports.

## 2. Facts the design rests on

**Identity is already on the wire.** The hook posts the agent's own `session_id` verbatim (`cli/assets/agstatus-hook.js:1065`); for Codex that is the *root* thread id — exactly what `codex resume <id>` and `codex://threads/<id>` want **[V]**. `claude --resume <uuid>` resolves machine-wide, from any directory, since 2.1.223 **[V]**.

**The hook can see its host.** It is a child of the agent and inherits the full terminal environment plus `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` (`cli | sdk-cli | claude-desktop`) **[V]**. Codex hooks are `$SHELL -c` children of the codex binary and inherit the same env **[V]**. Hooks fire for Claude-Desktop- and Codex-Desktop-hosted sessions too **[V]**.

**Env vars are hints; the process tree is truth.** Apps launched from a terminal via `open` inherit the launcher's env (a kitty shell showed `TERM_PROGRAM=ghostty` and `AGTERM_SESSION_ID`) and Codex Desktop scrubs `TERM`/`__CFBundleIdentifier` entirely **[V]**. Walking ppid from the agent's *parent* to the first ancestor inside `*.app/Contents/` and reading `CFBundleIdentifier` is correct in every case tried, including the nested `claude.app` inside Claude Desktop **[V]**. Under tmux/screen/zellij the chain ends at the mux server (ppid 1) — correct, the outer terminal must be found through the mux client **[V]**.

**Herdr is a multiplexer, not a terminal.** [Herdr](https://herdr.dev) runs inside the user's terminal emulator — no window of its own — as a client/server pair like tmux: `herdr server` sits at ppid 1 and every pane is its child, so the ppid walk ends there and the outer terminal must again be found through the attached client **[V]**. It injects `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID` (`w2`), `HERDR_TAB_ID` (`w2:t1`), `HERDR_PANE_ID` (`w2:p1`) into every pane, plus `HERDR_SESSION` for a named session and, when set, `HERDR_CLIENT_SOCKET_PATH` and `HERDR_BIN_PATH` **[V]**. The server speaks newline-delimited JSON on `$HERDR_SOCKET_PATH` (default `~/.config/herdr/herdr.sock`; named sessions under `~/.config/herdr/sessions/<name>/herdr.sock`) with `pane.focus`, `tab.focus`, `workspace.focus`, `agent.focus`, `pane.get`, `pane.list`, `pane.process_info`, `session.snapshot` and `pane.report_agent_session`; the CLI wraps the same calls — `herdr agent focus <target>` (targets accept pane ids; `herdr pane focus` is directional only), `herdr tab focus <tab_id>`, `herdr workspace focus <id>`, `herdr pane get <pane_id>`, `herdr pane process-info --pane ID`, `herdr agent start <name> [--cwd] [--workspace] [--tab] [--split] [--focus] -- <argv…>`, `herdr pane report-agent-session` **[V]**. So focusing a Herdr pane has the tmux shape: select inside the mux, then raise the *outer* terminal through the attached client's tty and that terminal's own row. Verified on herdr 0.7.0 on this Mac; herdr.dev documents 0.9.0, so re-check the CLI surface before the row leaves experimental.

**The hook's own tty is unreliable** (agent children run detached, tty `??`); use `ps -o tty= -p $CLAUDE_PID` **[V]**. For Codex, `process.ppid` is the codex pid only when `$SHELL` exec-optimizes (zsh/bash do, fish/nu do not) **[V]** — walk up to the ancestor whose `comm` is `codex`.

**Per-app exact focus exists without any permission prompt for:** agterm (`agtermctl session select --target $AGTERM_SESSION_ID --window $AGTERM_WINDOW_ID`; does *not* activate the app, add `open -b`) **[V]**; kitty with remote control on (`kitten @ --to $KITTY_LISTEN_ON focus-window --match id:$KITTY_WINDOW_ID` — raises the OS window too) **[V]**; Codex Desktop (`open codex://threads/<id>` navigates and raises) **[V]**; iTerm2 (`open 'iterm2:reveal?sessionid=$ITERM_SESSION_ID'`) **[D]**; JetBrains for an already-open project root (`open -a WebStorm <root>` raised the right frame) **[V]**.

**Needs a one-time Automation consent, and the sender must be a stable signed .app with `NSAppleEventsUsageDescription`, otherwise silently denied (-1743):** Terminal.app (AppleScript, join on `tty of tab`) **[V sdef, D exec]**; Ghostty ≥ 1.3 (AppleScript `focus`; join on `working directory` in 1.3.1, on `tty` in HEAD) **[V sdef, D exec]**. `open -b`, `open <url>` and `activate` never prompt **[V]**.

**Windows Terminal cannot map `WT_SESSION` to a window or tab** (maintainers declined `WT_WINDOWID`) **[D]**. **Wayland has no generic activate** — Sway/Hyprland/KDE via IPC, GNOME only with a Shell extension **[D]**.

**A LaunchAgent's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`** — `agtermctl` (`/opt/homebrew/bin`), `claude` (`~/.local/bin`), `kitten`, `wezterm`, `code` are all invisible to it; `codex` is not on any PATH, it lives inside `ChatGPT.app` **[V]**.

**Codebase:** the server silently drops unknown webhook fields (`src/app.ts:182-189`); `Session` is serialized verbatim on REST and SSE; all three shipped clients ignore unknown keys; schema evolves by `ALTER TABLE … ADD COLUMN IF NOT EXISTS`; JSON-in-TEXT is the convention; the store is memory-authoritative and **never hard-deletes** **[V]**. So hook → server → apps can ship in that order with no version gate.

**Two live agents can share one session id** (two `claude --resume d916b7fe…` processes in different cwds) **[V]**. `~/.agstatus.json` does not exist on CLI installs — the CLI writes env into `~/.claude/settings.json`; only the plugin's `/agstatus:setup` writes the file **[V]**. Changing the Codex hook *command string* invalidates hook trust until `/hooks` re-approval **[V]**; whether the hash also covers the script *content* is unknown and must be tested before shipping.

## 3. Architecture

```
hook ──(opt-in, cached)──▶ <state>/sessions/<session_id>/<pid>.json          LOCAL, full detail, 0600
hook ──(opt-in)──────────▶ POST /webhook { …, host: {machine, app} }          WIRE, minimal summary
listener ─▶ GET /w/:token/events?listener=<machine_id>&key=<machine_key>&name=…   presence + command stream
phone ────▶ POST /w/:token/commands {id, type, session_id}                    server attaches machine_id
server ───▶ SSE `command` ─▶ listener: claim ─▶ validate record ─▶ act ─▶ POST …/commands/:id/ack
server ───▶ SSE `command_ack` (and `expired` at TTL) ─▶ phone; GET /commands/:id for polling
```

### 3.1 Per-machine state (never synced)

Lives in a per-machine, non-dotfile location the listener installer owns: macOS `~/Library/Application Support/AgStatus/`, Linux `$XDG_STATE_HOME/agstatus/`, Windows `%LOCALAPPDATA%\AgStatus\`. Contains:

- `machine.json` — `{ machineId: <random uuid>, machineHost: <hostname at creation>, name: "<label chosen at install>", bins: {...} }`. Hook reads it read-only. If `machineHost` no longer matches the hostname the listener warns and regenerates (catches a synced/cloned home).
- `sessions/<session_id>/<pid>.json` — the local record (§4).
- `listener.json` — `{ version, platform, strategies: [...], consents: {...}, bins: {...} }` written on install and on every consent change.
- `listener.log`, `listener.lock` (single instance, pid-checked).

`~/.agstatus.json` keeps only what it has today (`url`, `secret`) plus one boolean, `focus`. It stays the one config file all install channels share, but it never holds the machine id — it is exactly the file people sync between machines.

### 3.2 Wire summary — the `host` webhook field

Sent on every status post when `focus === true` (strict boolean) **and** `machine.json` exists; carried forward server-side like every other field; `host: null` sent whenever `focus === false` so a live card clears on the next event.

```json
"host": {
  "machine": { "id": "9f2c…(32 hex)", "name": "Mac" },
  "app":     { "slug": "agterm", "name": "agterm", "kind": "terminal" }
}
```

- `machine.id` is derived in two rounds, so that the listener has a credential the board never sees: the **machine key** is the lowercase hex SHA-256 of `machineId + "\n" + base` — `` crypto.createHash('sha256').update(`${machineId}\n${base}`).digest('hex') `` (64 hex) — and `machine.id` is the first 32 characters of the lowercase hex SHA-256 of that key: `` crypto.createHash('sha256').update(key).digest('hex').slice(0, 32) ``. The key goes only from the listener to the server (`?key=` on the presence subscribe, `machine_key` in claim and ack bodies; §3.3) and never into the webhook, so every viewer knows the id from the snapshot and none can claim, ack or pose as the machine. The server verifies `sha256(key)[0..32] === id` and stores nothing. *(Step-3 review change, 2026-09-14: the hook's `readMachine()` adopted the two-round derivation the same day; `machineKey()` in `cli/assets/agstatus-hook.js` is the reference implementation.)* The listener and the installer must hash the same bytes in the same order:
  - `machineId` — the `machineId` string from `machine.json`, whitespace-trimmed and otherwise as stored (case preserved, not lower-cased). It must match `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`, else the hook treats the machine as not opted in.
  - one `\n` (LF, no CR).
  - `base` — the board URL the hook is configured with, **not** the bare token: `CLAUDE_STATUS_URL` as given (untrimmed), else `url` from `~/.agstatus.json` whitespace-trimmed; then `rawUrl.replace(/\/$/, '').replace(/\/webhook$/, '')` — strip **one** trailing `/`, then **one** trailing `/webhook`, in that order, and nothing else (no scheme or host case folding, no query stripping). So `…/w/<token>/webhook`, `…/w/<token>/webhook/` and `…/w/<token>` hash alike; `…/w/<token>//` does not.

  The listener computes the same value per configured board URL to filter commands; the server never sees a cross-board constant, so recreating a board does not link machines. `agstatus listener reset-id` rotates the raw id.
- `machine.name` is chosen at install (`--name`, or an interactive prompt showing the default). Default is a non-identifying `Mac` / `PC` / `Linux`; the board appends the last four hex of `machine.id` when two online machines share a label. Never `os.hostname()` by default — on macOS the default hostname embeds the account's full name.
- `app.slug` is a small enum the server whitelists (`agterm | iterm2 | kitty | wezterm | terminal | ghostty | alacritty | warp | vscode | cursor | windsurf | jetbrains | zed | claude-desktop | codex-desktop | tmux | herdr | zellij | screen | windows-terminal | other`), `app.kind` ∈ `terminal | multiplexer | ide | desktop-app | unknown`, `app.name` ≤ 32 via `clean()`. No bundle id, no version, no cwd, no tty, no pid, no `reach`.
- Server: `parseHost()` beside `parseUsageWindows()`; whitelist key-by-key; `host TEXT` column with `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS host TEXT`; parse on load; **every soft-delete path also sets `host = NULL`**; `host` is never copied into `session_events` and never into the APNs payload (`src/push.ts` builds `alert`, `sound`, `thread-id` and the fixed `category: "AGSTATUS_SESSION"` that names the app's Focus action — a test pins exactly those keys).

Why keep a wire summary at all, given the listener could answer everything at tap time? Two reasons: the card can say *where* the session is ("agterm · Mac"), and the server can route a command to one machine instead of broadcasting to all listeners. The privacy cost is two short labels and a per-board id, and it is opt-in per machine. If that trade is ever unwanted, the fallback is documented in §12.

### 3.3 Commands

`POST /w/:token/commands` body `{ "id": "<client uuid>", "type": "focus" | "resume", "session_id": "<uuid>" }`.

Server: validates `type` against the enum and both ids as UUIDs; looks the session up in the workspace (404), requires `session.host` (409 `no_host`) and attaches `machine_id` itself; per-workspace limiter separate from webhooks (10/min) and a cap of 10 pending per workspace (429); coalesces — a new pending command for the same `(session_id, type, machine_id)` replaces the older. Stores **in memory only**, modelled on `pairCodes` (map + `expiresAt` + sweep) — a 120 s object must not become a permanent soft-deleted row. Responds `{ id, delivered: true|false }` where `delivered` means a listener for that `machine_id` is currently connected.

State machine: `pending → claimed → done | expired`. Listener `POST /w/:token/commands/:id/claim` body `{ "machine_key": <64 hex, §3.2> }` before acting (403 `wrong_machine` unless the key hashes to the command's `machine_id`; 409 if already claimed — makes execution exactly-once across a LaunchAgent plus a stray manual run). `POST …/:id/ack` body `{ "machine_key": …, "result": "focused" | "activated" | "selected" | "resumed" | "failed", "reach": "pane" | "tab" | "window" | "app" | "thread", "reason": <enum> }`. `reason` ∈ `no-record | remote | not-running | app-not-running | consent-needed | mux-detached | ambiguous | unsupported-host | bad-record | respawn-failed | unsupported-type`. **No free text in acks** — the natural implementation leaks cwd, tty and stderr to every board viewer. At TTL the server broadcasts `command_ack {result: "failed", reason: "expired"}` so every command terminates observably; the phone and the web board also mark a card at 15 s, but provisionally — a later ack still corrects it, and the phone re-polls `GET …/commands/:id` on its next foreground.

SSE: new events `command` (to listeners), `command_ack`, `machine` (presence `{id, name, online, since}` / `{id, online: false, lastSeen}` — no platform or version, which the privacy text does not list); on listener connect (`?listener=<machine_id>&key=<machine_key>&name=…`, 403 `wrong_key` unless the key hashes to the id) the server sends `snapshot`, then a `commands` frame with that machine's unclaimed pending items (no separate GET needed). A session that leaves the board (dismissed, cleared, evicted, expired) fails its pending commands as `superseded`, ack broadcast next to the `remove`. `GET /w/:token/commands/:id` returns the state for a phone that backgrounded (iOS drops SSE on background — `RootView.swift:36-40`) and polls on return.

Legacy single-tenant mode (decided in step 3): the same handlers are mounted in the legacy route group, the command `POST`s and the `?listener=` branch of `GET /events` behind `requireSecret` as every other write is; a plain viewer connect stays open.

Listener connections are counted separately from viewer SSE slots (one per `machine_id`; a new connection for the same id replaces the old — only with the right key), are limited to 30 connects/min per workspace because each one is broadcast to every viewer, reconnect with exponential backoff + jitter (1 s → 60 s), and treat 429 as "sleep 60 s".

## 4. Local record

Written **only when `focus === true`** (a machine without the listener never gains a new file), directory `0700`, file `0600` via temp + rename; the listener refuses records with group/other bits set. Keyed `sessions/<session_id>/<pid>.json` because two live agents can share a session id; `SessionEnd` stamps `ended_at` on only the record whose `pid` equals the ending agent's pid and keeps the file, so the listener can answer "not running" honestly and still knows where a later-resumed session last ran. GC at listener start and daily: records with `ended_at` older than 7 days, or `written_at` older than 30 days and a dead pid. _Deviation resolved 2026-09-13: the reviewed draft had `SessionEnd` delete the record; the shipped hook stamps `ended_at` and leaves removal to GC, and this section now describes the hook._

**Cost discipline.** Detection (a `ps` for the tty, one `ps -axo pid=,ppid=,comm=` for the walk, an Info.plist read, `tmux display-message` under tmux) measured ~30 ms in-process, ~50 ms wall **[V]** — fine against the 3 s budget, but it is three-plus spawns on every `PreToolUse`, which fires between every tool call. So: run detection only when this session's directory holds no live record this hook can claim, or the pid/tty changed, or `written_at` is older than 6 h; otherwise one `readFileSync` and a `written_at` bump.

> **Deviation, 2026-09-16.** The key was `(session_id, pid)` as written, and that never hit for Codex under fish or nu: the hook reads with its own `process.ppid` but the record is filed under the agent pid the process-tree walk resolved, and under a wrapper shell those differ — and the wrapper's pid changes every invocation. So the steady state was a full `ps -A -ww` on every `PreToolUse`, and `ended_at` was never stamped. The lookup now scans the session's directory for a record whose pid is alive and whose whitelisted env matches this hook's, which is stable across invocations. Two live agents sharing a session id and a terminal env is the one case the env guard cannot settle, so that returns nothing and detection files this agent its own record — adopting either would leave the other with no record, and so no `ended_at`, for the whole session. Run it with `Promise.all` beside `readStdin()`, never in front of the POST. Read Info.plist with `fs` + a small regex, not `defaults`/`plutil`.

```json
{
  "v": 1, "session_id": "…", "agent": "claude" | "codex", "agent_pid": 7449, "agent_comm": "claude",
  "entrypoint": "cli" | "sdk-cli" | "claude-desktop" | "codex-desktop" | "codex-exec" | "codex-tui",
  "written_at": 1789286585, "ended_at": null,
  "tty": "/dev/ttys002", "cwd": "/abs/path", "transcript_path": "…",
  "project_root": "/abs/path/to/repo-root",
  "app": { "bundle": "com.umputun.agterm", "path": "/Applications/agterm.app", "pid": 662, "via": "ppid-walk" | "env" },
  "env": { "…whitelisted keys only…" },
  "mux": { "kind": "tmux", "target": "main:@3.%7", "socket": "/private/tmp/tmux-501/default" },
  "codex": { "thread_id": "…", "root_thread_id": "…", "parent_thread_id": null, "originator": "Codex Desktop", "source": "vscode" },
  "bins": { "agtermctl": "/opt/homebrew/bin/agtermctl", "tmux": "…", "herdr": "/opt/homebrew/bin/herdr", "kitten": "…", "wezterm": "…", "code": "…", "claude": "/Users/x/.local/bin/claude", "codex": "/Applications/ChatGPT.app/Contents/Resources/codex" },
  "path": "<the agent's $PATH, local only>"
}
```

Env whitelist (absent keys omitted; never a dump): `TERM_PROGRAM TERM_PROGRAM_VERSION TERM __CFBundleIdentifier TERMINAL_EMULATOR AGTERM_SESSION_ID AGTERM_WINDOW_ID AGTERM_WORKSPACE_ID AGTERM_SOCKET GHOSTTY_SURFACE_ID GHOSTTY_BIN_DIR KITTY_WINDOW_ID KITTY_PID KITTY_LISTEN_ON KITTY_INSTALLATION_DIR ITERM_SESSION_ID TERM_SESSION_ID WEZTERM_PANE WEZTERM_UNIX_SOCKET WEZTERM_EXECUTABLE ALACRITTY_WINDOW_ID ALACRITTY_SOCKET WARP_IS_LOCAL_SHELL_SESSION VSCODE_PID VSCODE_GIT_ASKPASS_MAIN CURSOR_TRACE_ID ZED_TERM CLAUDE_CODE_SSE_PORT CLAUDE_CODE_HOST_SESSION_ID TMUX TMUX_PANE HERDR_ENV HERDR_SOCKET_PATH HERDR_SESSION HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_PANE_ID HERDR_CLIENT_SOCKET_PATH HERDR_BIN_PATH ZELLIJ ZELLIJ_SESSION_NAME ZELLIJ_PANE_ID STY WINDOW WT_SESSION WT_PROFILE_ID WSL_DISTRO_NAME WSL_INTEROP ConEmuHWND WINDOWID DISPLAY WAYLAND_DISPLAY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP SWAYSOCK HYPRLAND_INSTANCE_SIGNATURE KONSOLE_DBUS_SERVICE KONSOLE_DBUS_SESSION KONSOLE_DBUS_WINDOW GNOME_TERMINAL_SERVICE SSH_CONNECTION`.

Rules: multiplexer vars override `TERM_PROGRAM` (they are set later in the chain). `mux.target` for tmux is Claude Code's own recipe, `tmux display-message -p -t $TMUX_PANE '#{session_name}:#{window_id}.#{pane_id}'`. For Herdr, `mux` is `{ kind: "herdr", target: $HERDR_PANE_ID, socket: $HERDR_SOCKET_PATH }` — the ids are already public and stable, so no `display-message` equivalent is needed. For Codex, read the first line of `transcript_path` (`session_meta`) for `id`/`session_id`/`parent_thread_id`/`originator`/`source` — this is where Desktop-vs-TUI and root-vs-sub-agent come from **[V]**. `project_root` = nearest ancestor of `cwd` containing `.idea/` (JetBrains), a `~/.claude/ide/<port>.lock` `workspaceFolders` entry (VS Code with the Claude extension), or `.zed/`; computed once, cheaply, at hook time so the listener never guesses. WSL: detect via `WSL_DISTRO_NAME` and write state to the Windows-side location (`/mnt/c/Users/<user>/AppData/Local/AgStatus/`) with `platform: "windows"`, so a Windows-side listener finds it even when the VM is down.

## 5. Listener

### 5.1 Trust rules (the part reviewers called a blocker)

- **argv only.** Every launch is `execFile`/`spawn` with an argument array and `shell: false`. Nothing from the record is ever interpolated into a shell string, an AppleScript source, or a `.command` file.
- **Hosts that only accept a command string** (Terminal.app `.command`/`do script`, iTerm2 `create window … command`, `screen -X screen`, `tmux new-window`, `agtermctl --command`, Warp launch configs) get the fixed text `"<abs>/agstatus-resume" <session-uuid>` and nothing else. `agstatus-resume` is the listener's own launcher: it validates the UUID (`^[0-9a-f]{8}-…$`), checks that resume is still switched on and that no record for the session is still alive (a re-delivered command must not put two `--resume <uuid>` on one transcript), loads the record itself, `chdir`s to the recorded cwd, and `execFile`s the pinned agent binary with exactly `['--resume', uuid]` (Claude) or `['resume', uuid]` (Codex). Never a prompt, never `-c`. Two consequences of "nothing else interpolated, ever": the script carries no state directory, so `resume-exec` resolves the **platform default** — the host hands it no environment of ours (`runPlan` gives a step `PATH` alone, `open -n -b` hands the app launchd's environment) — and an install that set `AGSTATUS_STATE_DIR` therefore withholds `facts.launcher` and answers `unsupported-host` rather than ack a `resumed` for a window that found no record and closed; and because it is a wrapper and not an `execv`, it holds SIGINT/SIGQUIT (no-op handlers) and forwards SIGTERM/SIGHUP while the agent runs, or the first Ctrl-C would kill the wrapper the terminal is watching and take the resumed session's window with it. This matters for Codex in particular: `codex resume [SESSION_ID] [PROMPT]` accepts a positional prompt and `-c key=value` overrides that can widen the sandbox **[V]**.
- **osascript** is invoked with `on run argv` and the tty/cwd passed as arguments, never spliced into the script; `do script` uses `quoted form of`.
- **The record is data, not instructions.** Validate at the listener, independent of the server: `session_id`/`machine_id` UUID; `tty` `^/dev/ttys[0-9]{3,4}$`; `agent_pid` integer that resolves to a live process whose `comm` equals `agent_comm`; `cwd` absolute, no control chars, `stat()` a directory owned by the listener's uid; bundle ids `^[A-Za-z0-9.-]{3,128}$` **and present in the listener's own strategy table** for anything beyond `open -b`; `app.path` is never taken from the record — resolve it via `mdfind kMDItemCFBundleIdentifier == …` or the bundle table; per-host id regexes (`KITTY_WINDOW_ID`/`WEZTERM_PANE` integers, `AGTERM_*` UUIDs, `ITERM_SESSION_ID` `^w\d+t\d+p\d+:[0-9A-F-]+$`, tmux target Claude's `/^[A-Za-z0-9_.-]{1,64}:@?\d{1,6}\.%?\d{1,6}$/`, Herdr ids `^w\d{1,6}$` / `^w\d{1,6}:t\d{1,6}$` / `^w\d{1,6}:p\d{1,6}$`); socket paths must exist, be sockets, and be owned by the uid. Anything failing → `failed / bad-record`, no action.
- **Binaries are resolved by the listener, never from PATH.** Order: `record.bins` (captured under the user's shell PATH at hook time) → `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` → `<bundle>/Contents/MacOS/<tool>` (agtermctl, kitten, wezterm) → `/Applications/ChatGPT.app/Contents/Resources/codex`. The LaunchAgent plist also sets `EnvironmentVariables.PATH` to the installer's PATH, and respawns run with `record.path`. `agstatus listener doctor` prints what resolved.
- **Guards.** Per-session **and per command type** cooldown (one focus per 2 s, one resume per 2 s — keyed on the session alone the cooldown would swallow the Resume tap the focus that just failed produced, which is the only tap the board offers in that window), one respawn per session per 60 s, at most 5 respawns per 10 min machine-wide, and a circuit breaker that ignores commands for 5 min after 20 in a minute — all logged. The two respawn counters live in `<state>/respawns.json` (0600, pruned to their windows), not in the process: the LaunchAgent is `KeepAlive` with a 10 s throttle, so an in-memory ledger would be re-armed by every crash, log-out or `launchctl kickstart`, and "5 per 10 min machine-wide" would bound one process lifetime rather than the machine.
- **`SSH_CONNECTION`** means remote only when no multiplexer is present or the resolved mux client's tty belongs to sshd; a tmux server started over SSH and attached locally is not remote.

### 5.2 Decision ladder (macOS)

```
0  machine_id ≠ mine → ignore.  no record → failed/no-record.  remote → failed/remote.
1  alive := agent_pid live ∧ comm == agent_comm ∧ tty matches.
   !alive ∧ type == focus → failed/not-running   (phone offers Resume as a second tap)
2  mux? select inside it: tmux -S <sock> select-window -t @N; select-pane -t %N (+ switch-client);
   zellij --session <name> action focus-pane-id <id>; screen -S $STY -X select $WINDOW;
   herdr: `herdr agent focus <HERDR_PANE_ID>` (or pane.focus over <HERDR_SOCKET_PATH>), expected to switch tab and
   workspace too — else tab.focus / workspace.focus with the recorded ids [I]. No attached client → failed/mux-detached.
   Then resolve the ATTACHED client: tmux list-clients -F '#{client_pid} #{client_tty} #{client_activity}' → most recent non-ssh;
   herdr: the `herdr` process that owns a tty and is not `herdr server` (ps -axo pid=,tty=,args=; `herdr status client`
   only describes the binary, and whether session.snapshot lists clients is unverified) [I];
   REPLACE record.env ids with that client's env (ps -E; readable for non-Apple binaries) or, if unreadable
   (/usr/bin/screen, bare zsh), fall to a tty-only outer record → continue at 3 with the OUTER app.
3  by app.bundle:
   com.umputun.agterm            open -b; agtermctl --socket $AGTERM_SOCKET window select $W; session select --target $S --window $W     pane  [V]
   net.kovidgoyal.kitty          KITTY_LISTEN_ON starts with unix: ? kitten @ --to … focus-window --match id:$ID : open -b            pane|app [V]
   com.googlecode.iterm2         open "iterm2:reveal?sessionid=$ITERM_SESSION_ID"                                                     pane  [D]
   com.github.wez.wezterm        wezterm cli list --format json → pane's window is the only/active window? activate-pane + open -b : selected/app  [D]
   com.apple.Terminal            consent + signed sender ? osascript by tty : open -b                                                  tab|app [D]
   com.mitchellh.ghostty         version > 1.3.1 ∧ consent ? osascript focus by tty : 1.3.1 ∧ exactly one terminal with that cwd ? focus : open -b (ambiguous)  tab|app [D]
   com.openai.codex              open -b com.openai.codex "codex://threads/<codex.thread_id ?? root>"                                  thread [V]
   com.anthropic.claudefordesktop open -b                                                                                                app   [V]
   com.microsoft.VSCode          lock file names a workspaceFolder ⊇ cwd ? open "vscode://file/<folder>/" : open -b   (never `-r`)       window|app [D]
   Cursor / Windsurf             open -b   (cursor://file unconfirmed)                                                                  app   [I]
   com.jetbrains.* / dev.zed.Zed project_root known ? open -b <bundle> <root> : open -b                                                window|app [V root-open only]
   anything else with a bundle   open -b                                                                                               app
4  type == resume ∧ !alive → respawn: ONE process, and it is always the launcher (§5.1). As shipped, with
   L := facts.launcher, U := the uuid, D := the working directory the RUNTIME resolved (the planner reads no disk).
   Gates, in order: no L (never installed, not a 0700 file of ours, resume switched off, or a state dir the
   launcher could not find again — §5.1) → unsupported-host;
   entrypoint sdk-cli / codex-exec → unsupported-type; entrypoint claude-desktop → open -b, activated/app (nothing starts);
   then U := UUID_RE(session_id) else bad-record, and D := isAbsPath else respawn-failed — demanded only by rows that spawn.
   com.umputun.agterm            agtermctl session new --cwd D --command "'L' U" --socket $AGTERM_SOCKET; open -b (frontmost)  pane  [D]
   net.kovidgoyal.kitty          kitten @ --to unix:… launch --type=os-window --cwd=D L U; no remote control → the open -n row  pane  [D]
   com.github.wez.wezterm        wezterm cli spawn --new-window --cwd D -- L U (+WEZTERM_UNIX_SOCKET); no binary → unsupported-host  pane [D]
   ghostty / alacritty / rio     open -n -b <bundle> --args --working-directory=D -e L U                                       window [D]
   com.openai.codex              the same deep link step 3 uses — result resumed, reach thread, nothing started               thread [V]
   com.apple.Terminal, iterm2    command *string* only, through Apple events or a .command file → unsupported-host (v1.1, §5.4)
   Warp/Hyper/Tabby/Xcode, VS Code/Cursor/Windsurf, JetBrains/Zed, unknown bundle → unsupported-host; malformed bundle → bad-record
   mux: tmux -S S new-window -t <session>: -c D "'L' U"  (the session name from mux.target, as the focus row parses it,
        else bad-record — without -t the window lands in whatever session the server calls current);
        herdr agent start <record.agent> --cwd D --focus -- L U (HERDR_SOCKET_PATH=S, argv
        after `--`, never a string), then the outer app's step-3 focus leg; zellij / screen → unsupported-host.               pane  [D]
   Only agterm and tmux take a command STRING, and it is exactly `'L' U`: a launcher path holding ' " or \ loses those two rows
   rather than produce an ambiguous string. record.app.path is never used — `open -n -b` takes the bundle id from the table (§5.1).
   cwd: record.cwd (stat: a directory of ours) → Claude: ~/.claude/projects/*/<uuid>.jsonl, newest first, the first line whose
   `cwd` is a directory of ours (O_NOFOLLOW, ≤1 MiB, ≤500 lines; the folder name is lossy, never decoded) → Codex: `cwd` (top
   level or under `payload`) of the transcript's first session_meta line.
   Runtime guards (§5.1), on the plans that respawn: one per session per 60 s, 5 per machine per 10 min → failed/respawn-failed
   with nothing launched. Every respawn step gets 15 s instead of 5 (a terminal cold start); a step that exits non-zero →
   failed/respawn-failed, never unsupported-host. The launcher is never argv[0] of a step, so the runner's allow-list is
   unchanged: it is an argument of the host's own tool, or the quoted half of the one command string.
   Everything after the step that starts the agent is `optional` (the `open -b` raise of agterm's row, the outer app's whole
   focus leg after a mux respawn): the session exists, and a failed raise must not report that nothing came up.
   Evidence, because exit 0 proves nothing here — `open -n -b` returns as soon as LaunchServices takes the request, and the
   window may then close with "no local record" in it: after the last step the runtime polls `<state>/sessions/<id>/` for up
   to 12 s for a record the hook did not write before (a new pid, or a newer written_at, at SessionStart). None → failed/
   respawn-failed. Only then is the ack `resumed`.
5  verify: poll `lsappinfo front` ≤ 500 ms; ack focused/activated only if the target bundle is frontmost, else `selected` — macOS keeps the current app in front while the user is typing [V].
6  ack {result, reach, reason}; log {id, plan, per-step exit codes, frontmost before/after}.
```

The strategy table is a **pure planner** `plan(record, machine) → { steps: argv[][], reach, experimental }` so every row is unit-testable with fixture records on CI (which has none of these terminals). `agstatus listener plan <session_id>` prints the plan without executing. Rows marked **[D]/[I]** ship as `experimental: true`: the ack carries it, the phone shows "experimental", and a maintainer checklist (exact command, `lsappinfo front` before/after) promotes a row.

### 5.3 Windows and Linux

Windows: run at logon in the interactive session (Scheduled Task), never a service. Windows Terminal is **app-level** (`window` only when exactly one WT window exists): raise via PowerShell `EnumWindows` over `CASCADIA_HOSTING_WINDOW_CLASS` + the ALT-key/`AttachThreadInput` trick before `SetForegroundWindow` — never dispatch a `wt` command to summon, there is no no-op and `focus-tab` moves the user's tab **[D]**. Ignore `WT_SESSION` when `TERM_PROGRAM=vscode`. Classic conhost: `AttachConsole(pid) → GetConsoleWindow()` gives a raisable window; pseudoconsole gives a fake one **[D]**. WSL respawn: `wt.exe -w new nt -d … wsl.exe -d <distro> --cd <cwd> -- <launcher> <uuid>`.

Linux: X11 → pane via terminal IPC where present, window via `xdotool windowactivate $WINDOWID` (xterm/Alacritty/Konsole set it; gnome-terminal does not) **[D]**. Wayland → pane/tab selected via IPC (kitty, WezTerm, Konsole D-Bus, Ghostty `present-surface`); window raise only via `swaymsg '[pid=N] focus'`, `hyprctl dispatch focuswindow pid:N`, `kdotool`; GNOME → ack `selected`, reason `unsupported-host`, hint "install the Window Calls extension" **[D]**. `app.slug` on Linux from the env table (`GNOME_TERMINAL_SERVICE`, `KONSOLE_DBUS_SERVICE`, `TERM=xterm-kitty`) or exe basename; Flatpak/Snap terminals unsupported beyond `app`.

### 5.4 Packaging

- **v1 (macOS):** Node process, LaunchAgent (`agstatus listener install | uninstall | status | doctor | plan`). Only prompt-free strategies: agterm, kitty, iTerm2 URL, WezTerm CLI, deep links, `open -b`, JetBrains root-open, respawn via `open`/launcher. Terminal.app and Ghostty degrade to `open -b` and say so.
- **v1.1:** a signed `AgStatus Listener.app` (or a future menubar app) as the Apple-events sender, so the AppleScript strategies can be approved once per target app.
- The installer is the **only** writer of `focus: true`: interactive, prints the exact `host` object that will be sent, merges into `~/.agstatus.json` (never overwrites `url`/`secret`), resolves the board URL with the same precedence `agstatus status` already uses (`~/.claude/settings.json` env → Codex `hooks.json` command → file), refuses to install when those disagree, writes the file `0600`. `agstatus listener uninstall` sets `focus: false` (so live cards clear), removes the LaunchAgent, the log and the resume launcher (nothing that starts a session outlives the listener), and with confirmation the sessions directory; `agstatus uninstall` calls it. `AGSTATUS_FOCUS=off` env overrides the file.
- The Node SSE client is hand-rolled (no `EventSource` in Node 24, zero-dependency rule): fetch + stream frame parser + reconnect/backoff + idle watchdog + 429 handling, ~80 lines; `main()` must return a never-resolving promise so the agent stays up.

## 6. Capability matrix — what the board may promise

`Reach`, `Mechanism` and `Needs` describe **focus**; `Resume` is what a second tap does on a session that is gone (§5.2 step 4), as shipped in v1 — every entry in it that starts a process is `experimental: true` until §10 clears it.

| Host | Reach | Mechanism | Needs | Status | Resume |
|---|---|---|---|---|---|
| agterm | pane | agtermctl | listener | **[V]** | pane — `agtermctl session new --command "'L' U"` |
| kitty | pane | `kitten @ focus-window` | `allow_remote_control` + `listen_on unix:` | **[V]** | pane — `kitten @ launch --type=os-window`; without remote control, window via `open -n` |
| Codex Desktop | thread | `codex://threads/<id>` | listener | **[V]** | thread — the same link (reopens an archived thread; nothing is started) |
| JetBrains (open project) | window | `open -b <ide> <root>` | project root resolvable | **[V]** | — no agent session to resume |
| iTerm2 | pane | `iterm2:reveal` URL | — | [D] experimental | — command string needs the signed sender (v1.1) |
| WezTerm | pane (single window) / app | `wezterm cli activate-pane` + `open -b` | — | [D] experimental | pane — `wezterm cli spawn --new-window -- L U` |
| Terminal.app | tab | AppleScript by tty | Automation consent, signed listener (v1.1) | [D] | — `.command` file or Apple events (v1.1) |
| Ghostty > 1.3.1 | tab | AppleScript by tty | same | [D] | window — `open -n -b … --args --working-directory=D -e L U` |
| Ghostty 1.3.1 | tab only if cwd unambiguous, else app | AppleScript by cwd | same | [D] | window — same `open -n` row |
| tmux / zellij / screen | pane, then the outer terminal's reach | mux CLI + client resolution | — | [V tmux-shape, I zellij/screen] | tmux: pane — `new-window -c D "'L' U"`, then the outer app's focus leg; zellij / screen: — |
| Herdr | pane, then the outer terminal's reach | herdr CLI/socket + client resolution | herdr running | [V env+CLI, I focus] | pane — `herdr agent start … --focus -- L U`, then the outer app's focus leg |
| VS Code (+ Claude extension) | window | `vscode://file/<folder>/` | lock file | [D] | — the deep link needs the extension and the right window (v1.1) |
| Cursor, Windsurf, Zed | app | `open -b` | — | [I] | — |
| Alacritty, Rio | app | `open -b` | — | [V/D] | window — the `open -n` row |
| Warp, Hyper, Tabby, Xcode | app | `open -b` | — | [V/D] | — no command from `open` |
| Claude Desktop | app | `open -b` | — | **[V]** | app — activated, nothing started (no documented resume link) |
| Headless: `claude -p` / Agent SDK, `codex exec` | — | — | — | — | — never respawned (`unsupported-type`) |
| Windows Terminal | app (window if single) | EnumWindows + foreground trick | interactive-session listener | [D] | — (with the Windows listener: `wt.exe -w new nt -d …`) |
| conhost | window | `SetForegroundWindow` + trick | same | [D] | — |
| Linux X11 | window (+ pane via IPC) | `xdotool` / terminal IPC | xdotool | [D] | — |
| Linux Wayland — Sway/Hyprland/KDE | window (+ pane via IPC) | compositor IPC | — | [D] | — |
| Linux Wayland — GNOME | selected only | terminal IPC | Shell extension for raise | [D] | — |
| SSH-remote session (no mux) | none | — | — | — | — |
| No record / no host | none | — | — | — | — |

`L` is `<state>/agstatus-resume`, `U` the session uuid, `D` the resolved working directory. A `—` under Resume is `failed / unsupported-host` (or `unsupported-type` for the headless row), never a half-working attempt. Resume is on by default and switched off per machine with `"resume": false` / `AGSTATUS_RESUME=off`, which empties this whole column (§11).

## 7. Board UX

- The affordance is an **explicit control**, never the default tap (which is history on all three boards) and never the default notification tap (which users rely on to read a push). iOS: a footer button "Bring to front on <machine>" plus `.accessibilityAction(named:)` and a context-menu entry; a `UNNotificationAction` on the blocked/idle category; the push payload is unchanged — the app resolves the session's `host.machine.id` from its own snapshot by `threadIdentifier`. Android: icon button; web: a `[data-focus]` button beside dismiss.
- Enabled only when `session.host` is present **and** that machine is online per `machine` presence; otherwise disabled with "MacBook offline since 5 min" / "Bring-to-front needs the AgStatus listener on that machine" (link to docs). Never an error state for `host: null`.
- After tap: "Sent" → ack copy keyed to reach (`focused`: "Brought to front on Mac"; `activated`: "Opened agterm on Mac — couldn't find the tab"; `selected`: "Selected the pane; window stayed behind"; `failed/not-running`: "Not running — Resume?" with a second button). At 15 s the card says "No answer from Mac yet — is it asleep?" without settling: the answer can still arrive, so the give-up waits out the server TTL (§3.3). An outcome this side merely guessed — that deadline, or a POST whose response was lost — is marked correctable, and a later ack overrides it; anything the machine or the server actually said is final.

## 8. Privacy and docs

The public promise today (`docs/privacy.md:13-15`, `public/privacy.html`, `public/landing.html:631`, `README.md`, `SECURITY.md:37-39`, `docs/hooks.md`) is "session id, project folder name, status word, short message — nothing else". It stays true for every machine with Focus off. For machines with Focus on, add one section, same wording in every place (the trigger is phrased as state, not as a command, because `"focus": true` can also be set by hand):

> **Focus (optional).** Focus — tapping a session on the board to bring its terminal to the front on the machine running it — is off by default. If Focus is turned on for a machine (`agstatus listener install`, or `"focus": true` in `~/.agstatus.json`), status updates from coding agents on that machine additionally include: a short label you chose for the machine (default "Mac"), a random identifier specific to this board and this machine, and the name and kind of the app the session is running in (for example "agterm, terminal"). The listener keeps a connection open to your board so it can receive taps; it sends nothing but the acknowledgement of a tap. Nothing about your files, folders, terminal, or environment leaves the machine — those details stay in a local file only the listener reads, and are removed when Focus is turned off and the listener is uninstalled (the listener ships in a later release). Turning Focus off clears the labels from your board. Machines with Focus off send exactly what the table above lists.

`docs/api.md` gains the `host` field, the `/commands` routes, the new SSE events, and the listener-slot budget. `SECURITY.md` scope gains the listener. `docs/hooks.md` gains `focus` and `AGSTATUS_FOCUS`.

## 9. Rollout (each step ships independently; compatibility verified)

1. **Hook** — local record (opt-in, cached detection, `0600`, per-pid), `host` summary, `host: null` on opt-out; `npm run sync:plugin`; tests with `HOME` pinned to a mkdtemp (the CLI harness spreads the real env — `cli/test/messages.test.ts:66-81`) asserting whitelist behaviour, the byte-identical payload when `focus` is absent, and a `cwd` containing `'";$(…)` never appearing in any generated launch. Also the one Codex experiment: does changing the hook script's *content* invalidate trust? Record the answer here.
2. **Server** — `parseHost()`, column/ALTER/load/merge/SQL, scrub on soft delete, APNs payload test, docs.
3. **Server commands + presence** — in-memory command map with claim/ack/expire, `?listener=` presence, `machine`/`command`/`command_ack` events, limits, legacy mounting decision, tests mirroring `test/sse.test.ts`.
4. **Listener core (macOS)** — SSE client, record loader + validator, planner + fixtures for every row, launcher, LaunchAgent + PATH, `install/uninstall/status/doctor/plan`, log. Strategies: agterm, kitty, iTerm2, WezTerm, deep links, `open -b`, JetBrains.
5. **Respawn** — ✅ shipped 2026-09-15: `<state>/agstatus-resume` (0700, absolute paths baked in) and `agstatus listener resume-exec <uuid>`, one respawn row per host in the planner, the cwd resolution (record → transcript), the runtime guards (60 s per session, 5 per 10 min, 15 s per step, non-zero step → `respawn-failed`), `facts.launcher` gated on `resumeEnabled()`, `--no-resume` / `"resume": false` / `AGSTATUS_RESUME=off`, and `agstatus listener plan <id> --resume`. Every row that starts a process is `experimental` until §10.
   Review pass, 2026-09-16 — what the adversarial read changed: the focus cooldown is keyed by command type, so the Resume tap the board offers is never swallowed (blocker); the launcher holds SIGINT/SIGQUIT and forwards SIGTERM/SIGHUP, so Ctrl-C no longer closes the window it just opened (blocker); a respawn must produce a record before it acks `resumed`; the respawn ledger persists in `<state>/respawns.json`; `resume-exec` honours the switch and refuses a session that is still running; `install --no-resume` and `uninstall` delete the launcher and `AGSTATUS_RESUME=off` travels into the plist, so "off" is what `status`/`doctor` report and what the listener does; an install with a non-default `AGSTATUS_STATE_DIR` withholds the launcher instead of acking a resume that never happened; the tmux respawn names its session; the raise legs after a respawn are optional; `CODEX_ID_RE` is anchored on a hex digit; the transcript read adds `O_NONBLOCK` and the launcher's temp file is an exclusive create.
6. **Boards** — iOS/Android/web control + presence + ack copy; notification action.
   Review pass, 2026-09-16 — one bug wore four faces: every client treated a deadline *it* had called
   as a final answer, so a genuine ack arriving inside the server's TTL was dropped by a `done` guard
   and the card sat on a failure over a window that was in fact in front. All three clients now
   separate what the machine said from what the client guessed (`inferred` on the web, `provisional`
   on iOS and Android); only the former is final. iOS also ran the snapshot reconcile in an
   unstructured `Task`, so `disconnect()` could not cancel it and it re-armed the very deadline it
   had just dropped.
7. **One-command install** — ✅ shipped 2026-09-16: `curl -fsSL https://agstatus.online/install.sh | sh`
   and `irm https://agstatus.online/install.ps1 | iex`, installing into `${AGSTATUS_HOME:-$HOME/.agstatus}`
   with the launcher shim at `<prefix>/bin/agstatus` resolving Node at launch. The plist no longer names
   a Node at all: launchd resolves `ProgramArguments[0]` against its own default PATH
   (`/usr/bin:/bin:/usr/sbin:/sbin`) and never against the job's `EnvironmentVariables.PATH` **[V]**,
   so argv[0] must be an absolute path we own and Node must be found at launch — which also makes a
   `brew upgrade node` or an `nvm uninstall` self-healing rather than fatal. The resume launcher
   collapses to one baked path. Focus installs by default here (`--no-focus` opts out), npm/npx/Homebrew
   are retired as documented channels, and the release publishes its own self-contained artifact.
8. **v1.1** — signed listener app and the AppleScript strategies; Windows and Linux listeners.

## 10. Smoke tests that must pass before a row leaves "experimental"

agterm with two open windows (`window select` raising a non-active window was not exercised); iTerm2 after moving a tab between windows (whether `reveal` matches the UUID alone); WezTerm with two OS windows; Ghostty 1.3.1 with two tabs in one repo; Terminal.app and Ghostty AppleScript from the signed sender (never executed — TCC); kitty with `listen_on` as `fd:` and with a > 104-byte socket path; tmux attached from a second terminal after detach; Herdr: focus a pane from outside while a client is attached (does `agent focus` switch workspace and tab as well?) and against a detached `herdr server` (expect `mux-detached`, never a respawn); Codex sub-agent thread tap (root id lands on the parent view, sub-agent id opens its own); the Windows foreground trick on Win 11; GNOME Wayland with and without Window Calls.

Respawn rows (§5.2 step 4), none of them yet run against a real host: agterm `session new --command` (does it take the string as one command, and is the new session focused?); `kitten @ launch --type=os-window` against a kitty with remote control, and the `open -n -b net.kovidgoyal.kitty --args --working-directory=` fallback against one without (kitty documents `--directory`, with `--working-directory` only as a later alias); `wezterm cli spawn --new-window` with and without a running mux server; `open -n -b … --args --working-directory=D -e L U` on Ghostty, Alacritty and Rio (each takes `-e` differently); `tmux new-window -c D "'L' U"` with the client attached and detached; `herdr agent start --focus -- L U` (does it land in the recorded workspace and tab?); a Codex Desktop resume of an archived thread. Also: a resume whose recorded cwd is gone but whose transcript still names it, and the two guards under a double tap.

## 11. Open decisions

- ~~Legacy single-tenant: mount commands there, or declare Focus multi-tenant only?~~ Mounted, behind the secret (§3.3).
- Do we want the wire summary at all, or the leaner variant (§12)?
- Ghostty: is the AppleScript `terminal.id` equal to `GHOSTTY_SURFACE_ID`? Irrelevant while we join on tty/cwd; worth knowing.
- ~~Should `resume` be gated behind a second per-machine opt-in?~~ **Decided 2026-09-15: no, it ships on, with a switch.** Resume is already explicit per use — the phone only offers it after a focus came back `not-running`, so it takes a second, deliberate tap. The launcher can do exactly one thing: run the recorded agent binary with `--resume <uuid>` in the recorded directory, never a prompt and never a `-c` override. The respawn guards (one per session per minute, five per machine per ten minutes) bound a leaked token to a handful of terminal windows holding the user's own sessions. A second opt-in would instead show a button that fails until the user runs another command, which is worse for everyone and no safer. `"resume": false` in `~/.agstatus.json` (or `listener install --no-resume`) turns it off for the cautious, and off means the launcher is deleted, not merely unused — `resume-exec` refuses as well, so the mechanism is not left installed behind a flag. `AGSTATUS_RESUME=off` is read from the listener's own environment, which is the plist's: the installer copies the variable into it when it is set at install time, precisely so `status` and `doctor` never report an "off" the running listener has never heard of.
- Herdr's native session restore keys on an agent session id it learns via `herdr pane report-agent-session <pane_id> --source ID --agent LABEL --agent-session-id ID --agent-session-path PATH`. The hook already holds all four values at `SessionStart`; calling it would let Herdr resume the same Claude/Codex session on its own. Not implemented — it would be the first time the hook writes *to* a host rather than only reading it, and Herdr's public docs describe 0.9.0 while this Mac runs 0.7.0.

## 12. The leaner alternative, for the record

Skip the wire `host` field entirely. Hooks stay byte-identical for everyone; only listeners identify themselves on connect (label + per-board id). Commands broadcast to every listener on the board; the first listener with a local record claims; no claim before TTL → expired. This removes every privacy-doc touchpoint and the carry-forward/scrub work. Costs: no per-card "where" label, no per-card offline state (only "any listener online"), and a full TTL wait to learn that no machine had the session. It is a legitimate v1 if the label turns out not to matter; the design above chose the label because it was asked for.
