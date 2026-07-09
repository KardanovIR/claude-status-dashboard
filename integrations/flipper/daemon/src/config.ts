// Runtime configuration, all via environment variables (see .env.example).

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v: string | undefined, fallback: boolean): boolean => {
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
};

export const config = {
  // Dashboard server to subscribe to (its GET /events SSE stream).
  dashboardUrl: (process.env.DASHBOARD_URL || 'http://localhost:3000').replace(/\/$/, ''),
  // Optional exact BLE name match. Defaults to matching any "Flipper *" device.
  flipperName: process.env.FLIPPER_NAME || '',
  // How many tasks to show on the Flipper (its screen fits ~4 rows).
  maxTasks: num(process.env.MAX_TASKS, 4),
  // Whether to include sessions whose status is "done".
  showDone: bool(process.env.SHOW_DONE, false),
  // Debounce window for coalescing bursts of SSE updates before redrawing.
  debounceMs: num(process.env.DEBOUNCE_MS, 150),
};

export type Config = typeof config;
