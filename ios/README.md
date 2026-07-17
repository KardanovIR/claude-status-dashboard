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

A free Apple ID provisioning profile is valid for **7 days**. After that, the app will refuse to launch until you re-install it. To re-install: plug the phone into the Mac, open the project in Xcode, hit ▶︎ again.

For an always-on dashboard that's annoying. The next section sets up automatic re-signing.

## Sideload with AltStore or SideStore — skip the weekly Xcode dance

Both tools use your **free Apple ID** under the hood (no $99/yr), but they automate the 7-day cert renewal so the app keeps running without you plugging the phone in. Pick one:

| | AltStore | SideStore |
|---|---|---|
| Re-signs when… | a Mac/PC running AltServer is reachable on the same Wi-Fi | the phone itself can talk to an *anisette* server (community-hosted or self-hosted) |
| Needs a Mac running? | Yes, occasionally (every ≤7 days) | No, once set up |
| Setup complexity | Lower | Slightly higher (one-time) |
| Recommended when | You leave a Mac on at home anyway | The Mac may be off for weeks |

### Step 1 — produce an `.ipa`

You need a `.ipa` file to hand to AltStore/SideStore. The simplest reliable path is to archive in Xcode and export a *Development* build (which uses your free Apple ID's signing automatically). AltStore/SideStore will strip and re-sign it on install.

1. In Xcode, set **Product → Destination → Any iOS Device (arm64)**.
2. **Product → Archive**. Wait for the build, then the Organizer opens.
3. Click **Distribute App → Custom → Development → Next → Next → Export**.
4. Choose a folder; you'll get `ClaudeStatus.ipa` inside it.

(Strict alternative: CLI archive + export. Equivalent and scriptable:
```sh
cd ios
xcodebuild -project ClaudeStatus.xcodeproj \
           -scheme ClaudeStatus \
           -configuration Release \
           -destination 'generic/platform=iOS' \
           -archivePath build/ClaudeStatus.xcarchive \
           archive
# Write an ExportOptions.plist with method=development, then:
xcodebuild -exportArchive \
           -archivePath build/ClaudeStatus.xcarchive \
           -exportPath build/export \
           -exportOptionsPlist ExportOptions.plist
```
The `.ipa` will be in `build/export/`.)

### Step 2A — install via AltStore

1. On the Mac, download and install **AltServer** from <https://altstore.io>. Launch it; it lives in your menu bar.
2. Plug the iPhone into the Mac (USB) and unlock it. In AltStore's menu-bar icon: **Install AltStore → choose your iPhone → enter your Apple ID + password**. AltStore is installed on the phone.
3. On the iPhone, open **Settings → General → VPN & Device Management** and trust the AltStore certificate.
4. AirDrop, email, or copy `ClaudeStatus.ipa` to the iPhone (Files app).
5. Open the AltStore app, tap **My Apps → +**, pick the `.ipa`. AltStore signs and installs it.
6. As long as your Mac+AltServer is on and on the same Wi-Fi as the phone before the 7-day cert expires, AltStore renews silently in the background. You can also force a refresh from the AltStore app whenever.

Constraints: free Apple ID signs at most **3 apps per device** simultaneously (AltStore counts as 1, this app as another).

### Step 2B — install via SideStore

1. On the iPhone, follow SideStore's setup at <https://sidestore.io/#get-started>:
   - Install the WireGuard app from the App Store (SideStore uses a local VPN profile to do its signing magic).
   - Install SideStore itself via the AltStore-style flow once (you can use AltServer for this one-time bootstrap, or follow SideStore's no-Mac install path on their site).
   - Sign in with your Apple ID inside the SideStore app.
2. AirDrop / copy `ClaudeStatus.ipa` to the iPhone.
3. Open SideStore, tap **+** in **My Apps**, pick the `.ipa`. SideStore signs and installs.
4. To renew: open SideStore and tap **Refresh All**, or let it run automatically (it'll renew whenever the anisette server is reachable). No Mac required after the initial bootstrap.

### Common gotchas (either tool)

- **Bundle ID collision** — if signing fails with a vague "Could not create a provisioning profile" error, change the bundle ID in Xcode to something unique to you (e.g. `com.<your-handle>.claudestatus`) and rebuild the archive. Free Apple ID's signing service rejects bundle IDs already claimed under another team.
- **3-app limit** — AltStore/SideStore themselves count toward the free Apple ID's 3-app cap. Remove old sideloaded apps you don't need.
- **WireGuard not installed** — SideStore silently refuses to install if WireGuard isn't present.
- **App expires while you're away** — both tools require Wi-Fi reachability to renew. AltStore needs the Mac; SideStore needs internet to the anisette server. If the phone is offline for >7 days, the app will need a manual refresh next time you have a network.

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
