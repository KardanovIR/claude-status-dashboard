# Claude Status — Android client

A thin WebView wrapper around the Claude Status dashboard, with:

- a first‑launch setup screen that asks for the server URL and remembers it,
- the screen kept always on while the dashboard is visible (toggleable from the menu),
- swipe‑to‑refresh and a reload action,
- HTTP allowed by default (you self‑host the dashboard on your LAN),
- signed with the debug keystore so you can sideload the APK without setting up a release key.

## Requirements

- Android Studio (the bundled JDK is used to build).
- Android SDK platform 36 (auto‑installed by the build on first run).
- A phone with **Android 8.0+** (API 26+) and *Install unknown apps* enabled for your file manager / browser.

## Build

From this directory:

```sh
export JAVA_HOME="$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleDebug
```

The signed APK lands at:

```
app/build/outputs/apk/debug/app-debug.apk
```

(Or open the `android/` folder in Android Studio and use **Build → Build APK(s)**.)

## Install on your phone

Two easy options:

### Option A — USB (`adb`)

```sh
"$HOME/Library/Android/sdk/platform-tools/adb" install -r app/build/outputs/apk/debug/app-debug.apk
```

Enable *USB debugging* on the phone (Settings → About phone → tap *Build number* 7×, then Developer options → USB debugging).

### Option B — sideload

Copy `app-debug.apk` to the phone (AirDrop to Files, a USB transfer, Google Drive, etc.), open it from the Files app, and approve *Install unknown apps* when prompted.

## First launch

The app opens to a setup screen. Enter the dashboard URL — for a server running on your laptop on the same Wi‑Fi, that's something like:

```
http://192.168.1.50:3000
```

You can change it later from the toolbar overflow menu (**Change URL…**). The same menu has a **Keep screen on** toggle (on by default).

## Notes

- `usesCleartextTraffic="true"` and a permissive `network_security_config.xml` are set because the dashboard is meant to be reached over HTTP on your LAN. If you put it behind HTTPS later, both can be tightened.
- The debug build's `applicationId` is `com.claudestatus.dashboard.debug`, so it can coexist with a release build of the same app.
- The release build type also signs with the debug key (see `app/build.gradle.kts`) — replace with your own keystore before distributing the APK beyond your own devices.
