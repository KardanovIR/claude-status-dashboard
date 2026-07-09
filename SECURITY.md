# Security Policy

## Supported versions

The latest `master` is the supported version. The hosted instance tracks it;
self-hosters should update regularly.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository:
**Security tab → Report a vulnerability**
([direct link](https://github.com/KardanovIR/claude-status-dashboard/security/advisories/new)).

**Do not open public issues or PRs for security reports.** You'll get an
acknowledgment as soon as the report is read, and a fix or a response with
reasoning before any public disclosure.

## Scope

AgStatus uses a **capability-URL model**: a board is identified by an
unguessable token in its URL, and anyone who has the URL can read and write
that board. That is by design — it's the same trust model as Discord/Slack
webhook URLs — so "someone with the board URL can see/modify the board" is
not a vulnerability.

Definitely report:

- **Tenant-isolation breaks** — reading or writing a workspace without its
  token, token leakage (e.g. raw tokens in logs, errors, or storage — the
  server should only ever persist SHA-256 hashes), or cross-workspace event
  delivery (SSE or push).
- **Auth bypasses** — `WEBHOOK_SECRET` checks, pairing-code brute force
  beyond the documented rate limits, device-registration abuse.
- **DoS amplification** — ways to make the server do disproportionate work
  or bypass the per-workspace/per-IP limits documented in
  [docs/api.md](docs/api.md#limits).
- Anything in the CLI or hooks that could execute code, corrupt
  `~/.claude/settings.json` beyond its own entries, or exfiltrate data
  beyond the documented status payload.
- iOS app issues around Keychain storage of the board token or push handling.

Out of scope: reports that require the attacker to already possess the board
URL/token, and rate-limit numbers merely being "too generous" without a
concrete amplification path.
