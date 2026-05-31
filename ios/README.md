# Claude Status — iOS client

SwiftUI / WKWebView wrapper around the Claude Status dashboard, the iOS twin of the Android client. Designed for a spare iPhone mounted as an always-on dashboard.

- WKWebView fills the screen edge-to-edge.
- First-launch setup sheet asks for the dashboard URL; stored in `UserDefaults`.
- Floating `•••` button in the top-right opens a menu: **Reload / Keep screen on / Change URL…**
- `UIApplication.shared.isIdleTimerDisabled = true` keeps the screen on (toggleable).
- HTTP allowed by default via `NSAppTransportSecurity` so a LAN-hosted dashboard works without TLS.

## Requirements

- macOS with **Xcode 15+** installed (Xcode 26.5 is what was used to scaffold this).
- An **Apple ID** added in Xcode → Settings → Accounts. A free Apple ID is enough — you do **not** need the paid Apple Developer Program.
- An iPhone with **iOS 16+**, in *Developer Mode* (Settings → Privacy & Security → Developer Mode → On, then reboot).

## Install on your iPhone — free, no developer account

1. Open `ios/ClaudeStatus.xcodeproj` in Xcode.
2. Select the **ClaudeStatus** target → **Signing & Capabilities** tab.
3. Tick **Automatically manage signing** and pick your Apple ID under **Team** (it appears as *Your Name (Personal Team)*).
4. Change the **Bundle Identifier** to something unique to you, e.g. `com.<your-handle>.claudestatus` — required because `com.claudestatus.dashboard` is likely already used by someone else under the same name when the free signing service hashes it.
5. Connect your iPhone via USB. Trust the Mac when prompted.
6. Pick your device from the run-destination dropdown (top of the Xcode window).
7. Hit ▶︎ (Cmd-R). Xcode builds, signs, and installs the app.
8. On the iPhone, go to **Settings → General → VPN & Device Management**, tap your Apple ID, and **trust** the certificate.
9. Open the app. Enter your dashboard URL on first launch.

### The 7-day catch

A free Apple ID provisioning profile is valid for **7 days**. After that, the app will refuse to launch until you re-install it. To re-install: plug the phone into the Mac, open the project in Xcode, hit ▶︎ again. That's it.

If the weekly re-sign is annoying, look at **SideStore** / **AltStore** — third-party tools that automate the re-signing in the background over Wi-Fi. They still use your free Apple ID, so no money to Apple either.

## Build a release IPA from the CLI (optional)

```sh
cd ios
xcodebuild -project ClaudeStatus.xcodeproj \
           -scheme ClaudeStatus \
           -configuration Release \
           -destination 'generic/platform=iOS' \
           -archivePath build/ClaudeStatus.xcarchive \
           archive
```

You'll get an `.xcarchive` you can re-sign and export to an `.ipa` from Xcode's Organizer or with `xcodebuild -exportArchive`. For sideloading via SideStore, an *unsigned* IPA is fine.

## Project layout

```
ios/
├── ClaudeStatus.xcodeproj/      # hand-written; opens normally in Xcode
└── ClaudeStatus/
    ├── ClaudeStatusApp.swift    # @main App
    ├── ContentView.swift        # root view, menu button, sheet management
    ├── DashboardWebView.swift   # WKWebView UIViewRepresentable
    ├── SetupView.swift          # URL entry form (first launch + Change URL)
    ├── Prefs.swift              # UserDefaults helpers + URL normalization
    ├── Info.plist               # ATS + scene + orientation config
    └── Assets.xcassets/         # AppIcon + AccentColor catalogs
```

Min iOS 16. Supports iPhone + iPad. Portrait + both landscape orientations.
