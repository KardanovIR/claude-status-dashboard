// Picks which sessions to show and encodes them into the compact wire frame the
// Flipper parses. One frame == a full snapshot of <= maxTasks rows.

import { config } from './config.js';
import { STATUS_CODE, type Session } from './types.js';

// Field/record separators. Must match the Flipper-side parser.
const RS = '\x1e'; // record separator (between rows)
const FS = '\x1f'; // field separator (between fields)
const NAME_MAX = 10;
const MSG_MAX = 18;

export function selectTasks(sessions: Map<string, Session>): Session[] {
  let list = Array.from(sessions.values());
  if (!config.showDone) list = list.filter((s) => s.status !== 'done');
  // Most recently updated first — same ordering as the dashboard UI.
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list.slice(0, config.maxTasks);
}

// Remove the delimiter/control bytes and clamp to a display-friendly length.
function clean(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return (s || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, max);
}

export function encodeFrame(tasks: Session[]): Buffer {
  const parts: string[] = [String(tasks.length)];
  for (const t of tasks) {
    const code = STATUS_CODE[t.status] ?? '?';
    const name = clean(t.name || t.project || t.id, NAME_MAX);
    const msg = clean(t.message, MSG_MAX);
    parts.push(`${RS}${code}${FS}${name}${FS}${msg}`);
  }
  return Buffer.from(parts.join('') + '\n', 'utf8');
}
