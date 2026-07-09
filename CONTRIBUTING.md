# Contributing

Thanks for helping out. This is a small, dependency-light project — the fastest
way to get a change in is to keep it that way.

## Dev setup

### Server (repo root)

```bash
npm ci
npm run dev      # hot reload on http://localhost:3000 (tsx)
npm test         # vitest suite in test/
npx tsc --noEmit # typecheck
```

Set `MULTI_TENANT=true npm run dev` to work on workspace mode. The Vitest
suite covers legacy mode, workspaces, limits, pairing, SSE, persistence, and
push (against a local mock APNs server — no Apple account needed).

### CLI (`cli/`)

The CLI's e2e tests import the server sources and spawn `dist/server.js`, so
build the server first:

```bash
npm ci && npm run build      # at the repo root, once
cd cli
npm ci
npm run build                # tsc → dist/
npm test                     # vitest suite in cli/test/
node dist/cli.js init --url http://localhost:3000 --no-qr   # try it against a local server
```

### iOS app (`ios/AgStatus`)

Open `ios/AgStatus.xcodeproj` in Xcode and run — a simulator build needs no
signing or Apple account. `ios/ClaudeStatus` is the legacy WebView app; new
work goes into `ios/AgStatus`. Useful debug env vars (Scheme → Run →
Environment): `AGSTATUS_BOARD_URL=<url>` to skip the welcome screen,
`AGSTATUS_DEMO=1` to launch straight into demo mode.

### Bash hook (`hooks/`)

`shellcheck hooks/claude-status-hook.sh` must stay clean.

## CI

Every PR must pass the `CI` workflow (`.github/workflows/ci.yml`), which runs
four jobs:

| Job      | What it runs |
| -------- | ------------ |
| `server` | `npm ci`, `npx tsc --noEmit`, `npx vitest run` |
| `cli`    | root build, then `npm ci` + `npx tsc --noEmit` + `npx vitest run` in `cli/` |
| `hooks`  | `shellcheck hooks/claude-status-hook.sh` |
| `ios`    | `xcodebuild` of the AgStatus scheme for the iOS simulator (no signing) |

A secret scan (`gitleaks`) also runs on every push. Releases are cut by
pushing a `v*` tag, which builds the Docker image, publishes the CLI to npm
(once `NPM_TOKEN` is configured), and creates a GitHub release.

## Code style

- **No new runtime dependencies without discussion.** The server ships with
  exactly three (`express`, `express-rate-limit`, `better-sqlite3`), the CLI
  with one (`qrcode-terminal`), and the hooks and iOS app with zero. That's a
  feature — open an issue before adding anything.
- TypeScript, strict; match the style of the file you're editing.
- Anything user-observable (endpoints, validation, limits, hook behavior)
  needs a test and, if it changes the API surface, an update to
  `docs/api.md` / `docs/hooks.md`.
- The hooks must never block or break Claude Code: exit 0 on every failure,
  print nothing, keep hard timeouts.

## Proposing changes

1. For anything non-trivial (new endpoints, new deps, UI reworks), open an
   issue first so we agree on the shape.
2. Fork, branch, make the change with tests.
3. Open a PR against `master` with a short description of what and why.
   Screenshots for UI changes (web or iOS) are appreciated.

Security issues: **don't** open a public issue — see [SECURITY.md](SECURITY.md).
