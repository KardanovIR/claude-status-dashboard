import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { configDir } from '../settings';
import { isExecutableFile, resolveBins, resumeEnabled } from './config';
import { defaultExecFile, isAgentAlive, type ExecFile } from './exec';
import { CODEX_ID_RE, UUID_RE, isAbsPath, loadRecords, stateDir, validSessionId } from './records';
import type { LocalRecord } from './types';

/**
 * The resume launcher: the one thing on this machine that ever starts an
 * agent (design §5.1, §5.2 step 4).
 *
 * Hosts that respawn a session fall into two shapes — those that take an
 * argv array (`kitten @ launch … -- <launcher> <uuid>`) and those that only
 * accept a command *string* (Terminal.app's `.command` file, iTerm2's
 * `create window … command`, `screen -X screen`, `agtermctl --command`).
 * The second shape is why this file exists: the only string a plan ever
 * builds is `"<abs launcher path>" <uuid>` — a path baked in at install time
 * plus a token that has already passed UUID_RE — so there is nothing in it
 * to quote, escape or inject. Everything the respawn actually needs (the
 * directory, the agent binary, the thread id) is looked up here, on this
 * side, from the local record; none of it is ever on a command line a host
 * assembled, and none of it is ever on the wire.
 *
 * The launcher itself interpolates ONE path: the launcher shim,
 * `<prefix>/bin/agstatus` (renderShim() below). It used to bake in `node`
 * and `dist/cli.js` as well, which made it a second frozen snapshot of a
 * pair that rots on the next `nvm install` — the shim resolves Node at every
 * start instead, and is the only absolute path in AgStatus that never has to
 * be re-baked.
 *
 * What the launcher runs is `agstatus listener resume-exec <uuid>`, i.e.
 * runResumeExec() below: validate the uuid, load the records the hook wrote
 * for it, take the newest, resolve a directory that still exists and is
 * ours, and spawn the recorded agent with exactly `--resume <uuid>`
 * (Claude) or `resume <thread>` (Codex). Never a prompt, never `-c`, never
 * a shell — `codex resume [SESSION_ID] [PROMPT]` takes a positional prompt
 * and `-c key=value` overrides that widen its sandbox, and this is the only
 * reason those never appear.
 */

export const LAUNCHER_NAME = 'agstatus-resume';

/** At most this much of a transcript is read to find the directory it ran in. */
const TRANSCRIPT_MAX_BYTES = 1024 * 1024;
/** Lines of a Claude transcript scanned for a `cwd`; the first one normally carries it. */
const TRANSCRIPT_MAX_LINES = 500;

/** Characters that would break out of the launcher's double quotes, or of its single line. */
const UNQUOTABLE_RE = /["\\$`]|[\u0000-\u001f\u007f]/;

const NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
/** A transcript path is a path from a record: a FIFO planted there must not block the open. */
const NONBLOCK = typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0;

const currentUid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

export function launcherPath(dir: string): string {
  return path.join(dir, LAUNCHER_NAME);
}

/**
 * The launcher shim — `<prefix>/bin/agstatus`, the one program name the
 * LaunchAgent (and, later, a Windows Scheduled Task) ever holds.
 *
 * Why it exists at all: launchd resolves a job's `ProgramArguments[0]`
 * against launchd's OWN default PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) and
 * NEVER against the job's `EnvironmentVariables.PATH` — a bare program name
 * whose only directory was in that dict exits 78 (EX_CONFIG) and never runs,
 * proved with real `launchctl` probes. Node is in none of those four
 * directories for nvm, fnm, volta, mise or `n` users. So argv[0] must be an
 * absolute path AgStatus owns, and the Node it runs must be resolved at
 * launch rather than frozen into a plist (design §5.1, §5.4).
 *
 * That is also the self-heal: `nvm install 22 && nvm uninstall 20`, or a
 * `brew upgrade node`, kills the running agent's interpreter; KeepAlive
 * brings it back after ThrottleInterval (10 s); find_node() picks whatever
 * Node exists now; nothing is reinstalled and nobody is told to reinstall.
 * The plist that named `~/.nvm/versions/node/v20.9.0/bin/node` needed a
 * reinstall for exactly that, and said nothing at all while it was broken.
 */
export const SHIM_NAME = 'agstatus';

export function shimPath(prefix: string): string {
  return path.join(prefix, 'bin', SHIM_NAME);
}

/** `<prefix>/lib/agstatus/dist/cli.js` — the CLI's place in the layout the installer lays down. */
const LAYOUT = ['lib', 'agstatus', 'dist'];

export function layoutCliPath(prefix: string): string {
  return path.join(prefix, ...LAYOUT, 'cli.js');
}

/**
 * The prefix under which this CLI is installed, derived from where it is
 * running from: `<prefix>/lib/agstatus/dist/cli.js` walks back three levels.
 * Anything else — a dev checkout (`cli/dist/cli.js`), an npx cache, a global
 * npm root — is not our layout, so there is no prefix to read off it and the
 * default one is used instead. Those installs still get a shim, an agent and
 * a Resume button; what they do not get is the durability guarantee, because
 * the cli.js the shim points at is somebody else's to move.
 */
export function installPrefix(
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir()
): string {
  const parts = path.dirname(path.resolve(cliPath)).split(path.sep);
  const at = parts.length - LAYOUT.length;
  if (at > 0 && LAYOUT.every((seg, i) => parts[at + i] === seg)) {
    return parts.slice(0, at).join(path.sep) || path.sep;
  }
  return defaultPrefix(platform, home);
}

/**
 * Where an install that was not laid down by the installer puts its shim:
 * `$AGSTATUS_HOME`, else `~/.agstatus` — and `%LOCALAPPDATA%\AgStatus` on
 * Windows, which is the state directory the hook already uses there.
 */
export function defaultPrefix(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir()
): string {
  const named = process.env.AGSTATUS_HOME;
  if (typeof named === 'string' && named !== '') return named;
  if (platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'AgStatus');
  }
  return path.join(home, '.agstatus');
}

/**
 * The shim, byte for byte. Fixed text with exactly two substitutions —
 * `__CLI__`, the entry point, and `__NODE__`, a *hint* tried second (after
 * `$AGSTATUS_NODE` and before the well-known install locations), never the
 * only answer. Both land inside double quotes in POSIX sh, so both go
 * through the same UNQUOTABLE_RE the resume launcher uses.
 *
 * The resolution order below was tested under `env -i
 * PATH=/usr/bin:/bin:/usr/sbin:/sbin` across /bin/sh, dash, zsh and bash,
 * with spaces in paths, with an unmatched glob, and against a version set of
 * v3.1.0/v16.14.0/v18.15.0/v20.9.0 — newest() picks v20.9.0, i.e. the newest
 * that passes the >=18 gate, not the lexically last. Do not "simplify" it:
 * `newest` reverses its arguments by hand because sh has no arrays, and the
 * `ok` gate runs each candidate rather than trusting its path.
 */
const SHIM_TEMPLATE = [
  '#!/bin/sh',
  '# AgStatus launcher — rendered by the AgStatus installer. Do not edit.',
  'set -u',
  'HOME=${HOME:-/nonexistent}',
  'CLI="__CLI__"',
  'NODE_HINT="__NODE__"',
  'ok() {',
  '  [ -n "${1:-}" ] && [ -x "$1" ] &&',
  '    "$1" -e \'process.exit(+process.versions.node.split(".")[0]>=18?0:1)\' >/dev/null 2>&1',
  '}',
  'newest() {',
  '  n=$#',
  '  [ "$n" -gt 0 ] || return 1',
  '  for d do set -- "$d" "$@"; done',
  '  i=0',
  '  for c do',
  '    i=$((i + 1)); [ "$i" -gt "$n" ] && break',
  '    ok "$c" && { printf \'%s\\n\' "$c"; return 0; }',
  '  done',
  '  return 1',
  '}',
  'find_node() {',
  '  for c in "${AGSTATUS_NODE:-}" "$NODE_HINT" /opt/homebrew/bin/node /usr/local/bin/node \\',
  '    /usr/bin/node /opt/local/bin/node "$HOME/.volta/bin/node" \\',
  '    "$HOME/.local/share/fnm/aliases/default/bin/node" \\',
  '    "$HOME/Library/Application Support/fnm/aliases/default/bin/node" \\',
  '    "$HOME/.nodenv/shims/node" "$HOME/.asdf/shims/node" "$HOME/.local/share/mise/shims/node"',
  '  do ok "$c" && { printf \'%s\\n\' "$c"; return 0; }; done',
  '  newest "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node && return 0',
  '  newest "$HOME/.local/share/fnm/node-versions"/*/installation/bin/node && return 0',
  '  newest "$HOME/Library/Application Support/fnm/node-versions"/*/installation/bin/node && return 0',
  '  newest "${N_PREFIX:-/usr/local}/n/versions/node"/*/bin/node && return 0',
  '  newest /opt/homebrew/opt/node@*/bin/node && return 0',
  '  newest /usr/local/opt/node@*/bin/node && return 0',
  '  c=$(command -v node 2>/dev/null) || c=\'\'',
  '  ok "$c" && { printf \'%s\\n\' "$c"; return 0; }',
  '  return 1',
  '}',
  'NODE=$(find_node) || {',
  '  echo "agstatus: no Node.js >=18 found. Looked in the usual places and on PATH." >&2',
  '  echo "  Fix: install Node, or set AGSTATUS_NODE=/absolute/path/to/node." >&2',
  '  exit 127',
  '}',
  'exec "$NODE" "$CLI" "$@"',
  '',
];

/** The `CLI=` and `NODE_HINT=` lines of a rendered shim — the two things doctor reads back. */
const SHIM_CLI_RE = /^CLI="([^"]*)"$/m;
const SHIM_NODE_RE = /^NODE_HINT="([^"]*)"$/m;

export function renderShim(cliPath: string, nodeHint = ''): string {
  requireQuotable('launcher shim', 'cli.js', cliPath);
  // The hint may be absent (`""` never matches `[ -n ]`, so find_node simply
  // moves on); when it is there it has to survive its quotes like any other.
  if (nodeHint !== '') requireQuotable('launcher shim', 'node', nodeHint);
  // Replacer functions, not strings: `$&` and friends are special in a string
  // replacement, and a path containing `$` would be rejected above anyway —
  // this is belt and braces on the one line that writes an executable.
  return SHIM_TEMPLATE.join('\n').replace('__CLI__', () => cliPath).replace('__NODE__', () => nodeHint);
}

/** Writes `<prefix>/bin/agstatus`, 0700, temp + rename. Returns its absolute path. */
export function writeShim(prefix: string, cliPath: string, nodeHint = ''): string {
  const file = shimPath(prefix);
  writeScript(file, renderShim(cliPath, nodeHint));
  return file;
}

/** What a rendered shim runs, read back off disk; undefined when the file is not one of ours. */
export function readShim(file: string): { cli: string; nodeHint: string } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const cli = SHIM_CLI_RE.exec(text)?.[1];
  const nodeHint = SHIM_NODE_RE.exec(text)?.[1];
  return cli === undefined || nodeHint === undefined ? undefined : { cli, nodeHint };
}

/**
 * The state directory `resume-exec` will look in when a *host* starts the
 * launcher: the platform default, with AGSTATUS_STATE_DIR deliberately
 * ignored. The launcher carries one absolute path baked in at install time
 * and nothing else, ever (§5.1), and the environment it is handed belongs to
 * whoever started it — runPlan gives every step `PATH` alone, `open -n -b`
 * hands the app launchd's environment, and an agterm or tmux command string
 * carries no variables at all. So AGSTATUS_STATE_DIR does not survive the
 * trip into the new window, and an install that moved the state dir must not
 * pretend otherwise.
 */
export function launcherStateDir(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir()
): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AGSTATUS_STATE_DIR;
  return stateDir(env, platform, home);
}

/**
 * Whether a launcher written into `dir` could find its records again. False
 * for an install that set AGSTATUS_STATE_DIR: the launcher would read the
 * default directory, find nothing, print one line and close the window —
 * while the host's own tool exited 0 and the board was told `resumed`. The
 * honest answer is to withhold `facts.launcher` there, so those machines
 * keep focus and answer `unsupported-host` for resume (design §5.2 step 4).
 */
export function launcherResolves(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir()
): boolean {
  return isAbsPath(dir) && path.resolve(dir) === path.resolve(launcherStateDir(platform, home));
}

/**
 * An absolute path that survives being put inside the double quotes of a
 * script we render. One check, used by both scripts: a path that is not
 * absolute, or that carries a quote, a backslash, a `$`, a backtick or a
 * control character, throws — neither file is ever written half-safe.
 */
function requireQuotable(subject: string, what: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`The ${subject} needs an absolute ${what} path (got ${JSON.stringify(value)}).`);
  }
  if (UNQUOTABLE_RE.test(value)) {
    throw new Error(`The ${what} path contains a character the ${subject} cannot quote.`);
  }
}

/**
 * Writes one of our scripts 0700, temp + rename so nothing ever sees a
 * half-written file, creating its directory 0700 if it is missing.
 *
 * An exclusive create on an unguessable name: `wx` fails rather than follow
 * a symlink somebody planted at the temp path (the same discipline as the
 * listener's lock file), and the random suffix means a name nobody can
 * predict from this process's pid.
 */
function writeScript(file: string, text: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.agstatus-tmp-${crypto.randomBytes(8).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, text, { mode: 0o700, flag: 'wx' });
    fs.chmodSync(tmp, 0o700); // an existing umask can still have trimmed the mode
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * The launcher script, byte for byte. ONE path is interpolated: the launcher
 * shim, which is the only absolute path AgStatus owns for good. `"$1"` is
 * the shell's own positional argument, so the uuid the host passes goes to
 * `resume-exec` as one argv element whatever it contains.
 *
 * It used to interpolate `node` and `dist/cli.js` instead, which made this
 * file a second frozen snapshot of the same doomed pair as the plist: one
 * `nvm install` and a Resume tap opened a window that printed "no such file
 * or directory" and closed. Delegating to the shim means there is exactly
 * one place where Node is resolved, and it is resolved at every start.
 */
export function renderLauncher(shim: string): string {
  requireQuotable('resume launcher', 'launcher shim', shim);
  return [
    '#!/bin/sh',
    '# AgStatus Focus resume launcher — written by `agstatus listener install`.',
    `exec "${shim}" listener resume-exec "$1"`,
    '',
  ].join('\n');
}

/** The shim an installed launcher delegates to — the one path in its one command. */
const LAUNCHER_EXEC_RE = /^exec "([^"]*)" listener resume-exec "\$1"$/m;

export function launcherTarget(dir: string): string | undefined {
  try {
    return LAUNCHER_EXEC_RE.exec(fs.readFileSync(launcherPath(dir), 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Writes `<stateDir>/agstatus-resume`, 0700, temp + rename so no host ever
 * sees a half-written script. Renders first, so a bad path throws with
 * nothing on disk. Returns the launcher's absolute path.
 */
export function writeLauncher(dir: string, shim: string): string {
  const text = renderLauncher(shim);
  const file = launcherPath(dir);
  writeScript(file, text);
  return file;
}

/** Removes the launcher, if it is there at all: "resume is off" must mean the file is gone. */
export function removeLauncher(dir: string): boolean {
  const file = launcherPath(dir);
  if (fs.lstatSync(file, { throwIfNoEntry: false }) === undefined) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/**
 * Why a script of ours is not one we may run, in a phrase — undefined when
 * it is fine. A regular file (never a symlink: this lstat()s), 0700 exactly,
 * owned by us, in a directory nobody else may write to. Doctor prints the
 * phrase; usableLauncher() only asks whether there is one.
 */
export function scriptProblem(file: string, uid: number | undefined = currentUid()): string | undefined {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return 'missing';
  }
  if (st.isSymbolicLink()) return 'a symlink, not a file of ours';
  if (!st.isFile()) return 'not a regular file';
  const mode = st.mode & 0o777;
  if (mode !== 0o700) return `mode ${mode.toString(8)}, expected 700`;
  if (uid !== undefined && st.uid !== uid) return `owned by uid ${st.uid}, not by you`;
  try {
    if ((fs.statSync(path.dirname(file)).mode & 0o022) !== 0) {
      return `in ${path.dirname(file)}, which others may write to`;
    }
  } catch {
    return `in ${path.dirname(file)}, which cannot be read`;
  }
  return undefined;
}

/**
 * The launcher's path when it is safe to run — and, since it does nothing
 * itself but `exec` the shim, when the shim it delegates to is safe to run
 * too. Checking only the launcher would quietly relocate the "0700 and
 * yours" guarantee onto a file nobody looked at. This is where
 * `MachineFacts.launcher` comes from, so anything short of that leaves the
 * fact absent and every resume plan `unsupported-host`.
 */
export function usableLauncher(dir: string, uid: number | undefined = currentUid()): string | undefined {
  const file = launcherPath(dir);
  if (scriptProblem(file, uid) !== undefined) return undefined;
  const shim = launcherTarget(dir);
  if (shim === undefined || scriptProblem(shim, uid) !== undefined) return undefined;
  return file;
}

/** An absolute path that stat()s as a directory belonging to us — the only cwd a resume may enter. */
function ownedDir(p: unknown, uid: number | undefined): p is string {
  if (!isAbsPath(p)) return false;
  try {
    const st = fs.statSync(p);
    return st.isDirectory() && (uid === undefined || st.uid === uid);
  } catch {
    return false;
  }
}

/**
 * The head of a transcript: at most 1 MiB, opened O_NOFOLLOW so a symlink
 * planted where a transcript belongs reads as nothing, O_NONBLOCK so a FIFO
 * planted there cannot stop the open, and read only from a regular file that
 * is ours (the fstat after the open is what rejects the FIFO).
 */
function readHead(file: string, uid: number | undefined): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return undefined;
    if (uid !== undefined && st.uid !== uid) return undefined;
    const span = Math.min(st.size, TRANSCRIPT_MAX_BYTES);
    if (span <= 0) return undefined;
    const buf = Buffer.alloc(span);
    const got = fs.readSync(fd, buf, 0, span, 0);
    return buf.subarray(0, got).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing we can do */
      }
    }
  }
}

/** `cwd` as either transcript writes it: top level (Claude) or inside `payload` (a Codex session_meta). */
function lineCwd(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.cwd === 'string') return obj.cwd;
  const payload = obj.payload;
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const inner = (payload as Record<string, unknown>).cwd;
    if (typeof inner === 'string') return inner;
  }
  return undefined;
}

/**
 * The first directory a transcript names that still exists and is ours.
 * `maxLines` is 1 for a Codex rollout, whose opening `session_meta` line is
 * the only one that carries the thread's directory.
 */
function transcriptCwd(file: string, uid: number | undefined, maxLines: number): string | undefined {
  const text = readHead(file, uid);
  if (text === undefined) return undefined;
  const lines = text.split('\n', maxLines);
  for (const line of lines) {
    if (line === '') continue;
    const cwd = lineCwd(line);
    if (cwd !== undefined && ownedDir(cwd, uid)) return cwd;
  }
  return undefined;
}

/**
 * Claude keeps one transcript per session under
 * `~/.claude/projects/<encoded>/<session-id>.jsonl`. The directory name is a
 * LOSSY encoding of the path it was opened in (every separator, dot and
 * space becomes `-`), so it is never decoded — it is only a folder to look
 * inside. The directory the session actually ran in is a field in the file.
 * A resumed session writes a second transcript under a second encoded name,
 * so candidates are read newest first.
 */
function claudeTranscriptCwd(sessionId: string, uid: number | undefined): string | undefined {
  if (!validSessionId(sessionId)) return undefined;
  const projects = path.join(configDir(), 'projects');
  let names: string[];
  try {
    names = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  const candidates: Array<{ file: string; mtime: number }> = [];
  for (const name of names) {
    if (name === '.' || name === '..' || name.includes('/') || name.includes(path.sep)) continue;
    const file = path.join(projects, name, `${sessionId}.jsonl`);
    try {
      const st = fs.lstatSync(file);
      if (st.isFile()) candidates.push({ file, mtime: st.mtimeMs });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of candidates) {
    const cwd = transcriptCwd(file, uid, TRANSCRIPT_MAX_LINES);
    if (cwd) return cwd;
  }
  return undefined;
}

/**
 * Where a resume should start (design §5.2 step 4): the recorded cwd when it
 * is still a directory of ours, else what the agent's own transcript says —
 * Claude's project log found by session id, Codex's `session_meta`. Undefined
 * when nothing survives, and then the resume fails honestly rather than
 * starting an agent somewhere the user did not leave it.
 */
export function resolveResumeCwd(
  record: LocalRecord,
  uid: number | undefined = currentUid()
): string | undefined {
  if (ownedDir(record.cwd, uid)) return record.cwd;
  if (record.agent === 'claude') {
    const fromProjects = claudeTranscriptCwd(record.session_id, uid);
    if (fromProjects) return fromProjects;
  }
  if (record.agent === 'codex' && record.transcript_path) {
    const fromMeta = transcriptCwd(record.transcript_path, uid, 1);
    if (fromMeta) return fromMeta;
  }
  return undefined;
}

/** A tool from a table of absolute paths; anything else counts as missing. */
function bin(bins: Record<string, string>, name: string): string | undefined {
  const value = bins[name];
  return typeof value === 'string' && path.isAbsolute(value) ? value : undefined;
}

/**
 * The exact launch that resumes this session: the recorded agent binary and
 * the two arguments it may ever get. Claude resolves a session id machine-
 * wide; Codex wants the *root* thread id, which is what the hook recorded.
 * Both ids are re-checked against their regex here, whatever the record
 * loader already did — this is the last place before an argv.
 */
export function resumeArgv(
  record: LocalRecord,
  bins: Record<string, string>
): { file: string; args: string[] } | undefined {
  if (record.agent === 'claude') {
    const file = bin(bins, 'claude');
    if (!file || !UUID_RE.test(record.session_id)) return undefined;
    return { file, args: ['--resume', record.session_id] };
  }
  const file = bin(bins, 'codex');
  const id = record.codex?.root_thread_id ?? record.session_id;
  // CODEX_ID_RE is anchored on a hex digit precisely so this argument can
  // never begin with `-`: `codex resume` would read that as a flag, and this
  // is the last regex before an argv on the one path that starts a process.
  if (!file || !CODEX_ID_RE.test(id) || id.startsWith('-')) return undefined;
  return { file, args: ['resume', id] };
}

/**
 * The agent binary for this record: the path the hook captured under the
 * user's own shell when it still passes the executable-file check, else the
 * listener's own resolution. Both are absolute; PATH never picks what runs.
 */
function resumeBins(record: LocalRecord): Record<string, string> {
  const name = record.agent;
  const recorded = record.bins[name];
  if (typeof recorded === 'string' && path.isAbsolute(recorded) && isExecutableFile(recorded)) {
    return { [name]: recorded };
  }
  const resolved = resolveBins()[name];
  return resolved ? { [name]: resolved } : {};
}

export interface ResumeExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}
export type ResumeExec = (file: string, args: string[], opts: ResumeExecOptions) => Promise<{ code: number }>;

export interface ResumeExecDeps {
  stateDir?: string;
  log?: (line: string) => void;
  /** Tests only. The real thing is the spawn below, which hands the agent this terminal. */
  exec?: ResumeExec;
  /** The bounded, shell-free launcher the liveness check reads `ps` with. */
  execFile?: ExecFile;
  platform?: NodeJS.Platform;
  /** Tests only: the `"resume": false` switch, read from ~/.agstatus.json by default. */
  resumeOn?: boolean;
}

/** Signals this wrapper must not die from while the agent it started is running. */
const HELD_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGQUIT'];
/** Signals that mean "go away", which belong to the agent, not to its wrapper. */
const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP'];

/** `process.on` for a signal the platform may not know; an unsupported one is simply not held. */
function onSignal(signal: NodeJS.Signals, handler: () => void): boolean {
  try {
    process.on(signal, handler);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hands the terminal to the agent. There is no `execv` in Node, so the
 * closest thing is a child with inherited stdio, undetached (so it shares
 * the process group and sees Ctrl-C), and this process exiting with its
 * code. No shell, and the environment is this terminal's own — `file` is
 * absolute, so PATH never decides what runs, only what the agent itself
 * finds later.
 *
 * Because it is not a real `execv`, this process is still in the middle:
 * the terminal delivers Ctrl-C to the whole foreground group, the agent
 * treats SIGINT as "interrupt this turn" and lives, and Node's default
 * action would kill the wrapper — taking the window the emulator is
 * watching, and with it the session the tap just restored. So for as long
 * as the child runs, SIGINT and SIGQUIT are held (no-op handlers, the
 * signal still reaches the agent), and SIGTERM/SIGHUP are forwarded to the
 * child rather than acted on here. Every handler comes off again when the
 * child is gone.
 */
const spawnInherit: ResumeExec = (file, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: 'inherit',
      shell: false,
      detached: false,
      windowsHide: true,
    });
    const hold = (): void => {
      /* the agent has it too, and it decides what it means */
    };
    const held = HELD_SIGNALS.filter((signal) => onSignal(signal, hold));
    const forwarders = new Map<NodeJS.Signals, () => void>();
    for (const signal of FORWARDED_SIGNALS) {
      const forward = (): void => {
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          process.kill(pid, signal);
        } catch {
          /* already gone */
        }
      };
      if (onSignal(signal, forward)) forwarders.set(signal, forward);
    }
    const done = (code: number): void => {
      for (const signal of held) process.removeListener(signal, hold);
      for (const [signal, forward] of forwarders) process.removeListener(signal, forward);
      resolve({ code });
    };
    child.once('error', () => done(1));
    child.once('exit', (code) => done(typeof code === 'number' ? code : 1));
  });

/**
 * `agstatus listener resume-exec <session-uuid>` — the body of the launcher,
 * and the only path in AgStatus that starts an agent. Returns the agent's
 * own exit code when it ran, 1 for everything else, and says why on stderr
 * in one line. The messages name no path from the record except the
 * directory the agent is about to open, which the user is looking at anyway.
 */
export async function runResumeExec(sessionId: string, deps: ResumeExecDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  // Before any filesystem access: an id that is not a uuid never becomes a path.
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    log('agstatus: resume needs a session uuid.');
    return 1;
  }
  // The switch is not only a planner gate: this is the subcommand that
  // starts an agent, so it refuses too, and `install --no-resume` deletes
  // the launcher outright (design §11).
  if (!(deps.resumeOn ?? resumeEnabled())) {
    log('agstatus: resume is switched off on this machine.');
    return 1;
  }
  const dir = deps.stateDir ?? stateDir();
  const { records } = loadRecords(dir, sessionId); // newest first, each one validated
  const record = records[0];
  if (!record) {
    log('agstatus: no local record for that session on this machine — nothing to resume.');
    return 1;
  }
  // Liveness, again and last: the listener checked it when it planned, but a
  // transient `ps` failure there, or a command the board re-sent on the next
  // SSE connect, must not put a second `--resume <same uuid>` on one
  // transcript. Whatever answered the plan, this is the check that counts.
  const execFile = deps.execFile ?? defaultExecFile;
  const platform = deps.platform ?? process.platform;
  for (const candidate of records) {
    if (await isAgentAlive(candidate, execFile, platform)) {
      log('agstatus: that session is still running.');
      return 1;
    }
  }
  const cwd = resolveResumeCwd(record);
  if (!cwd) {
    log('agstatus: the directory that session ran in is gone — resume it by hand.');
    return 1;
  }
  const argv = resumeArgv(record, resumeBins(record));
  if (!argv) {
    log(`agstatus: no ${record.agent} binary found on this machine — resume it by hand.`);
    return 1;
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The agent's own PATH from the hook (design §5.1): a host like `open -na
  // … -e` starts the launcher with the app's environment, not the user's
  // shell, and the agent's tools would be missing. argv[0] is absolute, so
  // this decides nothing about what is launched here.
  if (record.path) env.PATH = record.path;
  log(`agstatus: resuming ${record.agent} in ${cwd}`);
  const exec = deps.exec ?? spawnInherit;
  try {
    const { code } = await exec(argv.file, argv.args, { cwd, env });
    return typeof code === 'number' && Number.isInteger(code) && code >= 0 ? code : 1;
  } catch {
    log(`agstatus: ${record.agent} could not be started.`);
    return 1;
  }
}
