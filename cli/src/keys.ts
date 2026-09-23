import { agstatusJsonPath, mergeAgstatusJson, readAgstatusJson } from './listener/config';
import { installPrefix, shimPath } from './listener/resume';

/**
 * `agstatus keys` — the shortcut for each focus slot, and the config to paste
 * into whichever tool listens for them.
 *
 * AgStatus does not capture the key itself. A global hotkey needs an event tap
 * or a HID-level grab, which is a TCC-gated capability and a background
 * process to hold it — a listener that already exists (skhd, Karabiner,
 * Hammerspoon, Raycast) does that job better, and the focus path deliberately
 * touches nothing TCC-gated (docs/design/focus-protocol.md §7). So this prints
 * what those tools want, and they run `agstatus focus <n>`.
 *
 * The mapping lives in ~/.agstatus.json under "keys", slot number to shortcut:
 *
 *     "keys": { "1": "ctrl+alt+1", "2": "ctrl+alt+2" }
 *
 * With no "keys" at all, the defaults below apply, so the command is useful
 * before anything is configured.
 */

/** Slots a pad is assumed to have when nothing says otherwise. */
export const DEFAULT_SLOT_COUNT = 6;
export const MAX_SLOTS = 24;

/**
 * Canonical modifier names, and every spelling accepted for them. macOS calls
 * the same key Option and Alt depending on the keyboard, and the hotkey tools
 * disagree too, so both are taken and normalised here rather than at each
 * generator.
 */
const MODIFIERS: Record<string, string> = {
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', opt: 'alt', option: 'alt',
  shift: 'shift',
  cmd: 'cmd', command: 'cmd', meta: 'cmd', super: 'cmd', win: 'cmd',
};
/** Canonical order, so `alt+ctrl+1` and `ctrl+alt+1` print identically. */
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'cmd'];

/** What each tool calls the modifiers, keyed by canonical name. */
const SKHD_MODIFIER: Record<string, string> = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', cmd: 'cmd' };
const KARABINER_MODIFIER: Record<string, string> = {
  ctrl: 'control', alt: 'option', shift: 'shift', cmd: 'command',
};

/**
 * The keys that may be bound with no modifier at all. Everything else is
 * passed through to the generators untouched — skhd and Karabiner share their
 * names for letters, digits and function keys, and refusing a key this CLI has
 * simply not heard of would be worse than emitting it for the user to check.
 */
const FUNCTION_KEY_RE = /^f([1-9]|1[0-9]|2[0-4])$/;

export interface Binding {
  slot: number;
  /** Canonical spelling: modifiers in fixed order, then the key, joined by "+". */
  shortcut: string;
  modifiers: string[];
  key: string;
}

export interface ParseError {
  error: string;
}

/**
 * `ctrl+opt+1` -> {modifiers: ['ctrl','alt'], key: '1'}. A shortcut with no
 * modifier is accepted — F13–F24 are meant to be bound bare — but a bare
 * letter or digit is refused: binding one steals that key from every app on
 * the machine, which is never what someone meant to ask for.
 */
export function parseShortcut(raw: string): { modifiers: string[]; key: string; shortcut: string } | ParseError {
  const parts = raw.trim().toLowerCase().split('+').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) return { error: 'is empty' };
  const key = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  if (MODIFIERS[key] !== undefined) return { error: `ends with the modifier "${key}" — it needs a key too` };

  const seen = new Set<string>();
  for (const part of rest) {
    const canonical = MODIFIERS[part];
    if (canonical === undefined) {
      return { error: `has "${part}", which is not a modifier (ctrl, alt/opt, shift, cmd)` };
    }
    seen.add(canonical);
  }
  const modifiers = MODIFIER_ORDER.filter((m) => seen.has(m));
  if (modifiers.length === 0 && !FUNCTION_KEY_RE.test(key)) {
    return {
      error: `is a bare "${key}" — that would take the key from every app. Add a modifier, or use F13–F24`,
    };
  }
  return { modifiers, key, shortcut: [...modifiers, key].join('+') };
}

const defaultShortcut = (slot: number): string => `ctrl+alt+${slot}`;

export interface ResolvedKeys {
  bindings: Binding[];
  /** Whether the mapping came from ~/.agstatus.json or from the defaults. */
  source: 'file' | 'default';
  /** Entries the file carried that could not be used, with the reason. */
  problems: string[];
}

/**
 * The configured mapping, or the defaults. A malformed entry is reported and
 * skipped rather than failing the whole command: one bad line must not cost
 * the user the five shortcuts that were fine.
 */
export function resolveKeys(slotCount = DEFAULT_SLOT_COUNT, file = agstatusJsonPath()): ResolvedKeys {
  let raw: unknown;
  try {
    raw = readAgstatusJson(file).keys;
  } catch (err) {
    return { bindings: [], source: 'file', problems: [(err as Error).message] };
  }

  const problems: string[] = [];
  const bindings: Binding[] = [];

  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    problems.push(`"keys" in ${file} is not an object — ignoring it and using the defaults.`);
    raw = undefined;
  }

  if (raw === undefined) {
    for (let slot = 1; slot <= slotCount; slot += 1) {
      const parsed = parseShortcut(defaultShortcut(slot));
      if (!('error' in parsed)) bindings.push({ slot, ...parsed });
    }
    return { bindings, source: 'default', problems };
  }

  const taken = new Map<string, number>();
  for (const [slotKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[0-9]{1,2}$/.test(slotKey) || Number(slotKey) < 1 || Number(slotKey) > MAX_SLOTS) {
      problems.push(`"${slotKey}" is not a slot number between 1 and ${MAX_SLOTS} — skipped.`);
      continue;
    }
    if (typeof value !== 'string') {
      problems.push(`slot ${slotKey} is not a string — skipped.`);
      continue;
    }
    const parsed = parseShortcut(value);
    if ('error' in parsed) {
      problems.push(`slot ${slotKey} (${JSON.stringify(value)}) ${parsed.error} — skipped.`);
      continue;
    }
    const clash = taken.get(parsed.shortcut);
    if (clash !== undefined) {
      problems.push(`slot ${slotKey} repeats ${parsed.shortcut}, already on slot ${clash} — skipped.`);
      continue;
    }
    taken.set(parsed.shortcut, Number(slotKey));
    bindings.push({ slot: Number(slotKey), ...parsed });
  }
  bindings.sort((a, b) => a.slot - b.slot);
  return { bindings, source: 'file', problems };
}

// ---- Generators -----------------------------------------------------------

/** The command a key runs: detached, output discarded, so the press feels instant. */
export function focusCommand(slot: number, shim = shimPath(installPrefix(__filename))): string {
  return `/usr/bin/nohup '${shim}' focus ${slot} >/dev/null 2>&1 &`;
}

export function toSkhd(bindings: Binding[], shim?: string): string {
  const lines = bindings.map((b) => {
    const mods = b.modifiers.map((m) => SKHD_MODIFIER[m]).join(' + ');
    const chord = mods ? `${mods} - ${b.key}` : b.key;
    return `${chord} : ${focusCommand(b.slot, shim)}`;
  });
  return [
    '# AgStatus focus keys — append to ~/.config/skhd/skhdrc,',
    '# then: skhd --restart-service',
    ...lines,
  ].join('\n');
}

export function toKarabiner(bindings: Binding[], shim?: string): string {
  return JSON.stringify(
    {
      title: 'AgStatus focus keys',
      rules: bindings.map((b) => ({
        description: `${b.shortcut} → agstatus focus ${b.slot}`,
        manipulators: [
          {
            type: 'basic',
            from: {
              key_code: b.key,
              ...(b.modifiers.length > 0
                ? { modifiers: { mandatory: b.modifiers.map((m) => KARABINER_MODIFIER[m]) } }
                : {}),
            },
            to: [{ shell_command: focusCommand(b.slot, shim) }],
          },
        ],
      })),
    },
    null,
    2
  );
}

// ---- The command ----------------------------------------------------------

export interface KeysOptions {
  skhd?: boolean;
  karabiner?: boolean;
  /** How many slots the defaults cover, and what `--write` persists. */
  slots?: string;
  /** Write the resolved mapping into ~/.agstatus.json so it can be edited. */
  write?: boolean;
}

export async function runKeys(
  opts: KeysOptions,
  log: (line: string) => void,
  deps: { file?: string; shim?: string } = {}
): Promise<number> {
  const file = deps.file ?? agstatusJsonPath();

  let slotCount = DEFAULT_SLOT_COUNT;
  if (opts.slots !== undefined) {
    if (!/^[0-9]{1,2}$/.test(opts.slots) || Number(opts.slots) < 1 || Number(opts.slots) > MAX_SLOTS) {
      log(`✖ --slots takes a whole number between 1 and ${MAX_SLOTS}.`);
      return 1;
    }
    slotCount = Number(opts.slots);
  }

  const { bindings, source, problems } = resolveKeys(slotCount, file);
  for (const problem of problems) log(`⚠ ${problem}`);
  if (bindings.length === 0) {
    log(`✖ No usable shortcuts. Fix or remove "keys" in ${file}.`);
    return 1;
  }

  if (opts.write === true) {
    const keys: Record<string, string> = {};
    for (const b of bindings) keys[String(b.slot)] = b.shortcut;
    try {
      mergeAgstatusJson({ keys }, file);
    } catch (err) {
      log(`✖ Could not write ${file}: ${(err as Error).message}`);
      return 1;
    }
    log(`✔ Wrote "keys" to ${file} — edit it there to change a shortcut.`);
    return 0;
  }

  if (opts.skhd === true) {
    log(toSkhd(bindings, deps.shim));
    return 0;
  }
  if (opts.karabiner === true) {
    log(toKarabiner(bindings, deps.shim));
    return 0;
  }

  log(source === 'file' ? `Shortcuts from ${file}:` : 'Shortcuts (defaults — none configured):');
  log('');
  for (const b of bindings) log(`  ${b.shortcut.padEnd(18)} → agstatus focus ${b.slot}`);
  log('');
  log('Nothing listens for these yet — AgStatus does not capture keys itself.');
  log('  agstatus keys --skhd        config for skhd');
  log('  agstatus keys --karabiner   a Karabiner-Elements complex modification');
  log(
    source === 'file'
      ? `  Edit "keys" in ${file} to change them.`
      : `  agstatus keys --write       save these to ${file} so you can edit them`
  );
  return 0;
}
