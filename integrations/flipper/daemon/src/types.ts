// Mirrors the Session shape broadcast by the dashboard server (src/server.ts).
export const STATUSES = ['idle', 'planning', 'coding', 'testing', 'blocked', 'done'] as const;
export type Status = (typeof STATUSES)[number];

export interface Session {
  id: string;
  name: string;
  status: Status;
  message: string;
  project: string;
  createdAt: number;
  updatedAt: number;
}

// One-character status codes sent on the wire (must match the Flipper parser).
export const STATUS_CODE: Record<Status, string> = {
  idle: 'i',
  planning: 'p',
  coding: 'c',
  testing: 't',
  blocked: 'b',
  done: 'd',
};
