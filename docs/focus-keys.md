# Focus keys — one key press per agent

`agstatus focus <n>` brings the n-th session's window to the front. Bind it to
six keys and the board becomes something you *drive*: glance at the iPad, press
the key for the agent that needs you, and its terminal is in front of you.

This is the same action as the board's **Focus** button — it needs the
[Focus listener](design/focus-protocol.md) installed (`agstatus listener
install`), and nothing else.

## Slots

```
$ agstatus focus --list
Slot  Session
   1  blocked   claude-status            MacBook/agterm
   2  coding    infra-terraform          MacBook/Ghostty
   3  done      website                  mini/iTerm2  (another machine)
```

`agstatus focus 2` brings session 2's window forward.

**A slot is an assignment this machine holds, not a position in the board's
list.** Once a session is given a number it keeps that number until it leaves
the board; the number it frees is reused by the next session that needs one.
New sessions take the lowest free slot, oldest first.

That indirection is the whole point, and it is worth a paragraph.

The apps freeze a card's position once it is on screen: `stableOrder` in
`ios/AgStatus/SessionStore.swift` keeps every session already visible where it
is and slots only *unseen* ones in, at the top. So the order on your iPad is a
function of what that iPad has seen since it launched — two devices watching
one board can show the same sessions in different orders, and neither order
exists anywhere on the wire. `GET /api/sessions` is `updatedAt` descending, a
third order again, and one that re-ranks whenever an agent posts anything.

Ordering by `createdAt` looks like it would fix that — the field never mutates
— but a *position* in that list still moves. The server removes sessions by
`updatedAt` (`sweepExpiredSessions`) and evicts at a cap, so the session
holding slot 1 can go quiet and vanish while newer ones stay, sliding every
later slot down by one. Your fingers would have learned the wrong number, and
nothing would have told you.

So the mapping is stored, in `focus-slots.json` beside the listener's other
state, per board. Delete that file to renumber from scratch.

Three consequences to know about:

- **The numbers are not on screen.** Keep `--list` handy until the mapping is
  in your fingers, or run it in a spare pane.
- **Slots are not compact.** If the sessions holding 1 and 2 leave the board,
  the next new agent gets slot 1 and the one after it gets 2 — but until then
  your live agents may sit on 3 and 4. `--list` always shows the truth.
- **A slot only frees when its session leaves the board.** On the hosted
  (multi-tenant) board that happens on its own: sessions are swept 24 h after
  their last update, and capped at 50 per board. A self-hosted single-tenant
  board — the default for `docker run` — does neither unless you set
  `SESSION_TTL_MS` (see [self-hosting](self-hosting.md)), so finished sessions
  sit on their numbers until you delete them from the board.

## How a press reaches the window

| where the session runs | what happens |
| --- | --- |
| this machine | The plan is built and run in this process — no command goes to the board, so no board rate limit applies. |
| another machine | A `focus` command is posted to the board and that machine's listener acts on it — exactly what tapping Focus does. |

The local path matters for a keypad. The board accepts **ten commands a
minute per board**; cycling six buttons twice would exhaust that and start
returning `429`. Sessions on the machine you are sitting at never spend it.

Every press still reads `GET /api/sessions` first, to learn which session holds
the slot — so the board has to be reachable either way. Only the focus itself
skips the round trip.

Nothing in this path is TCC-gated: focusing uses `/usr/bin/open` (LaunchServices)
and, for terminals that have one, their own CLI. There is no AppleScript, so
macOS never prompts for Automation or Accessibility. **The hotkey tool is a
different matter** — see below.

## Binding keys

AgStatus does not capture the key itself. A global hotkey needs an event tap or
a HID-level grab — a TCC-gated capability and a background process to hold it —
and the focus path deliberately touches nothing TCC-gated. So a hotkey tool you
already trust listens for the chord and runs `agstatus focus <n>`.

`agstatus keys` shows the mapping and prints the config for that tool:

```
$ agstatus keys
Shortcuts (defaults — none configured):

  ctrl+alt+1         → agstatus focus 1
  ctrl+alt+2         → agstatus focus 2
  ...
```

The defaults are `ctrl+alt+1` … `ctrl+alt+6`. To change them, run
`agstatus keys --write` and edit `"keys"` in `~/.agstatus.json`:

```json
{
  "keys": {
    "1": "ctrl+opt+j",
    "2": "f14",
    "3": "ctrl+shift+cmd+3"
  }
}
```

Modifiers are `ctrl`, `alt` (or `opt`/`option`), `shift` and `cmd` — spell them
however you like, they are normalised. A bare key is refused unless it is
`f1`–`f24`, because binding a bare letter or digit takes it from every app on
the machine. A shortcut used twice, or a typo like `crtl`, is reported and
skipped; the rest still work. `--slots <n>` changes how many slots the defaults
cover, for a pad with fewer or more than six buttons.

### skhd (recommended)

No GUI, so it never steals focus — which matters, because the runner waits up
to 500 ms for the target app to come to the front, and a hotkey tool that
activates itself in that window degrades the focus.

```bash
brew tap koekeishiya/formulae && brew install skhd && skhd --start-service
```

```bash
agstatus keys --skhd >> ~/.config/skhd/skhdrc && skhd --restart-service
```

That writes one line per slot, each running the focus detached so the key press
never waits on the network:

```
ctrl + alt - 1 : /usr/bin/nohup '/Users/you/.agstatus/bin/agstatus' focus 1 >/dev/null 2>&1 &
```

The path is absolute and quoted on purpose: `~` does not expand inside quotes,
and a hotkey tool's environment is not your shell's.

skhd needs **Input Monitoring** (System Settings → Privacy & Security). That is
a grant the hotkey tool needs, not one AgStatus needs.

### Karabiner-Elements

```bash
agstatus keys --karabiner > ~/.config/karabiner/assets/complex_modifications/agstatus.json
```

Then enable it under Complex Modifications. Karabiner is the only option that
can match a *specific device* by vendor and product id, so a macro pad's keys
can act differently from the same keys on your main keyboard — see below.

### Other tools

`agstatus keys` does not generate config for these, but the command it prints
is the same one:

- **Hammerspoon** — `hs.hotkey.bind({"ctrl","alt"}, "1", function() hs.execute(os.getenv("HOME").."/.agstatus/bin/agstatus focus 1") end)`.
  Needs Accessibility. Does not activate on `hs.execute`, so it is focus-safe.
- **Raycast** — already installed for many people. Its hotkeys are assigned in
  its own UI, so there is nothing to generate: put a Script Command per slot in
  a folder, add that folder under Extensions → Script Commands, and give each
  one a shortcut. Use `@raycast.mode silent`. Raycast is an activating app, so
  it is the one option that may interfere with the 500 ms frontmost check.
- **Shortcuts.app** — works, but a hotkey-fired Shortcut is slow (often
  seconds) and flashes UI. Worst fit.

## Using a macro keypad

A macro pad is just a keyboard: it sends keystrokes, and a hotkey tool turns
those into commands. Two ways to wire one up:

1. **Program the pad to send the combos you bound** (`ctrl+alt+1`…`6` by
   default), using whatever configurator it shipped with. Nothing else to do —
   this is the cleanest option when the pad supports it, because the Mac needs
   no per-device setup at all.
2. **Leave the pad alone and remap on the Mac.** `hidutil` translates usages
   *per device*, so the pad's keys become F13–F18 while the identical keys on
   your other keyboards stay exactly as they were.

   This is the better option whenever the pad sends keys that mean something
   already. A pad that emits **keypad 1–6** is the common case, and binding
   those bare would cost you the ability to type those digits anywhere:

   ```bash
   hidutil property --matching '{"VendorID":2070,"ProductID":9327}' --set '{"UserKeyMapping":[
    {"HIDKeyboardModifierMappingSrc":0x700000059,"HIDKeyboardModifierMappingDst":0x700000068},
    {"HIDKeyboardModifierMappingSrc":0x70000005A,"HIDKeyboardModifierMappingDst":0x700000069},
    {"HIDKeyboardModifierMappingSrc":0x70000005B,"HIDKeyboardModifierMappingDst":0x70000006A},
    {"HIDKeyboardModifierMappingSrc":0x70000005C,"HIDKeyboardModifierMappingDst":0x70000006B},
    {"HIDKeyboardModifierMappingSrc":0x70000005D,"HIDKeyboardModifierMappingDst":0x70000006C},
    {"HIDKeyboardModifierMappingSrc":0x70000005E,"HIDKeyboardModifierMappingDst":0x70000006D}]}'
   ```

   Swap the `VendorID`/`ProductID` for your own (`hidutil list`). Src and Dst
   are `0x700000000 | usage`: keypad 1–6 are `0x59`–`0x5E`, F1–F6 are
   `0x3A`–`0x3F`, F13–F18 are `0x68`–`0x6D`. Read it back with `--get
   "UserKeyMapping"`; undo with `--set '{"UserKeyMapping":[]}'`.

   The destination is **not** limited by what the pad can send — the
   translation happens in macOS's HID layer — so a pad whose firmware cannot
   emit F13 can still arrive as F13.

   **The mapping is volatile** — it is lost on reboot *and* every time the pad
   re-enumerates, which includes the hub it is plugged into powering down. A
   pad hanging off a monitor's USB hub therefore loses it whenever the monitor
   sleeps. Re-apply it from a LaunchAgent with `RunAtLoad` and a
   `StartInterval` of 30 (`hidutil --set` is idempotent and costs nothing), or
   use Karabiner, which reapplies on hotplug natively.

To find out what a pad's keys currently send, open System Settings → Keyboard →
Keyboard Shortcuts → App Shortcuts → **+**, click the shortcut field and press
a pad key: the recorder shows exactly what it received. Escape out without
saving. If a key changes the volume or shows a play/pause HUD it is a consumer
(media) key — those cannot be bound by most tools, so reprogram the pad or
remap it with Karabiner.

Not every pad can send every key. Some cap their keyboard report at usage
`0x65`, which means **F13–F24 are impossible in firmware** no matter what the
configurator offers; `ctrl+alt`+digit works on all of them. You can read the
ceiling out of the pad's report descriptor:

```bash
ioreg -c IOHIDDevice -r -d 1 | grep -A2 '"Product" = "YOUR-PAD"'
```

## When a press does nothing

`agstatus focus <n>` prints the reason on every failure — run it in a terminal
once to see it, since a hotkey discards the output.

| message | meaning |
| --- | --- |
| `Slot N is empty` | Fewer sessions on the board than the slot number. |
| `No local record` | The hook writes one only while Focus is on — `agstatus listener install`. |
| `never reported a host` | Session predates Focus, or the host opted out. |
| `not running` | The agent exited; focus does not respawn. Use Resume on the board. |
| `rate-limiting commands` | Ten-a-minute board budget, for sessions on *other* machines only. |
| `no listener connected` | The other machine's listener is not online; the board took the command but nothing will act on it. |
| `Could not reach the board` | Every press reads the session list first, so the board must be reachable. |

`agstatus listener plan <session_id>` prints what a focus would run without
running it.

Note where to look: a focus for a session on **another** machine is handled by
that machine's listener and lands in its
`~/Library/Application Support/AgStatus/listener.log`. A focus on **this**
machine runs in the `agstatus focus` process itself and writes nothing to that
log — run the command in a terminal to see its steps.
