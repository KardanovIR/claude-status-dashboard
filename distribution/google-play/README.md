# Google Play submission — AgStatus for Android

Everything needed to publish `com.kardanov.agstatus`. Assets here are final;
the checklist marks what still needs doing in Play Console.

```
distribution/google-play/
├── README.md                     this file
├── listing/
│   ├── title.txt                 28 / 30 chars
│   ├── short-description.txt     72 / 80
│   ├── full-description.txt      3271 / 4000
│   └── whats-new.txt             463 / 500
├── graphics/
│   ├── icon-512.png              512×512, no alpha
│   ├── feature-graphic.png       1024×500, no alpha
│   └── screenshots/              1080×1920 phone screenshots
├── data-safety.md                every Data safety answer, with reasons
├── content-rating.md             IARC answers + the other blocking declarations
└── release/
    └── agstatus-release.aab      signed bundle (gitignored — rebuild locally)
```

## Checklist

| Step | Status |
| --- | --- |
| Signed App Bundle built (`versionName 1.1.0`, `versionCode 1`) | **done** |
| Upload key created, stored outside the repo | **done** |
| Icon, feature graphic, screenshots at Play's required sizes | **done** |
| Listing copy within every character limit | **done** |
| Data safety answers derived from the code | **done** — transcribe into Console |
| Content rating + app content declarations | **done** — transcribe into Console |
| Privacy policy URL — https://agstatus.online/privacy | **done**, already live |
| Create the app in Play Console and pay the one-time $25 registration | you |
| Upload the bundle to a track (internal testing first) | you |
| Fill Data safety, content rating, and app content from the docs here | you |
| Countries, pricing (free), and rollout | you |

## Rebuilding the bundle

```bash
scripts/make-upload-keystore.sh   # once — creates the upload key
scripts/build-play-bundle.sh      # builds + signs, copies here
```

The keystore and its password live in `~/Desktop/claude-status-private/`, and
`android/keystore.properties` (which points at them) is gitignored. Back both
up. With Play App Signing — on by default for new apps — Google holds the real
app signing key and this upload key only proves the upload is yours, so losing
it is recoverable.

Upload key SHA-256, which Play Console will show after the first upload:

```
44:CB:00:E8:E0:F1:5C:D9:86:36:C6:43:D4:9B:CD:65:9D:AA:3F:22:F6:DE:F9:C3:FD:CF:00:33:B9:64:78:B8
```

## Screenshots

Captured from the emulator in demo mode, so nothing personal appears and the
board is populated without pairing a machine. Play caps phone screenshots at a
2:1 aspect ratio, so these are 1080×1920 (16:9) rather than the emulator's
native 1080×2400, which would be rejected.

| # | File | Shows |
| --- | --- | --- |
| 1 | `01-board.png` | The live board: plan-limit bars and sessions across coding, done, and blocked |
| 2 | `02-history.png` | A session timeline, every status change timestamped |
| 3 | `03-welcome.png` | Setup options and demo mode — no account required |

To regenerate:

```bash
adb shell wm size 1080x1920 && adb shell wm density 420
adb shell am start -n com.kardanov.agstatus/.MainActivity --ez agstatus_demo true
adb exec-out screencap -p > 01-board.png
# history needs the debug deep link, since it cannot be reached by a launch intent
adb shell am start -n com.kardanov.agstatus/.MainActivity \
  --ez agstatus_demo true --ez agstatus_open_history true
adb exec-out screencap -p > 02-history.png
adb shell wm size reset && adb shell wm density reset
```

## Notes that affect review

- **No push notifications.** The Android app deliberately ships without them,
  so nothing in the listing or the Data safety form mentions notifications.
  The iOS app has them; do not copy iOS listing text over.
- **Camera is optional.** It is used only to decode a pairing QR code
  on-device; no frame is stored or transmitted. It is declared as optional
  hardware so devices without a camera can still install.
- **Third-party names.** "Claude Code", "Codex", "Anthropic" and "OpenAI"
  appear only as interoperability statements, with an explicit disclaimer in
  the full description. Play rejects listings that imply a relationship with
  another brand.
- **versionCode 1** is correct for the first upload. Every later upload needs a
  higher one, even for a rejected build.
