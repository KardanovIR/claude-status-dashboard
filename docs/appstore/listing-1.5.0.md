# App Store listing copy — 1.5.0

Paste into App Store Connect. Character counts are Apple's limits.

> **Note on scope.** The store has served **1.3** since 8 September, so everyone
> updating has never seen 1.4 either. "What's New" below covers both releases,
> not just the latest tag. Focus is the headline — it is the first thing in this
> app that reaches back to the computer instead of only reporting from it.

---

## Promotional text (170 max)

Shown above the description, and editable without shipping a build.

**Option A — the new capability (152 chars)**

```
Tap a session on your phone and its terminal comes to the front on your Mac. Every Claude Code and Codex agent at a glance, and one tap to the right one.
```

**Option B — the problem it solves (168 chars)**

```
Your coding agents stop and wait for you without saying so. AgStatus puts every Claude Code and Codex session on one screen, and brings the stuck one to the front.
```

**Option C — shortest (119 chars)**

```
See every Claude Code and Codex session at a glance. Tap the one that needs you — its terminal comes to the front.
```

Option A is the recommendation: it leads with the thing no previous version could do.

---

## What's New in This Version (4000 max — this is ~1,980)

```
Tap a session, and its terminal comes to the front.

FOCUS
The board used to be read-only: it told you an agent was waiting and left you to
find the window yourself. Now tapping a session raises its terminal on the
machine running it — across Terminal, iTerm, Warp, VS Code, Ghostty, kitty,
Alacritty and tmux. If the session has already ended, the app offers to resume
it instead. Focus is opt-in and set up by the installer on macOS; a machine that
has not enabled it simply shows no Focus control.

Cards now say which machine a session is on, so two runs of the same project on
two computers are no longer indistinguishable.

A REDESIGN BUILT FOR GLANCING
The board is read from across a room, out of the corner of your eye, often late
at night. So the whole card surface now carries its state as a tint rather than
a thin stripe, legible from much further away, and colour is ranked by who is
waiting — blocked and done carry it, the busy states recede. Every colour was
checked for contrast against every tinted surface.

The badge no longer pulses forever on active cards: nothing moves unless
something actually changed, which is easier on the eyes and on the battery.
Reduce Motion is now honoured — the app claimed to and never did.

"TURN FINISHED" IS A REAL STATE
A session that handed back used to read "Waiting for input", the same words as a
session nobody had asked anything of yet. Finishing a turn is now its own state,
so the board distinguishes an answer waiting to be read from an agent sitting
idle. If you have the optional push turned on, it fires on that transition.

TOKENS PER SESSION
Usage already showed which project spent your plan; it now shows which session,
so two agents working in one repo are no longer added together.

ALSO
• Cards stop renaming themselves when a session changes directory
• A card whose machine went offline says so, instead of offering a control that
  cannot work
• Plan-limit bars warn in amber before they reach red
• A slow reply no longer shows as a failure
• Setting up your computer is now one command: the installer replaces npx and
  Homebrew, and pairing from this app passes straight through it
```

---

## Not changing

Description, keywords, category, age rating and the privacy answers all carry
over. The app still only reads a board; the new per-session and per-project
numbers are reported by the hook on the user's own machine, not collected by the
app, so the privacy nutrition labels are unaffected.

## Screenshots

All three slots regenerated from 1.5.0 in demo mode — see
[README.md](README.md) for sizes and the capture recipe.
