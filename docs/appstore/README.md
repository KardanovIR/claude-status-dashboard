# App Store screenshots

Captured from the iOS Simulator in **demo mode**, so nothing personal appears
and the board is populated without needing a paired machine.

## What is here

`6.5/` — **1284 × 2778**. This is the set App Store Connect asks for first;
uploading 6.9" images into this slot is rejected with "Screenshots dimensions
should be: 1242 × 2688px, 2688 × 1242px, 1284 × 2778px or 2778 × 1284px".
Captured natively on an iPhone 14 Plus simulator (no scaling or cropping).

`6.9/` — **1320 × 2868**, for the 6.9" slot when App Store Connect offers it.

The app is iPhone-only (`TARGETED_DEVICE_FAMILY = 1`), so no iPad screenshots
are required.

Upload in this order — the first one is what people see in search results:

| # | File | Shows |
| --- | --- | --- |
| 1 | `02-board.png` | The live board: plan-limit bars and four sessions across coding / blocked / done / testing |
| 2 | `03-history.png` | A session timeline, every status change timestamped |
| 3 | `01-welcome.png` | Setup options and "Try the demo" — no account required |

## Regenerating

The status bar is Apple's canonical 9:41 with full battery and signal, set via
`simctl status_bar override`. The history screen has no launch argument and
cannot be tapped by `simctl`, so a DEBUG-only deep link opens it
(`AGSTATUS_OPEN_HISTORY=1`, see `BoardView.openHistoryForScreenshots()`).

```bash
# 6.5" (1284x2778) — the size App Store Connect asks for.
# For 6.9" (1320x2868) use an iPhone 16/17 Pro Max device type instead.
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
```

Install the app on a simulator that has never run it to get the welcome screen —
otherwise the saved board sends you straight to the board.

The same captures, resized, are the phone images on the landing page
(`public/img/app-board.png`, `public/img/app-history.png`).
