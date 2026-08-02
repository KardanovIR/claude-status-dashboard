# App Store submission checklist

Generated from an audit of this repo. Items marked **done** are already in
the codebase or on the server; the rest need action in App Store Connect or
the Apple Developer portal.

## Before you can upload

| Step | Status |
| --- | --- |
| `DEVELOPMENT_TEAM` set so `xcodebuild archive` succeeds | **done** |
| Version 1.1.0 (build 2) | **done** |
| `aps-environment` driven by `APS_ENVIRONMENT` (production in Release) | **done** |
| In-app privacy link → https://agstatus.online/privacy | **done** |
| APNs configured on the hosted server (`/api/config` reports `push: true`) | **done** |
| Create the app record in App Store Connect (bundle id `com.kardanov.agstatus` — **locks permanently**) | you |
| Enable the Push Notifications capability on that App ID | you |
| Accept the Free Apps agreement (Business settings) | you |
| Export with method `app-store-connect`, then confirm `codesign -d --entitlements` shows `aps-environment: production` | after the record exists |
| Flip the server to `APNS_ENV=production` when the first TestFlight build ships | you |

## Listing

| Field | Value |
| --- | --- |
| Name (28/30) | AgStatus: Coding Agent Board |
| Subtitle (27/30) | Live status and plan limits |
| Category | Developer Tools / Productivity |
| Support URL | https://github.com/KardanovIR/claude-status-dashboard/issues |
| Marketing URL | https://agstatus.online |
| Privacy Policy URL | https://agstatus.online/privacy |

**Keywords** (94/100)

```
ai,monitor,dashboard,session,developer,terminal,cli,devtool,tracker,remote,usage,vibe,progress
```

**Promotional text** (157/170)

> Agents run for minutes, then quietly wait for you. See every session, what it is doing, and how much of your plan is left — without walking back to the desk.

**Description** (3346/4000)

```
AgStatus turns your phone into a live status board for the AI coding agents running on your computer.

Long-running agents all behave the same way: they work for a few minutes, then quietly stop and wait for you. AgStatus puts every session on one screen — what each one is doing right now, how long it has been silent, and which ones are stuck — so you can step away from the keyboard without losing the thread.

HOW IT WORKS
A small open-source hook on your computer posts an update whenever an agent starts a session, edits a file, runs tests, or needs your input. Your board is a private URL with an unguessable token: no account, no sign-up, no email address. Connect your computer by scanning a QR code, typing a short pairing code, or pasting the board URL.

ON THE BOARD
• One card per session, color-coded through six states: idle, planning, coding, testing, blocked, done
• The last thing the agent reported — the file it is editing, the test command it ran, the approval it is waiting for
• Blocked cards glow; finished and long-silent ones fade, so the sessions that need you stand out
• Updates stream in as they happen — no polling, no refresh button
• Swipe a card away when you are done with it
• Keep-screen-awake option for when the board lives on a desk or a shelf

PLAN LIMITS AT A GLANCE
Usage bars sit above the board: the current session window, the weekly cap, and per-model weekly caps, each with a percentage and a “resets in 2h 15m” countdown that stays current. Bars run green, then amber, then red as a limit approaches, and only the agents actually running on your board take up space.

SESSION HISTORY
Tap any card to open its timeline: every status change and message that session reported, newest first, with timestamps.

BUILT FOR PRIVACY
• No accounts, no analytics, no advertising identifiers, no third-party SDKs
• The app talks only to the board server you point it at
• Your board URL and token are stored in the iOS Keychain on your device
• Delete a board and everything on it from Settings, whenever you want
• The hook has a minimal mode that reports tool names only and never command text, and plan-usage reporting can be switched off

NOTIFICATIONS
The app supports opt-in alerts for the moment an agent is blocked or finishes a run. The toggles become available when the server hosting your board is set up to send notifications, and the app says so plainly when it is not.

OPEN SOURCE AND SELF-HOSTABLE
The server, the command-line tool, the hook, and this app are open source under the MIT license. Point the app at the hosted service or at a server you run yourself — the whole backend is a single process, and every screen in the app works the same either way.

TRY IT BEFORE YOU SET ANYTHING UP
Tap “Try the demo” on the welcome screen for a fully populated board — sample sessions moving through their states, usage bars, and timelines. Demo mode runs entirely on your device and sends nothing anywhere.

Designed for iPhone with a dark interface. Showing real sessions requires a computer running a compatible coding agent.

AgStatus is an independent open-source project that works with the hook systems of Claude Code and OpenAI Codex. It is not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI. All product names and trademarks are the property of their respective owners.
```

**What's new in 1.1.0**

```
Plan limits, session history, and a new home.

PLAN-USAGE BARS
Your remaining plan sits above the board: the current session window, the weekly cap, and per-model weekly caps, each with a percentage and a live “resets in” countdown. Bars shift from green to amber to red as a limit gets close, so a hard stop never arrives as a surprise.

SESSION HISTORY
Tap a card to open its timeline — every status change and message that session reported, newest first, with timestamps and relative times. It updates live while the agent keeps working.

PER-AGENT SCOPING
Every session now carries the agent it came from, and the board shows usage bars only for agents that actually have sessions on it. A Claude-only evening no longer shows Codex bars, and a quiet agent no longer takes up room.

CLEARER CARDS
Status stripes now hug the full left edge of each card, and an active session that has gone silent for ten minutes stops pulsing and dims — a crashed or killed agent no longer looks busy.

UNDER THE HOOD
Boards now live in PostgreSQL, so sessions, history, and pairings survive a server restart. The hosted service moved to its own home at agstatus.online. Both are open source — self-hosters get the same storage and the same board.

Thanks for using AgStatus. Bug reports and ideas are welcome on GitHub.
```

## Review notes

The reviewer has no machine running a coding agent, so the board would look
empty. These notes must lead with the demo.

```
FIRST: on the welcome screen, tap “Try the demo” (small link at the bottom). That fills the board with sample agent sessions, plan-usage bars, and session timelines, and is the fastest way to review every screen. Demo mode runs entirely on device — no network, no server, no data sent. You can also start it later from Settings → Demo → Start demo, and stop it the same way.

NO ACCOUNT, NO LOGIN, NO PAYMENT. There is no sign-up, no email, no password, no subscription, no in-app purchase, and no promo code to enter. Every feature is available on first launch. No demo credentials are needed, because there are no credentials.

WHAT THE APP IS
AgStatus is a live status board for AI coding agents running on a developer's own computer. A small open-source hook that the user installs on that computer (“npx agstatus init”) posts a status update each time an agent starts a session, edits a file, runs tests, or gets blocked waiting for approval. The app subscribes to that board over Server-Sent Events and shows one card per session, plus plan-usage bars and a per-session history timeline.

WHY THE BOARD LOOKS EMPTY WITHOUT THE DEMO
A real board only has content when a computer is posting to it, so “Create a status board” on a review device will correctly show the “No agents yet” empty state. This is expected behavior, not a bug — please use demo mode to see the populated UI.

OPTIONAL: EXERCISING THE LIVE PATH
1. Tap “Create a status board”. This creates an anonymous board on https://agstatus.online (still no account) and connects over SSE; the dot in the top-left turns green.
2. The empty state shows a webhook URL with a copy button. Posting to it from any HTTP client makes a card appear instantly:
   curl -X POST "<copied webhook URL>" -H "Content-Type: application/json" -d '{"id":"review-1","name":"review-session","status":"coding","message":"Editing app.ts","project":"demo"}'
   Repeat with "status":"blocked" or "done" to watch the card change, then tap the card for its history timeline.
3. Settings → Danger zone → “Delete board and all its data” removes everything created during review.

PUSH NOTIFICATIONS — PLEASE NOTE
The app implements APNs push (opt-in alerts when an agent is blocked or finishes), but the hosted server at agstatus.online does not have APNs credentials configured yet. It reports push as unavailable, so the app disables the notification toggles and shows “This server doesn't send push notifications.” The app will not prompt for notification permission there, and the App Store description does not promise that the hosted service delivers notifications. The feature works against a self-hosted server configured with APNs credentials (the server is open source, MIT).

CAMERA
The camera does exactly one thing: scan the pairing QR code printed by the setup command on the user's computer (“Scan setup QR code”). Declining camera access loses nothing — “Enter board URL” and the typed pairing code cover the same setup, and demo mode needs neither. Nothing is recorded or uploaded.

THIRD-PARTY NAMES
Claude Code (Anthropic) and Codex (OpenAI) are named only to describe compatibility: AgStatus reads their public hook systems. This is an independent open-source project (MIT), not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI, and the description says so explicitly.

OTHER DETAILS
- iPhone only, iOS 17+, dark interface by design.
- No analytics, no ad SDKs, no tracking; the bundled privacy manifest declares no collected data.
- A board is an unguessable token in a URL, stored in the Keychain, and can be deleted from the app at any time.
- Source for app, server, and CLI: https://github.com/KardanovIR/claude-status-dashboard
- Privacy policy: https://agstatus.online/privacy — questions: https://github.com/KardanovIR/claude-status-dashboard/issues
```

## App Privacy answers

Answer **"Yes, we collect data"**. Nothing is used for tracking; there are no
analytics or advertising SDKs in the app.

| Category | Linked to user | Tracking | Purpose |
| --- | --- | --- | --- |
| Identifiers → Device ID (APNs push token) | Yes | No | App Functionality only (delivering the blocked/done push notifications the user opted into). Not Analytics, not Personalization, not Advertising. |
| User Content → Other User Content (board data: session id, project folder name, status message / truncated command line, timestamps) | Yes | No | App Functionality only (this IS the product — showing the live board, the history timeline, and the push text). |

MISMATCH — MUST FIX. ios/AgStatus/PrivacyInfo.xcprivacy:9-10 declares `<key>NSPrivacyCollectedDataTypes</key><array/>` — an empty array asserts "this app collects nothing." That directly contradicts the Device ID answer (the app POSTs the APNs token and the server persists it in the devices table), and also the Other User Content answer if you adopt it. Apple's privacy report (Xcode → Generate Privacy Report) is built from this file, and an empty manifest next to a label that declares Device ID is an internal inconsistency that a reviewer can see.

FIX — add to NSPrivacyCollectedDataTypes:
  dict: NSPrivacyCollectedDataType = NSPrivacyCollectedDataTypeDeviceID; NSPrivacyCollectedDataTypeLinked = true; NSPrivacyCollectedDataTypeTracking = false; NSPrivacyCollectedDataTypePurposes = [NSPrivacyCollectedDataTypePurposeAppFunctionality]
and, if you adopt the recommended board-content disclosure, a second dict with NSPrivacyCollectedDataType = NSPrivacyCollectedDataTypeOtherUserContent and the same three attributes.

WHAT IS ALREADY CORRECT in the manifest: NSPrivacyTracking = false (:5-6) and an empty NSPrivacyTrackingDomains (:7-8) — verified accurate by the SDK/framework greps described above; there is no tracking and no domain that would need listing. NSPrivacyAccessedAPITypes declaring only NSPrivacyAccessedAPICategoryUserDefaults with reason CA92.1 (:11-21) is correct and complete: the app writes only its own defaults (NotificationManager.swift:47-53 and :195, plus @AppStorage keepAwake/pushTipShown), which is exactly what CA92.1 covers, and it calls none of the other required-reason APIs — grep for systemUptime, mach_absolute_time, volumeAvailableCapacity, creationDate, modificationDate, attributesOfItem, activeInputModes, FileManager across ios/AgStatus/*.swift returns nothing. Keychain (BoardKeychain.swift) is not a required-reason API, so no entry is needed. The manifest IS bundled into the app (project.pbxproj:27 build file and :167 in the Resources build phase), so it will ship.

ADJACENT PRE-SUBMISSION INCONSISTENCIES (not label answers, but they will be looked at alongside it):
1. SettingsView.swift:209 points the in-app "Privacy policy" link at the GitHub raw doc (docs/privacy.md), while the App Store listing will point at https://agstatus.online/privacy (served by src/app.ts:141 from public/privacy.html). The two documents have drifted: docs/privacy.md is dated July 9 and lacks the "Timestamps" row, the "Children", and the "Changes" sections that public/privacy.html has. Point the in-app link at the canonical https://agstatus.online/privacy and re-sync the texts, so the policy the reviewer reads is the policy the app shows.
2. ios/AgStatus/AgStatus.entitlements sets aps-environment = development. An App Store / TestFlight build needs `production`, otherwise the tokens registered by NotificationManager are sandbox tokens and production push silently never arrives. (Push is not configured on agstatus.online yet, so nothing fires today either way — but fix the entitlement before you ship the push feature.)
3. project.pbxproj:322/334 and :353/365 still say MARKETING_VERSION = 1.0.0 and CURRENT_PROJECT_VERSION = 1, though the intent is to ship 1.1.0.
4. Two answers in App Store Connect's flow that people commonly get wrong here: answer "No" to "Do you or your third-party partners use data for tracking?" (verified — no SDKs, no ad networks, no data brokers), and do NOT claim any of Apple's optional-disclosure exemptions for the device token — push registration is part of primary functionality, so the exemption does not apply.

## Open risks

### 4.2 / 4.2.3 Minimum Functionality — Reviewer can never produce real data — the app looks like an empty remote viewer

**Likelihood:** high

The primary CTA on /Users/ikardanov/Desktop/claude-status/ios/AgStatus/WelcomeView.swift:63 ("Create a status board") lands the reviewer on BoardView.emptyState (BoardView.swift:196-240): "No agents yet" plus a webhook URL. The only way to populate it is PairSheet, which prints `npx agstatus init --code XXXX-XXXX` (Models.swift:254, PairSheet.swift:88-118) and tells the reviewer to "Run this in your terminal" on a machine running Claude Code — App Review will not install a CLI or an agent. Demo mode exists but is a footnote-sized text link at the very bottom of a ScrollView (WelcomeView.swift:148-154, `.font(.footnote.weight(.medium))`), and there is NO demo affordance in the empty-board state, the connecting state, or the create-board error path. A reviewer who never taps that link sees an app that does literally nothing.

**Mitigation:** 1) Promote demo to a real secondary button (`.buttonStyle(.bordered)`) on the welcome screen. 2) Add "See a demo board" to BoardView.emptyState and to the WelcomeView error branch (WelcomeView.swift:103-109). 3) Pre-seed a live board on agstatus.online and put its `https://agstatus.online/w/ags_…` URL in App Review Information notes with step-by-step instructions ("Enter board URL → paste → live data"), plus "or tap Try the demo on the first screen". 4) In review notes, state plainly that the app is a companion monitor for software the user runs on their own computer, like a server-monitoring client.

### 2.1 App Completeness — Default happy path terminates in a permanently empty screen with a dead pairing code

**Likelihood:** high

After "Create a status board" succeeds the board is empty, the connection dot is green, and the pair sheet hands out a code that visibly counts down and expires (PairSheet.swift:58-65, expiredView). Settings then shows a Notifications section whose toggles are permanently disabled (SettingsView.swift:124-143 + 224-241) because the hosted server reports push:false. The composite impression is "half-finished app": live indicator, no content, dead toggles, expiring code that does nothing.

**Mitigation:** Add an inline fallback in BoardView.emptyState — e.g. after ~20s with zero sessions on a fresh board, surface "Not at your computer? See a demo board" that calls store.startDemo(). Hide the Notifications section entirely when notifications.serverPushAvailable == false instead of rendering disabled toggles.

### 2.3.1 Accurate Metadata / 2.1 — Push notifications are shipped in the binary but disabled on the hosted server

**Likelihood:** high

The app declares aps-environment (ios/AgStatus/AgStatus.entitlements), implements the full APNs flow (NotificationManager.swift, API.registerDevice → POST /devices), and the server supports it (src/push.ts) — but deploy/bootstrap-droplet.sh:54-58 leaves every APNS_* var commented out, so cfg.apns is null (src/config.ts) and /api/config returns push:false (src/app.ts:479). A reviewer therefore cannot enable notifications at all. If the App Store description, subtitle, or screenshots advertise "push alerts when an agent is blocked" (the README headline does exactly that), the listing describes a feature the shipped build cannot perform → 2.3.1.

**Mitigation:** Best: configure APNs on agstatus.online before submission (production .p8, APNS_KEY_ID/TEAM_ID, APNS_TOPIC=com.kardanov.agstatus, APNS_ENV=production) and verify a real push end-to-end from a TestFlight build. If you ship without it: remove every push claim from name/subtitle/description/screenshots, hide the Notifications section when the server reports push:false, and say so in review notes.

### 5.1.1 Data Collection and Storage — PrivacyInfo.xcprivacy declares zero collected data while the app uploads a device token and board content to a developer-run server

**Likelihood:** medium

ios/AgStatus/PrivacyInfo.xcprivacy has `NSPrivacyCollectedDataTypes` as an empty array, yet NotificationManager.handle(deviceToken:) + API.registerDevice POST the APNs device token to agstatus.online (a server the developer operates), and the board itself stores project folder names and truncated command lines (docs/privacy.md:28-38). Apple treats data transmitted off-device to the developer's servers as "collected"; an empty manifest that contradicts the App Store Connect nutrition labels (or a reviewer's own network observation) is a standard 5.1.1 hold.

**Mitigation:** Declare in both the App Store Connect privacy questionnaire and the manifest: Identifiers → Device ID (purpose: App Functionality, not linked to identity, not used for tracking) for the push token, and User Content → Other User Content for session/project/message text; keep NSPrivacyTracking false. Note in review notes that the app has no analytics/ads SDKs (true — the only network code is API.swift and SSEClient.swift, both talking to the user's configured board).

### 2.1 App Completeness (review-environment dependency) — A pre-seeded review board goes empty after 24 hours, and backend errors read as app bugs

**Likelihood:** medium

Multi-tenant sessions are TTL'd at 24h (DEFAULT_MULTI_TENANT_TTL_MS in src/config.ts), so any demo board seeded at submission time will be blank by the time a reviewer opens it (reviews often start 24-72h later). Separately, POST /api/workspaces returns 503 at capacity (src/app.ts:296-299) and is rate-limited to 20/hour per IP (src/app.ts:288-294); the app surfaces those as "The server is at capacity right now" / "Too many requests" (API.swift:30-37) — indistinguishable from a broken app to a reviewer, and Apple reviewers often share egress IPs.

**Mitigation:** Run a cron/systemd timer on the droplet that re-posts fresh sessions to the review board every few minutes for the duration of review (keeps it inside the 24h TTL and looks live), monitor agstatus.online uptime across the review window, and temporarily raise createLimiter/maxWorkspaces. Additionally make any create/connect failure offer "Try the demo" instead of a bare error string.

### 5.1.1 / 5.1.2 (privacy policy accuracy) — In-app privacy link points at a GitHub markdown blob, not the canonical policy, and the policy overstates "nothing else is collected"

**Likelihood:** medium

SettingsView.swift:207-210 links to https://github.com/KardanovIR/claude-status-dashboard/blob/master/docs/privacy.md even though src/app.ts:140-141 already serves a stable https://agstatus.online/privacy. The link breaks if the repo is renamed or made private, and it leaks the trademark-bearing repo name in-app. The policy itself (docs/privacy.md:13-15) says "Nothing else is collected" while the server uses express-rate-limit (IP-keyed) and normal HTTP request handling, and it offers only "open a GitHub issue" as contact — no email.

**Mitigation:** Point the in-app link and the App Store Connect Privacy Policy URL at https://agstatus.online/privacy; add a sentence covering transient IP/rate-limit/server-log data; add an email contact. Also consider a one-line disclosure on the welcome screen that "Create a status board" provisions an anonymous board on agstatus.online.

### 5.2.1 / 5.2.5 Intellectual Property — "Claude Code", "Codex", "Anthropic", "OpenAI" usage in listing, UI and linked repo name

**Likelihood:** medium

The app name and icon are clean, but third-party marks appear inside the product: PairSheet.swift:118 ("it wires Claude Code hooks to this board"), UsageInfo.displayName maps sources to "Claude"/"Codex" (Models.swift:191-197), DemoData.usage() renders "Claude · Weekly (Fable)" bars (DemoData.swift:52-67), the shipped board screenshot shows "Claude needs permission to run terraform apply" (docs/screenshots/ios-board.png), and both in-app About links expose github.com/KardanovIR/claude-status-dashboard (SettingsView.swift:209,213). Nominative/descriptive use is defensible; what gets flagged is a trademark used as the App Store name/subtitle/keyword hook or any Anthropic/OpenAI logo in the icon or screenshots.

**Mitigation:** Keep "Claude"/"Codex" out of the app name, subtitle and icon; use them only descriptively in the body of the description ("works with Claude Code and OpenAI Codex") and add "AgStatus is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI" to the description and the About section; never ship an Anthropic/OpenAI logo in screenshots. Optionally rename the GitHub repo so the in-app links don't carry the mark.

### 2.1 (build/version hygiene) — MARKETING_VERSION is still 1.0.0 / build 1 while you intend to ship 1.1.0

**Likelihood:** medium

ios/AgStatus.xcodeproj/project.pbxproj sets MARKETING_VERSION = 1.0.0 (lines 334 and 365) and CURRENT_PROJECT_VERSION = 1 (lines 322 and 353) in both Debug and Release, while the CLI package is already at 1.1.0 (cli/package.json). Uploading a version/build pair already present in App Store Connect is rejected at upload, and a version string inconsistent with the release notes reads as sloppy metadata.

**Mitigation:** Bump MARKETING_VERSION to 1.1.0 and CURRENT_PROJECT_VERSION to a fresh integer in both configurations before archiving; keep them in sync with the release notes.

### 2.5.x (entitlements) / 2.1 — aps-environment is hard-coded to "development" in the shipped entitlements file

**Likelihood:** medium

ios/AgStatus/AgStatus.entitlements contains aps-environment = development. CODE_SIGN_STYLE is Automatic (project.pbxproj:319-321, 350-352) so Xcode normally rewrites this on App Store export, but if any archive/export path (CI, manual profiles, xcodebuild -exportArchive) preserves it, the device registers with the APNs sandbox and production pushes silently never arrive — a shipped feature that provably does not work — and signing/entitlement mismatch errors (ITMS-90046 class) are possible at upload. Note the app correctly declares no UIBackgroundModes (Info.plist), so there is no unjustified remote-notification background mode to defend, and no private APIs are used (VisionKit, UserNotifications, Security only).

**Mitigation:** Use a Release-specific entitlements file with aps-environment = production (or confirm Xcode's rewrite by running `codesign -d --entitlements :- ` on the exported .ipa payload before uploading). Verify one real push via TestFlight before submitting.

### 5.1.2 (camera purpose) / 2.1 — Camera-denied path dead-ends with no route to Settings; purpose string is jargon-heavy

**Likelihood:** medium

ScannerView.swift:47-57 only calls AVCaptureDevice.requestAccess when DataScannerViewController.isAvailable is false, then renders fallbackPanel ("Camera scanning isn't available", line 119) if it stays false. A reviewer who taps "Don't Allow" on the camera prompt gets a screen that blames the device rather than the permission, with no "Open Settings" button — a classic 2.1 "feature appears broken" finding. The NSCameraUsageDescription string is accurate but references an internal command ("printed by 'npx agstatus init'") that means nothing to a reviewer.

**Mitigation:** Distinguish denied-permission from unsupported-hardware, and in the denied case show "Camera access is off for AgStatus" plus a button opening UIApplication.openSettingsURLString. Reword the purpose string in plain language: "AgStatus uses the camera only to scan the QR code that connects this app to your status board. Nothing is recorded or stored."

