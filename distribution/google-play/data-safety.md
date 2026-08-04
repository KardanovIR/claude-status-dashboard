# Data safety

Google Play Data safety declaration for **AgStatus Android** (`com.kardanov.agstatus`, versionName 1.1.0). Every answer below is derived from the Android source in this repo, not from the iOS app.

## What the Android app actually transmits

The complete set of outbound traffic, from `Api.kt` and `SseClient.kt` — there is no other network code in the app:

| Request | Body | Notes |
| --- | --- | --- |
| `GET <server>/api/config` | — | Probe for legacy vs. multi-tenant |
| `POST <server>/api/workspaces` | empty | Server answers with a new board token |
| `GET <board>/api/sessions`, `/api/usage`, `/api/sessions/<id>/history` | — | Read-only |
| `GET <board>/events` | — | SSE stream, read-only |
| `POST <board>/pair` | empty | Server answers with a short-lived pairing code |
| `DELETE <board>/sessions/<id>`, `DELETE <board>` | — | User-initiated deletion |

`<board>` is `<server>/w/<token>`. So the only user-associated value the app puts on the wire is **the board token** (plus session ids the same server issued moments earlier). No request carries a device identifier, a body of user content, or any custom header. `Api.kt:claimPairCode` exists but is unreferenced by any Android UI — the Android app never uploads a typed pairing code.

The app is a **reader**. Session names, project folder names, status words and activity lines are written to the board by the separate `agstatus` CLI/hooks running on the user's own computer. The Android app only fetches and displays them.

## Data type table

Every type in Google's taxonomy, including the "No" answers.

| Google data type | Collected | Shared | Why |
| --- | --- | --- | --- |
| **Location** — Approximate | No | No | No location permission, no location API, no IP-to-location lookup. |
| **Location** — Precise | No | No | Same; `ACCESS_*_LOCATION` is not in the manifest. |
| **Personal info** — Name | No | No | No accounts, no name is ever asked for or stored. |
| **Personal info** — Email address | No | No | No sign-up, no email field anywhere in the app. |
| **Personal info** — User IDs | No | No | No accounts exist. The board token is anonymous and issued by the server without any user identity, so it is not an identifier "relating to an identifiable person" — it is declared under Device or other IDs instead. |
| **Personal info** — Address, Phone number, Race and ethnicity, Political or religious beliefs, Sexual orientation, Other info | No | No | Never requested, never present in any screen or payload. |
| **Financial info** — Payment info, Purchase history, Credit score, Other | No | No | No payments, no in-app purchases, no billing library. |
| **Health and fitness** | No | No | Not applicable; no such APIs. |
| **Messages** — Emails, SMS/MMS, Other in-app messages | No | No | The app sends no messages and reads none. The board's short activity line is *received* and displayed, never uploaded by this app. |
| **Photos and videos** — Photos | No | No | `CAMERA` is used only for a live QR preview decoded on-device by ZXing (`ScannerScreen.kt`). Only `BarcodeResult.text` is read; no frame is saved to disk, shared, or transmitted. |
| **Photos and videos** — Videos | No | No | Same; the preview is never recorded. |
| **Audio files** — Voice/sound recordings, Music, Other | No | No | No microphone permission, no audio APIs. |
| **Files and docs** | No | No | No storage permissions; nothing is read from or written to shared storage. |
| **Calendar** | No | No | No calendar permission or API. |
| **Contacts** | No | No | No contacts permission or API. |
| **App activity** — App interactions | No | No | No analytics SDK and no event pipeline; the app never reports taps, screens or sessions anywhere. |
| **App activity** — In-app search history | No | No | The app has no search. |
| **App activity** — Installed apps | No | No | No package-query code, no `QUERY_ALL_PACKAGES`. |
| **App activity** — Other user-generated content | No | No | The only text a user types is a server address and a pasted board URL. Both are configuration/credential values used to address requests, not content transmitted about the user; they are covered by the Device or other IDs declaration. |
| **App activity** — Other actions | No | No | No behavioural reporting of any kind. |
| **Web browsing** | No | No | No WebView and no browsing history access. (`integrations/` contains an unrelated WebView demo that is not part of this app.) |
| **App info and performance** — Crash logs | No | No | No Crashlytics, Sentry, ACRA or equivalent in `libs.versions.toml`; there is not a single `Log.*` or `println` call in `app/src/main`. Play's Android vitals crash reporting is performed by Google Play services under the user's device-level opt-in, not by app code. |
| **App info and performance** — Diagnostics | No | No | No performance, ANR, battery or network telemetry is emitted. |
| **App info and performance** — Other app performance data | No | No | Nothing else is reported. |
| **Device or other IDs** | **Yes** | No | **The board token.** `Board.token` (`ags_…`) is stored on-device in EncryptedSharedPreferences and sent in the URL path of every board request. It persists across launches and lets the server correlate this installation's requests, which is exactly what this category is meant to capture (Google's own example set includes server-issued install tokens such as a Firebase installation ID). The same declaration covers session ids the app echoes back to the server that issued them. |

### Why "collected" but not "shared"

The token goes to the board server **the user chose**: the developer-operated default `https://agstatus.online`, or a server the user self-hosts. Data sent to the developer's own server, or to infrastructure providers acting as service providers, is *collected*, never *shared*. If a user points the app at someone else's server, that is a user-initiated transfer to a destination the user selected and configured, which is also outside Google's "sharing" definition. Nothing is transferred to any third party for that third party's own purposes.

### Why not "No data collected" outright

That declaration is arguable — the token functions more like the address of a server-side resource than an identity — but it depends on a reading a reviewer need not share, and under-declaration is the failure mode Play penalizes. Declaring one identifier used solely for app functionality is accurate, cheap, and safe.

## Handling answers for the one collected type

**Device or other IDs**

| Question | Answer | Why |
| --- | --- | --- |
| Collected / Shared | Collected only | See above. |
| Processed ephemerally? | **No** | The token is persistent by design: it is the board's key on the server and is kept in EncryptedSharedPreferences on the device. |
| Required or optional? | **Data collection is required** | Once a board is connected there is no in-app switch that suppresses the token; it is inherent to fetching the board. Demo mode is board-less and fully offline, but that is a separate mode rather than a per-data-type opt-out, so "required" is the honest answer. |
| Purposes | **App functionality** only | It selects which board to display. Not analytics, not advertising, not personalization, not account management (no accounts), not fraud prevention. |

## Security and deletion answers

**Encrypted in transit — Yes.** `AndroidManifest.xml` sets `android:usesCleartextTraffic="false"` and `network_security_config.xml` sets `<base-config cleartextTrafficPermitted="false"/>`. The sole exception is a `domain-config` allowing cleartext to `10.0.2.2` and `localhost` — the emulator's alias for the developer machine's loopback and the device's own loopback, used to reach a dev server. All traffic to any real host is HTTPS, enforced by the platform: an `http://` board on any other host fails with an IOException before a byte is sent.

**Users can request deletion — Yes.** Settings → *Delete board and all its data* calls `DELETE <board>` (`SessionStore.deleteBoardEverywhere`), removing the board and its history from the server, then clears the local store. Settings → *Disconnect this device* forgets the board locally and leaves the server untouched. On the hosted server, sessions also expire 24 hours after their last update and idle boards are removed after 60 days. Deletions are soft deletes: the data immediately stops being served or returned by the API, and a copy can remain in the backing database — this is already disclosed in the privacy policy, which is the correct place for that nuance.

## Exact toggles to set in Play Console

**App content → Data safety → Data collection and security**
- Does your app collect or share any of the required user data types? → **Yes**
- Is all of the user data collected by your app encrypted in transit? → **Yes**
- Do you provide a way for users to request that their data is deleted? → **Yes**

**Data types** — check exactly one box on the entire grid:
- Device or other IDs → **Device or other IDs: Collected ✅ / Shared ❌**
- Every other category and subtype: leave both boxes unchecked (Location, Personal info, Financial info, Health and fitness, Messages, Photos and videos, Audio files, Files and docs, Calendar, Contacts, App activity, Web browsing, App info and performance).

**Data usage and handling → Device or other IDs**
- Collected: ✅ · Shared: ❌
- Is this data processed ephemerally? → **No, this collected data is not processed ephemerally**
- Is this data required? → **Data collection is required (users can't turn off this data collection)**
- Purposes → **App functionality ✅** only. Leave unchecked: Analytics, Developer communications, Advertising or marketing, Fraud prevention security and compliance, Personalization, Account management.

**Data deletion**
- Does your app allow users to create an account? → **No**
- Deletion method: **in-app** — Settings → "Delete board and all its data". If a URL is required, use `https://agstatus.online/privacy` (it documents both the in-app delete and `curl -X DELETE https://<server>/w/<token>`).

**Consistency checks in adjacent forms**
- Store listing → Privacy policy: `https://agstatus.online/privacy`
- App content → Ads: **No, my app does not contain ads**
- App content → Advertising ID: **No, my app does not use advertising ID** (no Play Services Ads dependency, no `AD_ID` permission)
- App access: no credentials needed — all functionality is reachable, and demo mode needs no server

## Before you submit

Two accuracy gaps worth closing first — neither changes an answer above, both reduce reviewer friction:

1. `/Users/ikardanov/Desktop/claude-status/docs/privacy.md` and `/Users/ikardanov/Desktop/claude-status/public/privacy.html` describe "the AgStatus iOS app" and contain a **Push notifications** section. The Android app has no notifications and no FCM. The policy linked from the Play listing must cover the Android app: add Android coverage (board URL + token in EncryptedSharedPreferences rather than Keychain) and scope the push section explicitly to iOS.
2. The cleartext exception for `10.0.2.2` / `localhost` currently ships in the release build via `app/src/main/res/xml/network_security_config.xml`. Moving it to a `debug`-only source set leaves the release build with zero cleartext exceptions, making the "encrypted in transit: Yes" answer unconditional.

**Evidence:** `/Users/ikardanov/Desktop/claude-status/android/app/src/main/kotlin/com/kardanov/agstatus/Api.kt`, `SseClient.kt`, `BoardStorage.kt`, `Models.kt`, `SessionStore.kt`, `ui/ScannerScreen.kt`, `ui/SettingsScreen.kt`, `/Users/ikardanov/Desktop/claude-status/android/app/src/main/AndroidManifest.xml`, `/Users/ikardanov/Desktop/claude-status/android/app/src/main/res/xml/network_security_config.xml`, `/Users/ikardanov/Desktop/claude-status/android/gradle/libs.versions.toml`, `/Users/ikardanov/Desktop/claude-status/docs/api.md`, `/Users/ikardanov/Desktop/claude-status/docs/privacy.md`.
