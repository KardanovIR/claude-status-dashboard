Verified against the actual Android sources. Here is the document.

---

# AgStatus (Android) — Google Play Content Rating & App Content Declarations

**Package:** `com.kardanov.agstatus` · **versionName** 1.1.0 · **minSdk** 26 · **targetSdk** 36
**Prepared:** 2026-08-05

## Basis for these answers (what was actually verified)

| Claim | Evidence |
|---|---|
| Only two permissions: `INTERNET`, `CAMERA` | `/Users/ikardanov/Desktop/claude-status/android/app/src/main/AndroidManifest.xml`; merged manifest adds only camera `uses-feature` (from ZXing) and the AndroidX `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` signature permission |
| No ads, no analytics, no tracking SDK, no Google Play Services | `/Users/ikardanov/Desktop/claude-status/android/gradle/libs.versions.toml` — deps are Compose, AndroidX, kotlinx-serialization, OkHttp(+SSE), `androidx.security:security-crypto`, `com.journeyapps:zxing-android-embedded`. Nothing else. |
| No advertising ID | No `com.google.android.gms.permission.AD_ID` anywhere in the merged manifest; no GMS dependency |
| No location | No location permission, no `Location*` API use |
| No WebView / no embedded browser | grep for `WebView` across `app/src/main/` returns nothing; the only web navigation is three `Intent.ACTION_VIEW` hand-offs to the external browser (`ui/SettingsScreen.kt:493-497`) |
| The app never uploads content | `Api.kt` has exactly three POSTs: `/api/workspaces` (empty body), `/w/<token>/pair` (empty body), `/api/pair/claim` (a pairing code). Everything else is GET/DELETE. There is no text field in the app that writes to a board. |
| Camera is QR-decode only, nothing stored | `ui/ScannerScreen.kt` — `DecoratedBarcodeView.decodeContinuous`, frames decoded in memory, result is a string; no storage permission, no file write, no image transmitted |
| Board token stored encrypted on-device | `BoardStorage.kt` — `EncryptedSharedPreferences` (AES256-SIV/AES256-GCM) |
| All off-device traffic is HTTPS | `res/xml/network_security_config.xml` — `cleartextTrafficPermitted="false"` globally; the only exception is `10.0.2.2`/`localhost`, which never leaves the device |
| No push notifications | No FCM dependency, no `POST_NOTIFICATIONS`, no notification code of any kind |
| No accounts, no purchases, no billing | No billing library, no login screen, no email/password field anywhere |

---

# Part 1 — Content rating questionnaire (IARC)

## 1.0 Category selection

**Answer: "Utility, Productivity, Communication, or Other."**
Reason: it is a read-only monitoring dashboard for developer tooling. Do **not** pick "Social Networking, Chat or Forum" — that branch asks a much harder set of UGC/moderation questions the app cannot satisfy, and it does not describe the product.

## 1.1 Violence

| Question (as the IARC flow phrases it; wording varies by revision) | Answer | Justification |
|---|---|---|
| Does the app contain realistic violence, blood, or injury to characters? | **No** | The entire UI is text cards, colored status stripes, and progress bars — `ui/SessionCard.kt`, `ui/UsageBars.kt`. No characters, no imagery. |
| Does the app contain cartoon or fantasy violence? | **No** | Same — there is no illustrated content at all. |
| Does the app depict violence against real people/animals, torture, or death? | **No** | No media rendering of any kind: no video, no audio, no image display except a locally generated QR bitmap (`ui/PairSheet.kt:426`). |

## 1.2 Sexuality / nudity

| Question | Answer | Justification |
|---|---|---|
| Sexual material, nudity, suggestive content, or sexual references? | **No** | Fixed vocabulary UI: six status words (`idle/planning/coding/testing/blocked/done`, `Models.kt:20-26`), a project folder name, and a short activity line. |
| Does the app facilitate meeting/dating between users? | **No** | No profiles, no directory, no user identity of any kind. |

## 1.3 Language

| Question | Answer | Justification |
|---|---|---|
| Does the app contain profanity or crude humor? | **No** | No developer-authored profanity. All shipped copy is UI chrome; the demo strings are `"Editing src/auth/token.ts"`, `"npm test — 42 passing, 1 pending"`, etc. (`DemoData.kt`). |
| Note on displayed text | — | Text posted by the user's own machine could theoretically contain anything (a branch name, a command line). This is not answered here — IARC handles it under the UGC question, and the answer there (§1.7) is No, with reasoning. |

## 1.4 Controlled substances

| Question | Answer | Justification |
|---|---|---|
| References to, use of, or ability to buy alcohol, tobacco, or drugs? | **No** | Not present in any string, asset, or feature. |

## 1.5 Gambling & simulated gambling

| Question | Answer | Justification |
|---|---|---|
| Real-money gambling, simulated gambling, casino imagery, loot boxes? | **No** | No wagering, no randomized rewards, no currency. |
| Is the app a real-money gaming/contest app? | **No** | Not a game. |

## 1.6 Miscellaneous / horror / discrimination

| Question | Answer | Justification |
|---|---|---|
| Content likely to frighten young children (horror, jump scares)? | **No** | Static dark-themed dashboard; the only motion is a pulsing dot on active sessions. |
| Content that promotes discrimination or hate? | **No** | No such content. |
| Does the app contain shocking or disturbing content? | **No** | None. |

## 1.7 User-generated content — **answer: No** (the hard one, reasoned in full)

**The question:** does the app let users create content and share it with **other users**, i.e. does the app act as a distribution platform for user-authored content?

**Answer: No.** Justification, and the counter-argument addressed honestly:

**Why "No" is the correct answer:**

1. **There is no authoring surface in the app.** The Android app contains exactly three text inputs, all of them URL/host fields: the board-URL sheet, the self-hosting server field (`ui/WelcomeScreen.kt`), and the scanner's paste fallback (`ui/ScannerScreen.kt:308`). None of them writes content to a board. There is no compose box, no comment field, no reply, no name/caption/note field anywhere in the 4,558 lines of app code.
2. **The app never uploads content.** Verified exhaustively in `/Users/ikardanov/Desktop/claude-status/android/app/src/main/kotlin/com/kardanov/agstatus/Api.kt`: the only request bodies the app ever sends are an empty body (workspace creation, pair-code creation) and `{"code":"AB12-CD34"}` (pair claim). The app is a **reader**. Content on a board is written by a CLI hook on the user's own computer, over a webhook, entirely outside the app.
3. **The content is machine-emitted telemetry about the user's own machine, not authored expression.** The wire model (`Models.kt:54-70`) is: session id, project folder name, one of six enum status words, a short activity message, an agent source tag, and two timestamps. It is the same category of data as a build log or a CI status — an app showing your own server's status is not a UGC platform.
4. **There is no other-user relationship.** No accounts, no identities, no profiles, no follow, no feed, no discovery, no search across boards, no reply/comment/reaction mechanism. A board is a capability URL (`https://host/w/ags_<32 chars>`, `Models.kt:141`) that only its holder can reach. There is no way for one user of the app to encounter another user's content.

**The counter-argument, and why it does not flip the answer:**

- A board URL/QR *can* be handed to a second person ("Scan this from another phone to open the same board," `ui/PairSheet.kt:325`), and a pairing code *can* let a second machine post to the board. So two people can look at the same board.
- That is **shared access to one user's own data**, not user-to-user content exchange. The same is true of sharing a Google Doc link, a Grafana dashboard, or a CI build URL — none of which is a UGC platform under Play's framing. The determining factors Play looks for are all absent: no in-app authoring, no publishing to an audience the app assembles, no discovery, no interaction between users, no aggregation of strangers' content.

**Why answering "Yes" would be actively harmful:** answering Yes commits you to Play's User Generated Content policy obligations — in-app content moderation, an in-app user-reporting mechanism, and a user-blocking mechanism. The app has none of these and cannot meaningfully have them (there is no other user to block and no content author to report). A Yes here would create a policy violation on day one. **No is both the accurate answer and the safe one.**

**When this answer must be revisited:** if a future version ever adds an in-app field that writes text to a board (a note, a session label, a comment), the answer flips to Yes and the UGC policy obligations attach.

## 1.8 User communication / interaction — **answer: No**

| Question | Answer | Justification |
|---|---|---|
| Can users interact or communicate with other users (text, voice, video, images, files)? | **No** | No messaging of any kind. No send path exists (`Api.kt`), no message composition UI, no inbox, no presence, no user list. |
| Can users exchange or transfer content/files with each other? | **No** | The only outbound artifacts are a pairing code and a board URL, and both are copied to the clipboard for the user to paste into their own terminal (`ui/PairSheet.kt:444`, `ui/SettingsScreen.kt:499`) — the app itself has no share/send capability (no `Intent.ACTION_SEND` in the codebase). |
| Can users share personal information (name, email, phone) with other users? | **No** | The app never collects a name, email, or phone number — there is no account system at all. |
| Is user interaction moderated? | **N/A** | Not asked once the interaction question is No. |

→ Consequence: the **"Users Interact"** interactive-element descriptor will **not** be applied. That is the correct outcome.

## 1.9 Location sharing

| Question | Answer | Justification |
|---|---|---|
| Does the app collect or share the user's physical location? | **No** | No location permission is declared and no location API is called. |
| Does the app share the user's location with other users? | **No** | Same. |

→ The **"Shares Location"** descriptor will not be applied.

## 1.10 Digital purchases

| Question | Answer | Justification |
|---|---|---|
| Can users purchase digital goods or currency with real money? | **No** | No billing library, no IAP, no subscriptions, no paywall. The app and the hosted board are free; the project is MIT-licensed. |
| Does the app contain paid random items (loot boxes)? | **No** | No purchases at all. |

→ The **"Digital Purchases"** descriptor will not be applied.

## 1.11 Unrestricted internet access

| Question | Answer | Justification |
|---|---|---|
| Does the app natively give users unrestricted access to the internet (e.g. an embedded browser or search)? | **No** | There is no `WebView` in the app and no browser component. The three outbound links (privacy policy, GitHub, the user's own board URL) are `Intent.ACTION_VIEW` hand-offs to the system browser (`ui/SettingsScreen.kt:493-497`), which is not in-app browsing. |
| Edge case worth knowing, addressed | — | A user can type an arbitrary host into the self-hosting field, and the app will fetch JSON from it. That is not "browsing": there is no navigation, no rendering engine, and the response is parsed against a fixed schema (`Models.kt`) with unknown fields ignored and unknown status words degraded to `idle` (`Models.kt:36-37`). Any self-hostable REST client works this way; it does not constitute unrestricted internet access. |

→ The **"Unrestricted Internet"** descriptor will not be applied.

## 1.12 Generative AI content — **answer: No** (do not get this wrong just because the app is agent-adjacent)

| Question | Answer | Justification |
|---|---|---|
| Is this a generative-AI app / does it produce AI-generated content in response to user prompts? | **No** | AgStatus contains no model, no prompt UI, no inference, and no generation. It is a read-only status board that displays a status word and a short activity line that another program on the user's own computer already produced. There is no prompt field in the app and nothing is generated by it. |
| Does the app allow users to generate images/text/audio/video with AI? | **No** | Same — the app has no generation capability whatsoever. |

This one needs an explicit, defensible answer because the store listing talks about "AI coding agents." Displaying the status of an external tool is not generating AI content. Answering Yes would attach the generative-AI policy requirements (in-app reporting of offensive AI output, etc.) to an app that generates nothing.

## 1.13 Expected resulting rating

With every answer above, the questionnaire produces the lowest tier in every territory and **no interactive-element descriptors**:

| Body | Expected rating |
|---|---|
| Google Play (global fallback) | Rated for 3+ |
| IARC generic | 3+ |
| ESRB (Americas) | Everyone |
| PEGI (Europe) | PEGI 3 |
| USK (Germany) | USK 0 (ab 0 Jahren) |
| ClassInd (Brazil) | Livre (L) |
| ACB (Australia) | G |
| GRAC (South Korea) | All / 전체이용가 |

Descriptors: none. Interactive elements: none.

Note this is independent of the target-audience selection in Part 2 — a 3+ content rating alongside an 18+ target audience is normal and expected for a developer tool.

---

# Part 2 — App content declarations

| Section | Answer | One-line reason |
|---|---|---|
| **Privacy policy** | `https://agstatus.online/privacy` | Required for every app; this is the canonical URL, and it is the same URL the app links to in Settings → About (`ui/SettingsScreen.kt:66`). **See risk R1 — the policy text must be updated before you paste this URL.** |
| **App access** | "All functionality is available without any access restrictions" | There is no login, no account, no password, no region lock — verified: nothing in the app gates functionality behind credentials. |
| **Ads** | "No, my app does not contain ads" | No ad SDK, no ad network, no in-app promotional content — the full dependency list in `gradle/libs.versions.toml` contains no advertising library. |
| **Content ratings** | Complete the IARC questionnaire per Part 1 | Result: 3+ / Everyone, no descriptors. |
| **Target audience — age groups** | **18 and over, only** | It is a developer utility that is only useful to someone running a coding-agent CLI on their own computer; selecting any group under 18 would pull the app into the Families program and its ads/content obligations for no benefit. |
| **Target audience — "Could your store listing unintentionally appeal to children?"** | **No** | Dark, text-dense dashboard UI; no characters, mascots, bright playful art, animations, or child-oriented themes in the icon or screenshots. |
| **Target audience — ads/child-appeal follow-ups** | No ads; no child-directed content | Consistent with the Ads declaration above. |
| **News apps** | "No, my app is not a news app" | It displays the status of the user's own processes; it publishes no journalism and aggregates no news sources. |
| **COVID-19 contact tracing and status apps** | "My app is not a publicly available COVID-19 contact tracing or status app" | No health, contact-tracing, exposure-notification, or test/vaccination-status functionality. |
| **Data safety** | Must be completed separately — see the shape below | The section is mandatory and blocks release; the summary of what is truthful is given below the table. |
| **Government apps** | "No, my app is not a government app" | Developed and published by an individual (Inal Kardanov), not by or on behalf of any government entity. |
| **Financial features** | "My app doesn't provide any financial features" | No payments, lending, insurance, investing, crypto exchange/wallet, or tax functionality — no billing code of any kind. |
| **Health** | Not a health app; no health declarations apply | No health content, no health research, no Health Connect, no health data permissions (only `INTERNET` and `CAMERA` are declared). |
| **Advertising ID** (asked inside Data safety) | **No — the app does not use an advertising ID** | Verified: no `com.google.android.gms.permission.AD_ID` in the merged manifest and no Google Play Services dependency. |
| **Sensitive-permission declaration forms** | None required | The app declares none of the permissions that trigger a declaration form (no `QUERY_ALL_PACKAGES`, `MANAGE_EXTERNAL_STORAGE`, SMS/Call Log, `READ_MEDIA_*`, exact alarm, full-screen intent, or accessibility service). `CAMERA` has no separate Play declaration form. |
| **Account deletion** (asked in Data safety) | "My app does not allow users to create an account" | There is no account system; separately, the app already offers immediate self-service deletion of all server data via Settings → "Delete board and all its data" (`ui/SettingsScreen.kt:217`, `SessionStore.deleteBoardEverywhere`). |
| **Target API level** | Satisfied | `targetSdk = 36` in `/Users/ikardanov/Desktop/claude-status/android/app/build.gradle.kts`. |

### Data safety — the shape of the truthful answer (referenced, not filled here)

- **Data collected:** the honest, defensible position is to declare **App activity → Other user-generated content** (the session name, project folder name, and short activity message that appear on the board), *Collected, not shared with third parties, purpose: App functionality only.* Although the Android app itself never uploads this text (the CLI hook does), the hosted board at `agstatus.online` is operated by the same developer, so declaring it is both accurate and safer than claiming zero collection. This mirrors the decision already recorded for the iOS submission in `/Users/ikardanov/Desktop/claude-status/docs/app-store-submission.md:191`.
- **Do not declare** for the Android build: Device or other IDs (the iOS push token has no Android equivalent — there is no FCM), Location, Personal info, Financial info, Photos and videos, Files and docs, Contacts, Messages, Health, Calendar.
- **Camera:** used for live QR decode only; no image is stored or transmitted, so no photo/video data type is collected.
- **Encryption in transit: Yes** — `network_security_config.xml` forbids cleartext for every domain; the only exceptions are `10.0.2.2`/`localhost`, which never leave the device.
- **Data deletion:** yes, in-app immediate deletion of the board and all its data; plus documented automatic retention (sessions expire 24h after last update; idle boards deleted after 60 days, `docs/privacy.md:66-72`).

---

# Part 3 — Declarations where a wrong answer causes rejection or a policy strike

Ordered by severity.

### R1 — Privacy policy that doesn't cover the Android app → **rejection, and repeat rejection**
**The problem:** the live policy at `https://agstatus.online/privacy` says *"This policy covers the AgStatus iOS app and the hosted server at agstatus.online"* (`/Users/ikardanov/Desktop/claude-status/public/privacy.html:127`, mirrored in `docs/privacy.md:6`), and it contains a **Push notifications** section describing APNs (`public/privacy.html:173-179`) and an **iOS Keychain** storage claim (`public/privacy.html:181`). None of that is true of the Android app, and the policy does not name it.
**Why it bites:** Play requires the privacy policy to be applicable to, and comprehensive for, the app being submitted. A policy that names only the iOS app is a standard, easily-caught rejection, and reviewers do open the URL.
**Safe answer / fix before submitting:** update the policy so it names the AgStatus **Android** app explicitly, states that the Android app stores the board URL and token in `EncryptedSharedPreferences` on the device, states that the camera is used only to decode a pairing QR code and that no image is stored or transmitted, and either scopes the push-notification section to the iOS app explicitly or notes that the Android app has no notifications. Do not submit until the URL serves that text.

### R2 — Answering "Yes" to user-generated content → **immediate UGC policy violation / strike**
**Why it bites:** a Yes obligates in-app moderation, in-app reporting, and user blocking. The app has none and structurally cannot have them.
**Safe answer:** **No**, with the reasoning in §1.7 kept on file in case of appeal. Do not "play it safe" by answering Yes — Yes is the unsafe answer here.

### R3 — Ads declaration → **strike if wrong**
**Why it bites:** declaring "no ads" while any SDK serves ads is a hard misrepresentation. Conversely, declaring ads you don't have puts an "Contains ads" badge on the listing and drags in Families ads requirements if you ever add a sub-18 audience.
**Safe answer:** **No ads** — verified accurate against the full dependency list.

### R4 — Advertising ID declaration → **strike if wrong**
**Why it bites:** if any transitively-added SDK pulls in `com.google.android.gms.permission.AD_ID` while Data safety says the app doesn't use an advertising ID, Play flags it automatically.
**Safe answer:** **No advertising ID** — currently accurate. Re-check the merged manifest after any dependency bump before each release.

### R5 — Target audience including under-18 groups → **Families policy obligations you can't meet**
**Why it bites:** selecting 13-17 or younger pulls the app into Designed for Families / Families ads requirements and adds review scrutiny for zero upside on a developer tool.
**Safe answer:** **18 and over only**, "does not unintentionally appeal to children: No."

### R6 — Data safety claiming zero data collection → **strike**
**Why it bites:** the developer operates `agstatus.online`, and board content (project folder names, truncated command lines) lands there. A "collects no data" declaration that a reviewer can contradict by reading your own privacy policy is a classic Data-safety mismatch.
**Safe answer:** declare **App activity → Other user-generated content**, App functionality only, not shared, encrypted in transit, deletable on request. Keep it consistent word-for-word with the privacy policy.

### R7 — Any mention of notifications or alerts in the Play listing → **rejection for misleading claims**
**Why it bites:** the Android app has no push notifications at all — no FCM, no `POST_NOTIFICATIONS`. But the repo's own README headline is *"Live status board + push alerts for your coding agents"* (`/Users/ikardanov/Desktop/claude-status/README.md:3`), and the existing store copy in `docs/app-store-submission.md:107` describes opt-in alerts. If that copy is reused for Play, the listing promises a feature the binary cannot perform.
**Safe answer:** strip every mention of push, alerts, and notifications from the Play title, short description, full description, screenshots, and "What's new." This is not a content-rating field, but it is the single most likely cause of a rejection on this submission.

### R8 — Third-party brand names in the listing → **rejection under impersonation/IP rules**
**Why it bites:** Play rejects listings that imply a relationship with another brand. "Claude Code," "Codex," "Anthropic," and "OpenAI" must appear only as descriptive interoperability statements ("works with Claude Code"), never in the app title, never as a logo in the icon or screenshots, never phrased as official or endorsed.
**Safe answer:** keep the app name "AgStatus," add a one-line disclaimer in the full description that AgStatus is an independent open-source project not affiliated with or endorsed by Anthropic or OpenAI, and keep third-party marks out of the icon and feature graphic.

### R9 — App access with no reviewer path to a populated screen → **quality rejection, not a strike**
**Why it bites:** "Create a status board" on a reviewer's device correctly lands on the empty "No agents yet" state, because no computer is posting. A reviewer with no context may conclude the app is broken. This exact risk was already identified for the iOS submission (`docs/app-store-submission.md:213`).
**Safe answer:** declare "All functionality is available without special access," and use the review-notes field to say plainly: *"Tap 'Try the demo' at the bottom of the welcome screen (or Settings → Demo mode) to fill the board with sample sessions, usage bars, and timelines. Demo mode runs entirely on-device and sends nothing anywhere. An empty board on a device with no paired computer is expected behavior."*
