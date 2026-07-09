# Flipper daemon

Bridges the [Claude Status Dashboard](../../../README.md) to a **Flipper Zero** over
Bluetooth Low Energy. It subscribes to the dashboard's `GET /events` SSE stream,
picks the top *N* ongoing sessions, and writes compact frames to the Flipper's
built-in BLE **serial service**. The companion Flipper app
([`../app`](../app)) renders them.

```
dashboard /events (SSE) ──▶ daemon (this) ──BLE──▶ Flipper "Claude Status" app
```

## Requirements

- macOS (uses CoreBluetooth via `@abandonware/noble`) with Bluetooth enabled.
- The dashboard server running (`npm run dev` in the repo root).
- A Flipper Zero running the **Claude Status** app with Bluetooth on.

> On macOS the terminal app you run this from must have **Bluetooth permission**
> (System Settings → Privacy & Security → Bluetooth). The first run will prompt.

## Run

```bash
cd daemon
npm install
npm run dev        # tsx, no build step
# or:  npm run build && npm start
```

Configuration is via environment variables (see `.env.example`). Defaults work
out of the box against `http://localhost:3000`. To override:

```bash
DASHBOARD_URL=http://localhost:3000 MAX_TASKS=4 SHOW_DONE=false npm run dev
```

| Variable        | Default                 | Purpose                                            |
| --------------- | ----------------------- | -------------------------------------------------- |
| `DASHBOARD_URL` | `http://localhost:3000` | Dashboard whose `/events` stream to subscribe to.  |
| `FLIPPER_NAME`  | _(any `Flipper *`)_     | Connect only to a Flipper with this exact BLE name.|
| `MAX_TASKS`     | `4`                     | How many tasks to show on the Flipper.             |
| `SHOW_DONE`     | `false`                 | Include `done` sessions.                           |
| `DEBOUNCE_MS`   | `150`                   | Coalesce update bursts before redrawing.           |

## Pairing (first connect)

The Flipper's serial characteristics are encrypted, so the first connection
**bonds** the two devices:

1. Start the **Claude Status** app on the Flipper (Bluetooth must be enabled in
   Flipper Settings → Bluetooth).
2. Run the daemon. When it connects, the Flipper shows a **6-digit pairing PIN**.
3. macOS shows a pairing prompt — enter the same PIN and confirm.

After bonding once, reconnects are automatic.

**If pairing fails with noble:** pair the Flipper once via the macOS Bluetooth
settings (or `brew install blueutil`), then re-run the daemon. The official
Flipper mobile app must be disconnected — only one central can hold the serial
link at a time.

## Wire protocol

One newline-terminated frame per screen update (full snapshot of ≤ `MAX_TASKS`
rows). Records are separated by `0x1e`, fields by `0x1f`:

```
<count>\x1e<code>\x1f<name>\x1f<message>\x1e<code>\x1f<name>\x1f<message>…\n
```

`<code>` is a one-char status: `i` idle · `p` planning · `c` coding · `t` testing
· `b` blocked · `d` done. Names are clamped to 10 chars, messages to 18. An empty
snapshot is `0\n`. The encoder lives in [`src/select.ts`](src/select.ts); the
Flipper parser must stay in sync.

## Files

| File             | Role                                                            |
| ---------------- | -------------------------------------------------------------- |
| `src/sse.ts`     | SSE consumer + session map (mirrors `public/app.js`).          |
| `src/select.ts`  | Top-N selection and frame encoding.                            |
| `src/ble.ts`     | noble BLE central: scan, connect, write to serial RX char.     |
| `src/index.ts`   | Orchestration + debounce + change detection.                   |
| `src/config.ts`  | Env-var configuration.                                         |
