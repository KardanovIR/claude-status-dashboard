# App Store screenshots

Captured from the iOS Simulator in **demo mode**, so nothing personal appears
and the board is populated without needing a paired machine.

## What is here

`6.9/` — **1320 × 2868**, the iPhone 6.9" display size App Store Connect
requires. Apple scales these down for smaller iPhone sizes, so this is the only
set you need. The app is iPhone-only (`TARGETED_DEVICE_FAMILY = 1`), so no iPad
screenshots are required.

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
DEV=$(xcrun simctl list devices available | grep "iPhone 17 Pro Max" | grep -o "[0-9A-F-]\{36\}")
xcrun simctl boot "$DEV"
xcrun simctl install "$DEV" /path/to/AgStatus.app
xcrun simctl status_bar "$DEV" override --time "9:41" --batteryState charged \
  --batteryLevel 100 --cellularMode active --cellularBars 4 --wifiBars 3 --dataNetwork wifi

# board
SIMCTL_CHILD_AGSTATUS_DEMO=1 xcrun simctl launch --terminate-running-process "$DEV" com.kardanov.agstatus
xcrun simctl io "$DEV" screenshot 6.9/02-board.png

# history
SIMCTL_CHILD_AGSTATUS_DEMO=1 SIMCTL_CHILD_AGSTATUS_OPEN_HISTORY=1 \
  xcrun simctl launch --terminate-running-process "$DEV" com.kardanov.agstatus
xcrun simctl io "$DEV" screenshot 6.9/03-history.png
```

Install the app on a simulator that has never run it to get the welcome screen —
otherwise the saved board sends you straight to the board.

The same captures, resized, are the phone images on the landing page
(`public/img/app-board.png`, `public/img/app-history.png`).
