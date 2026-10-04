# App Store screenshots

For the whole submission flow, see [SUBMITTING.md](SUBMITTING.md).

Captured from the iOS Simulator in **demo mode**, so nothing personal appears
and the board is populated without needing a paired machine.

## What is here

One directory per App Store Connect slot. **The slot dictates the pixel size** —
uploading an image of the wrong size is rejected outright, with a message that
lists the sizes that slot will take:

| Directory | Pixels | Captured on | Slot |
| --- | --- | --- | --- |
| `6.5/` | **1284 × 2778** | iPhone 14 Plus | 6.5" iPhone. Also accepts 1242 × 2688 and either landscape. |
| `6.9/` | **1320 × 2868** | iPhone 17 Pro Max | 6.9" iPhone. |
| `ipad/` | **2064 × 2752** | iPad Pro 13" (M5) | 13" iPad, portrait. Required — the app is universal. |
| `ipad-landscape/` | **2752 × 2064** | iPad Pro 13" (M5), rotated | 13" iPad, landscape. Same slot — upload one orientation or the other, never a mix. |

Two traps live here:

- **6.9" images do not fit the 6.5" slot.** Putting 1320 × 2868 into it fails
  with "Screenshots dimensions should be: 1242 × 2688px, 2688 × 1242px,
  1284 × 2778px or 2778 × 1284px". Capture the 6.5" set natively on an
  iPhone 14 Plus; do not scale or crop the 6.9" images to fit.
- **iPad images are not optional.** The app became universal in 1.2.0
  (`TARGETED_DEVICE_FAMILY = 1,2`), and App Store Connect will not let a
  universal app's version be submitted without an iPad set.

Upload in this order — the first one is what people see in search results:

| # | File | Shows |
| --- | --- | --- |
| 1 | `02-board.png` | The live board: per-agent limit blocks and four sessions across coding / blocked / done / testing |
| 2 | `04-usage.png` | Usage detail: tokens per day, the plan limit charted over it, and spend per project |
| 3 | `03-history.png` | A session timeline, every status change timestamped |
| 4 | `01-welcome.png` | Setup options and "Try the demo" — no account required |

## Landscape

`simctl` has no orientation command, so rotate the Simulator through its own
menu, **before launching** the app so it lays out in landscape from the first
frame:

```bash
open -a Simulator
osascript -e 'tell application "Simulator" to activate' -e 'delay 2' \
  -e 'tell application "System Events" to tell process "Simulator" to click menu item "Rotate Left" of menu "Device" of menu bar item "Device" of menu bar 1'
```

Then the catch: the device rotates and the app lays out correctly, but
`simctl io screenshot` still writes the frame at the device's **portrait**
dimensions, with the landscape content turned 90° inside it. `sips -r 270
<file>` straightens it into a true 2752 × 2064. Skip that and the image is both
sideways and the wrong size for the slot.

Two things that cost time here: a plain `key code 124 using command down` does
nothing — the menu item has to be clicked — and the click fails silently
without Accessibility permission for whatever runs `osascript`, so verify the
output dimensions rather than trusting the exit code.

## Regenerating

The status bar is Apple's canonical 9:41 with full battery and signal, set via
`simctl status_bar override`. `simctl` cannot synthesise taps, so the screens
behind a tap are opened by DEBUG-only launch variables (see
`BoardView.openHistoryForScreenshots()`): `AGSTATUS_OPEN_HISTORY=1` for a
session timeline, and `AGSTATUS_OPEN_USAGE=<source>` — `claude` or `codex` —
for that agent's usage detail.

```bash
# 6.5" (1284x2778) — the size App Store Connect asks for.
# For 6.9" (1320x2868) use an iPhone 16/17 Pro Max device type instead;
# for iPad, an iPad Pro 13" (2064x2752).
DEV=$(xcrun simctl create "AgStatus-6.5" \
  com.apple.CoreSimulator.SimDeviceType.iPhone-14-Plus \
  com.apple.CoreSimulator.SimRuntime.iOS-26-5)
xcrun simctl boot "$DEV"
xcrun simctl install "$DEV" /path/to/AgStatus.app
xcrun simctl status_bar "$DEV" override --time "9:41" --batteryState charged \
  --batteryLevel 100 --cellularMode active --cellularBars 4 --wifiBars 3 --dataNetwork wifi

# board
SIMCTL_CHILD_AGSTATUS_DEMO=1 xcrun simctl launch --terminate-running-process "$DEV" com.kardanov.agstatus
xcrun simctl io "$DEV" screenshot 6.5/02-board.png

# history
SIMCTL_CHILD_AGSTATUS_DEMO=1 SIMCTL_CHILD_AGSTATUS_OPEN_HISTORY=1 \
  xcrun simctl launch --terminate-running-process "$DEV" com.kardanov.agstatus
xcrun simctl io "$DEV" screenshot 6.5/03-history.png

# usage detail
SIMCTL_CHILD_AGSTATUS_DEMO=1 SIMCTL_CHILD_AGSTATUS_OPEN_USAGE=claude \
  xcrun simctl launch --terminate-running-process "$DEV" com.kardanov.agstatus
xcrun simctl io "$DEV" screenshot 6.5/04-usage.png
```

For the iPad set, create the device from
`com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB` and write into
`ipad/` instead.

Two timing details, both learned the hard way:

- **Capture the board ~2.5s after launch.** Demo mode ticks the sessions
  through plausible transitions, so waiting longer collapses the
  coding / testing / blocked / done spread into whatever it drifted to.
- **Idle a freshly created device ~70s before the first capture.** iOS fires a
  one-time "Ready for Apple Intelligence" banner shortly after first boot, and
  it lands across the top of the screen, hiding the nav bar. It fires once per
  device, so waiting it out is enough. Check afterwards rather than hoping: the
  banner band of an affected shot averages ~147 luminance against 13-23 for a
  clean one.
- **`simctl` cannot overwrite an existing screenshot** — it fails with
  "You don't have permission to save the file" because of the extended
  attributes on the committed PNGs. `rm` the target first, or the capture
  silently leaves the old image in place.

Install the app on a simulator that has never run it to get the welcome screen —
otherwise the saved board sends you straight to the board.

The same captures, resized, are the phone images on the landing page
(`public/img/app-board.png`, `public/img/app-history.png`).
