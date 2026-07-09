// Entry point: wires the dashboard SSE stream to the Flipper over BLE.
//
//   dashboard /events (SSE) --> SessionStore --> selectTasks/encodeFrame --> BleLink (BLE write)
//
// The store fires onChange for every snapshot/session/remove; we debounce bursts,
// recompute the top-N frame, and only transmit when the bytes actually changed.

import { config } from './config.js';
import { SessionStore } from './sse.js';
import { selectTasks, encodeFrame } from './select.js';
import { BleLink } from './ble.js';

const store = new SessionStore();
const ble = new BleLink();

let lastSent: string | null = null;
let timer: NodeJS.Timeout | null = null;

function recomputeAndSend(): void {
  const tasks = selectTasks(store.snapshot());
  const frame = encodeFrame(tasks);
  const key = frame.toString('latin1');
  if (key === lastSent) return;
  lastSent = key;
  const summary = tasks.map((t) => `${t.status}:${t.name}`).join(', ') || '(none)';
  console.log(`[daemon] ${tasks.length} task(s): ${summary}`);
  ble.send(frame);
}

store.onChange(() => {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    recomputeAndSend();
  }, config.debounceMs);
});

console.log('[daemon] Claude Status → Flipper bridge');
console.log(`[daemon] dashboard: ${config.dashboardUrl}  maxTasks: ${config.maxTasks}  showDone: ${config.showDone}`);

ble.start();
store.start();
// Send an initial empty frame once BLE connects even if there are no sessions.
recomputeAndSend();

function shutdown(): void {
  console.log('\n[daemon] shutting down');
  store.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
