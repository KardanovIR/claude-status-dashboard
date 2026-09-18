# What Focus can and cannot reach

Focus is the feature where you tap a session on the board and the terminal
running that agent comes to the front on the machine it runs on.

This page is the honest version of where that works. It is written from the
listener's source, not from intentions: the supported set below is a literal
transcription of the table in `cli/src/listener/plan.ts`.

**The two sentences that answer most questions:**

1. **Focus is macOS-only.** There is no Linux or Windows listener. The
   installers on those platforms deliberately install nothing and say so.
2. **Support is a closed list, not a capability.** The listener raises apps it
   has an entry for. An app it does not recognise is refused outright rather
   than attempted — you get `unsupported-host`, not a silent failure.

---

## What works today

Everything here is macOS. "Exact" means the specific tab, pane or session is
selected. "App only" means the application comes forward and whatever was last
focused inside it stays focused.

### Exact

| Host | How | Notes |
| --- | --- | --- |
| **agterm** | `agtermctl window select` + `session select` | window and session |
| **Herdr** | `herdr agent focus <pane>` | pane |
| **tmux** | `select-window`, `select-pane`, `switch-client` | pane, then the outer terminal is raised |
| **Zellij** | `zellij action focus-pane-id` | pane |
| **GNU screen** | `screen -X select` | window |
| **kitty** | `kitten @ focus-window --match id:` | **only if you configured `allow_remote_control` and a `listen_on unix:` socket** — off by default |
| **iTerm2** | `iterm2:reveal?sessionid=` | session |
| **WezTerm** | `wezterm cli activate-pane` | pane |
| **Codex Desktop** | `codex://threads/<id>` | the thread |
| **JetBrains IDEs, Zed, Android Studio** | `open -b <bundle> <project root>` | the project window |

### App only

Terminal.app · Ghostty · Alacritty · Warp · Hyper · Tabby · Rio · Xcode ·
VS Code · VS Code Insiders · Cursor · Windsurf · Claude Desktop

For these the app comes forward and that is all. The reason is the same for most
of them and is worth stating plainly: **tab-exact focus in Terminal.app and
Ghostty needs Apple Events, and the listener sends none.** A plain Node process
cannot send Apple Events without triggering a consent prompt for every app it
touches, so the mechanism waits for a signed helper app in a later release.
There is no AppleScript anywhere in the shipped listener.

---

## What does not work, and why

### Linux and Windows — no listener exists

Not "degraded". Absent. `agstatus listener install` refuses on any non-Darwin
platform, and the `install.sh` / `install.ps1` scripts skip the listener
entirely rather than install something inert.

`agstatus listener run` is not platform-gated and will start in the foreground
anywhere, but every plan it produces hard-codes macOS binaries (`/usr/bin/open`,
`/usr/bin/lsappinfo`), so app-raising steps fail there. Multiplexer steps
(tmux, Zellij, screen, Herdr) use portable commands and would plausibly select
the right pane while raising nothing — plausibly, because that path has not been
run on Linux and is untested.

Two things worth knowing about the eventual ports, because they are not
symmetrical problems:

- **Windows** can target a *window* (`wt -w <id>`) but not a session. Windows
  Terminal already sets a per-tab `WT_SESSION` GUID and nothing consumes it for
  focus; a request to add that was closed as not planned. `SetForegroundWindow`
  also flashes the taskbar rather than raising, for an unprivileged caller.
- **Wayland** is structurally hostile rather than merely unimplemented: a
  background daemon cannot hold a valid activation token by construction. This
  is not a gap we can close by writing more code, and it matters — Wayland is
  now the default session on mainstream desktops.

### No window exists at all

These are not failures to fix. There is genuinely nothing to raise, and the
board should say so rather than offer a button that does nothing:

- **Cloud and web agents** — Claude Code cloud sessions, Codex cloud, Cursor
  cloud agents, Jules, Codespaces and similar. The process is on someone else's
  VM.
- **Headless runs** — `claude -p`, the Agent SDK, `codex exec`. The listener
  refuses these explicitly; there is no terminal they belonged to.
- **Detached multiplexer sessions.** A detached tmux session has no attached
  client and therefore no window anywhere. It gets one again when you reattach.
- **CI runners and headless servers.**

### Remote sessions

**SSH without a multiplexer is refused** (`remote`). The agent is on another
machine; the window you want is the local terminal holding the SSH client, and
the listener does not currently follow that chain.

**SSH with tmux works**, because tmux gives a join key that survives the machine
boundary: the listener resolves the attached client's tty back to the local
terminal and then selects the pane. This is the one remote case that is properly
supported, and it is worth knowing about.

### Containers and devcontainers — undocumented

There is no container handling anywhere in this repo: no code, no tests, no
documentation. In practice an agent inside a container has no macOS bundle id in
its record and will be refused as `unsupported-host`, but that is inference from
reading the code rather than a tested behaviour, and it is not a promise.

### IDE-embedded terminals

VS Code, Cursor and Windsurf get app-level activation only, and the obstacle is
architectural rather than an oversight: **VS Code runs one shared pty host
process for every window**, so walking up the process tree from an agent lands
on a process that no window owns. Detecting VS Code is trivial; attributing a
session to a *window* needs a side channel.

The likely side channel already exists — the `~/.claude/ide/<port>.lock` files
that Claude Code's own IDE integration writes, one per running IDE. The code
comment in the bundle table already points at it. Not built.

---

## Things this page does not claim

The supported set above is transcribed from the listener's source and I checked
it directly. The surrounding landscape — what other terminals and agent tools
can do, and how common they are — comes from a research pass whose sources I did
not re-verify individually. Where that research reported something as
unconfirmed, it is described here as unconfirmed or left out.

Three specific opportunities it surfaced that are **not** implemented and are
recorded here only so they are not lost:

- **Ghostty 1.3+ ships an AppleScript dictionary** with a `focus` command that
  brings a specific terminal's window to the front. That would move Ghostty from
  app-only to exact — subject to the same Apple Events consent problem that
  holds up Terminal.app.
- **Warp exposes a per-session focus URL** resolving window, pane group and
  pane. It is undocumented, and it is inherited by child processes, so a stale
  value would raise the wrong window. Would need care.
- **Windsurf has been renamed to Devin Desktop.** The bundle id in our table
  (`com.exafunction.windsurf`) may no longer be the shipping one.

Several agent tools in common use have no entry at all: Antigravity, Kiro,
Devin Desktop, Conductor, Nimbalyst, OpenHands' desktop app and Amp among them.
Each would raise only if its bundle id were added.

---

## When Focus declines, what you see

The listener answers with a reason rather than failing quietly:

| Reason | Meaning |
| --- | --- |
| `unsupported-host` | the app is not in the table, or the record carries no bundle id |
| `remote` | an SSH session with no multiplexer |
| `not-running` | the agent's process is gone — this is what makes the board offer Resume |
| `app-not-running` | the app is in the table but is not open on that machine |
| `unsupported-type` | a headless entrypoint that was never a window |
| `no-record` / `bad-record` | nothing usable on disk for that session |
| `respawn-failed` | a Resume started something that never reported back in time |

Three further reasons — `ambiguous`, `consent-needed` and `mux-detached` — are
declared in the wire types and the boards can render them, but no code path
currently emits any of them.

A focus that runs but cannot confirm the app reached the front is reported as
`selected` rather than `focused` — macOS keeps the current app in front while
you are typing, and the listener does not pretend otherwise.
