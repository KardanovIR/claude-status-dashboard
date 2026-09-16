# Submitting a new iOS version

The mechanical parts are scripted; the parts that need a human are the
metadata and the review notes. This is the order that works.

Written while preparing **1.3.0 (build 4)**. Version numbers below are that
release; everything else is reusable.

## 0. Before you start

Confirm the build you are about to ship is the one in `master`, and that the
version numbers were bumped:

```bash
git -C . status --short          # must be clean
grep -m1 MARKETING_VERSION ios/AgStatus.xcodeproj/project.pbxproj
grep -m1 CURRENT_PROJECT_VERSION ios/AgStatus.xcodeproj/project.pbxproj
```

`CURRENT_PROJECT_VERSION` must be higher than any build already uploaded for
this marketing version — App Store Connect rejects a repeat. 1.2.0 shipped as
build 3, so 1.3.0 starts at 4.

These are already correct and need no thought each release:

| Setting | Value | Why it matters |
| --- | --- | --- |
| `PRODUCT_BUNDLE_IDENTIFIER` | `com.kardanov.agstatus` | Immutable since the first upload |
| `DEVELOPMENT_TEAM` | `KKS5T5ZN3Y` | Matches `ios/ExportOptions.plist` |
| `TARGETED_DEVICE_FAMILY` | `1,2` | iPhone **and** iPad — see the screenshot note below |
| `ITSAppUsesNonExemptEncryption` | `false` in `Info.plist` | Skips the export-compliance question on every upload |
| `aps-environment` | `$(APS_ENVIRONMENT)` | Release builds get `production`; the upload script verifies this in the exported profile |

## 1. Refresh the screenshots

**Do not skip this when the UI changed.** App Store Connect keeps the previous
version's images, so a stale set ships silently.

For 1.3.0 the board itself changed (limits are now grouped per agent) and there
is a whole new screen, so every existing image is out of date.

See [README.md](README.md) for the capture commands. The short version:

```bash
# build once, then install into each screenshot simulator
xcodebuild -project ios/AgStatus.xcodeproj -scheme AgStatus \
  -destination "id=$DEV" CODE_SIGN_STYLE=Automatic build
APP=$(find ~/Library/Developer/Xcode/DerivedData/AgStatus-*/Build/Products/Debug-iphonesimulator \
  -maxdepth 1 -name AgStatus.app | head -1)
xcrun simctl install "$DEV" "$APP"
xcrun simctl status_bar "$DEV" override --time "9:41" --batteryState charged \
  --batteryLevel 100 --cellularMode active --cellularBars 4 --wifiBars 3 --dataNetwork wifi

# each screen is reachable through a DEBUG-only launch variable
SIMCTL_CHILD_AGSTATUS_DEMO=1 xcrun simctl launch --terminate-running-process "$DEV" com.kardanov.agstatus
SIMCTL_CHILD_AGSTATUS_DEMO=1 SIMCTL_CHILD_AGSTATUS_OPEN_USAGE=claude \
  xcrun simctl launch --terminate-running-process "$DEV" com.kardanov.agstatus
SIMCTL_CHILD_AGSTATUS_DEMO=1 SIMCTL_CHILD_AGSTATUS_OPEN_HISTORY=1 \
  xcrun simctl launch --terminate-running-process "$DEV" com.kardanov.agstatus
```

Always capture in **demo mode** — nothing personal appears and the board is
populated without a paired machine.

Every slot wants its own pixel size and rejects anything else, so capture each
set natively rather than scaling one to fit another:

| Slot | Pixels | Simulator |
| --- | --- | --- |
| 6.5" iPhone | 1284 × 2778 | iPhone 14 Plus |
| 6.9" iPhone | 1320 × 2868 | iPhone 17 Pro Max |
| 13" iPad | 2064 × 2752 | iPad Pro 13" (M5) |

**iPad is required** — the app has been universal since 1.2.0.

## 2. Archive, export and upload

One script does all three:

```bash
scripts/upload-ios-build.sh
```

It archives Release, exports with `ios/ExportOptions.plist`, prints the
`aps-environment` baked into the exported profile (it must say `production`),
then validates and uploads.

Uploading needs an App Store Connect API key:

```bash
export ASC_KEY_ID=XXXXXXXXXX          # the AuthKey_<THIS>.p8 part
export ASC_ISSUER_ID=aaaaaaaa-bbbb-…  # shown above the key list
```

Without those two the script still archives and exports, then stops and prints
the `.ipa` path so you can drag it into Transporter instead.

Processing takes 5–15 minutes. The build then appears under TestFlight and in
the version's **Build** section.

## 3. Fill in the version in App Store Connect

Create the new version (**+ Version or Platform** → the `MARKETING_VERSION` in
`ios/AgStatus.xcodeproj/project.pbxproj`, currently `1.4.0`), then:

- **What's New** — required for every update. The Play copy in
  `distribution/google-play/listing/whats-new.txt` is written for the same
  release and reads well here with light edits.
- **Screenshots** — upload the refreshed sets, iPhone and iPad. The first image
  is what appears in search results.
- **Build** — select the build you just uploaded.
- **App Review Information → Notes** — see below.

Nothing else needs revisiting for a feature release: the description, keywords,
category, age rating, and the privacy answers all carry over. The privacy
answers in particular stay correct — the app only ever *reads* a board, and
anything new it displays is reported by the hook on the user's own machine.

## 4. Review notes

Keep the notes from the previous submission; they answer the questions this app
reliably attracts. The full text is in
`~/Desktop/claude-status-private/appstore-resubmission.md` — it explains that

- there are **no accounts or credentials**, so no demo login exists;
- the app is a **companion viewer for a web service**, not a hardware
  accessory (a reviewer raised this on 1.2.0 and it needed rebutting);
- the QR code encodes a **board URL** — scanning it is the same as typing a
  link.

Two ways for a reviewer to see a populated app, and both should be offered:

1. **Demo mode** — "Try the demo" on the welcome screen. No network, no setup.
   This now covers the new usage screen too: history and per-project rows are
   synthesised locally, so the whole feature is reachable offline.
2. **The demo board QR** — `appreview-board-qr.png` in the private folder,
   attached under App Review Information → Attachments.

> **Keep the keepalive cron running until this version is approved.**
> Multi-tenant sessions expire after 24 hours, so the demo board empties
> without `appreview-keepalive.sh` (6-hourly on the mini PC). It is only safe
> to remove once there is no submission in flight.

## 5. Submit, then afterwards

Submit for review. When it is approved and released:

- Remove the keepalive cron from the mini PC (`crontab -e`) if you are not
  going straight into another submission.
- Note the build number that shipped, so the next release starts above it.
