---
description: Create or pair an AgStatus board and write ~/.agstatus.json so the plugin's hooks start reporting
argument-hint: "[pairing code XXXX-XXXX] [--url <self-hosted server>]"
allowed-tools: Read Write Bash
---

Set up AgStatus for this machine. The plugin's hooks are already active, but
they post nothing until `~/.agstatus.json` contains a board URL. Your job is
to acquire a board and write that file.

Arguments (may be empty): $ARGUMENTS

Steps:

1. Determine the server: `https://agstatus.online` unless the arguments
   contain `--url <server>`.

2. If `~/.agstatus.json` already exists and has a `url`, the machine is
   already set up — print that board URL, remind the user to open it on
   their phone or in the AgStatus iOS app, and stop.

3. Check for a conflicting install: if `~/.claude/settings.json` contains
   `agstatus-hook` entries under `hooks`, warn the user that both the plugin
   and the `npx agstatus init` hook are active — every status would be posted
   twice. Recommend removing one: `npx agstatus uninstall` keeps the plugin;
   `/plugin uninstall agstatus` keeps the npx install. Continue after warning.

4. Acquire a board with curl:
   - If the arguments contain a pairing code (XXXX-XXXX, case and dashes
     don't matter — normalize to uppercase without dashes before sending):
     `POST <server>/api/pair/claim` with JSON body `{"code":"<code>"}`.
     A 404/410 means the code is wrong or expired — tell the user to mint a
     fresh one in the iOS app ("Pair your computer") and stop.
   - Otherwise create a new private board: `POST <server>/api/workspaces`.
   Both return JSON containing `dashboardUrl`.

5. Write `~/.agstatus.json` with exactly:
   `{"url":"<dashboardUrl>"}`

6. Confirm it works: `POST <dashboardUrl>/webhook` with body
   `{"session_id":"plugin-setup","name":"plugin-setup","status":"done","message":"AgStatus plugin connected","project":"setup"}`
   should return HTTP 200, then delete the card again with
   `DELETE <dashboardUrl>/sessions/plugin-setup`.

7. Tell the user:
   - Their board URL (`dashboardUrl`) — open it in any browser, or scan it
     into the AgStatus iOS app via "Enter board URL".
   - Status reporting is live immediately — this very session appears on the
     board within a few seconds.
   - The board URL is a capability token: anyone with the link can view the
     board, so share it deliberately.

Never print the contents of any file other than `~/.agstatus.json`, and do
not modify `~/.claude/settings.json`.
