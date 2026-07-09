# Claude Status — Flipper Zero app

A Flipper Zero app that displays up to **4 ongoing Claude Code tasks** on the
screen, fed over Bluetooth by the [host daemon](../../daemon). The app hijacks
the Flipper's built-in BLE **serial** profile and acts as a peripheral; the
daemon connects as the central and pushes status frames.

```
┌────────────────────────┐
│ Claude              BT  │
├────────────────────────┤
│ [C] auth   editing svr │
│ [T] api    pytest -q   │
│ [P] ui     Task        │
│ [B] infra  needs input │
└────────────────────────┘
```

Status glyphs: **I** idle · **P** planning · **C** coding · **T** testing ·
**B** blocked · **D** done.

## Building

This app targets **custom firmware** (Momentum / Unleashed / RogueMaster). It
uses only public SDK APIs (`bt_profile_start`, `ble_profile_serial`,
`ble_profile_serial_set_event_callback`), so it also builds on stock firmware.

### Option A — `ufbt` (recommended, no full firmware checkout)

`ufbt` builds a single external app against an SDK. Point it at your firmware's
SDK channel, then build:

```bash
pip install --upgrade ufbt

# Momentum:
ufbt update --index-url https://up.momentum-fw.dev/firmware/directory.json
# Unleashed:
# ufbt update --index-url https://up.unleashedflip.com/directory.json
# Stock (default):
# ufbt update --channel=release

cd integrations/flipper/app
ufbt            # builds dist/claude_status.fap
ufbt launch     # builds, uploads over USB, and runs it on the Flipper
```

### Option B — in-tree with the firmware's `fbt`

Clone your firmware, symlink this folder into `applications_user/`, then:

```bash
git clone https://github.com/Next-Flip/Momentum-Firmware.git   # or your fork
ln -s "$(pwd)/integrations/flipper/app" Momentum-Firmware/applications_user/claude_status
cd Momentum-Firmware
./fbt fap_claude_status                # build
./fbt launch APPSRC=claude_status      # build + upload + run
```

The resulting `claude_status.fap` goes in `SD Card/apps/Bluetooth/` (qFlipper can
copy it). It then appears under **Apps → Bluetooth → Claude Status**.

## Running

1. Enable Bluetooth on the Flipper (Settings → Bluetooth).
2. Launch **Claude Status**. It shows `Waiting for daemon...` and advertises.
3. Start the [daemon](../../daemon) on your Mac. On first connect the Flipper
   shows a pairing PIN — confirm it on macOS to bond.
4. Press **Back** to exit (this restores the default Bluetooth profile).

Bond keys are stored separately (`claude_status.keys` in the app data dir) so
this app's pairings don't interfere with the Flipper mobile app.

## Protocol

One newline-terminated frame per update, full snapshot of ≤4 rows:

```
<count>\x1e<code>\x1f<name>\x1f<message>\x1e<code>\x1f<name>\x1f<message>…\n
```

Records are separated by `0x1e`, fields by `0x1f`. The parser lives in
`claude_status.c` (`parse_line`) and must match `daemon/src/select.ts`.
