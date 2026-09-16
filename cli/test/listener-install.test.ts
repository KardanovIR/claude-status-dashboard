import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  boardBase,
  machineKey,
  mergeAgstatusJson,
  publicId,
  readMachine,
  resolveBins,
  resolveBoardUrl,
  resolveListenerConfig,
  resolveSecret,
  writeMachine,
} from '../src/listener/config';
import {
  LAUNCH_AGENT_LABEL,
  doctor,
  install,
  listenerInstalled,
  plistEnv,
  plistPath,
  plistProgramArguments,
  plistUrlFlag,
  renderPlist,
  status,
  uninstall,
  type Exec,
} from '../src/listener/install';
import { runUninstall } from '../src/index';

/**
 * The installer is exercised against a throwaway HOME and state dir with
 * launchctl replaced by a recorder, so nothing here touches launchd or the
 * developer's own config. Every env var the config resolution reads is
 * pinned per test.
 */

const BOARD = 'https://s.example/w/ags_x';
// The hook's fixture (cli/test/host.test.ts): this id + board must hash to
// the same public id there and here, or the server routes to nobody.
const MACHINE_ID = '6f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const EXPECTED_KEY = '3699df22d970fdbde721730bb9def92f026202bf211f8fe081e1f46b8a4e4828';
const EXPECTED_PUBLIC_ID = 'fa1ac1e7c51a98ad6856f1299ad52080';

const ENV_KEYS = [
  'HOME', 'AGSTATUS_STATE_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  'CLAUDE_STATUS_URL', 'CLAUDE_STATUS_SECRET', 'AGSTATUS_FOCUS', 'AGSTATUS_RESUME', 'AGSTATUS_HOME',
  // The installer copies this one into the plist, so a developer who has it
  // set would otherwise change what every assertion below is reading.
  'AGSTATUS_NODE',
];

interface Workspace {
  home: string;
  state: string;
}

const CODEX_CMD = (url: string, secret?: string): string =>
  `CLAUDE_STATUS_URL="${url}" AGSTATUS_SOURCE=codex${secret ? ` CLAUDE_STATUS_SECRET='${secret}'` : ''} node "$HOME/.codex/hooks/agstatus-hook.js"`;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8'));

/** A cli.js on disk where the install will point at it, so doctor has something to stat. */
function withCliAt(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/usr/bin/env node\n');
  return file;
}

function withSettingsUrl(home: string, url: string): void {
  writeJson(path.join(home, '.claude', 'settings.json'), { env: { CLAUDE_STATUS_URL: url }, model: 'opus' });
}

function withCodexUrl(home: string, url: string, secret?: string): void {
  writeJson(path.join(home, '.codex', 'hooks.json'), {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: CODEX_CMD(url, secret) }] }] },
  });
}

/**
 * launchctl stand-in: records every call, answers success (or a canned
 * print). It also answers doctor's Node probe — a rendered copy of the shim,
 * run to ask which Node the real one would pick — so no test ever executes a
 * script or reads the developer's own Node installs. `probeEnv` keeps the
 * environment that probe was handed, which is the only way to check that
 * doctor asks the question under the *agent's* environment and not this
 * process's.
 */
function recorder(print?: string, node: { code: number; stdout: string } = NODE_PROBE): {
  exec: Exec;
  calls: string[][];
  probeEnv: () => NodeJS.ProcessEnv | undefined;
} {
  const calls: string[][] = [];
  let probed: NodeJS.ProcessEnv | undefined;
  const exec: Exec = async (file, args, env) => {
    calls.push([path.basename(file), ...args]);
    if (path.basename(file) === 'agstatus') {
      probed = env;
      return node;
    }
    if (args[0] === 'print') return print ? { code: 0, stdout: print } : { code: 113, stdout: '' };
    return { code: 0, stdout: '' };
  };
  return { exec, calls, probeEnv: () => probed };
}

/** What the shim's own resolution answers on a healthy machine. */
const NODE_PROBE = { code: 0, stdout: '/usr/local/bin/node (20.9.0)\n' };
/** `launchctl print` for a job that is up, with a clean last run. */
const PRINTS_RUNNING = 'com.agstatus.listener = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}\n';

let saved: Record<string, string | undefined>;
let ws: Workspace;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-lhome-'));
  // The macOS default under this HOME (every call below is platform:
  // 'darwin'): the resume launcher is handed no environment, so it reads
  // exactly this path — an install that moved the state dir keeps focus and
  // loses resume, which the tests further down assert.
  ws = { home, state: path.join(home, 'Library', 'Application Support', 'AgStatus') };
  fs.mkdirSync(ws.state, { recursive: true, mode: 0o700 });
  process.env.HOME = ws.home;
  process.env.AGSTATUS_STATE_DIR = ws.state;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(ws.home, { recursive: true, force: true });
});

const quiet = (): { log: (l: string) => void; out: () => string } => {
  const lines: string[] = [];
  return { log: (l) => lines.push(l), out: () => lines.join('\n') };
};

/**
 * An installer layout inside the throwaway HOME: the CLI at
 * `<prefix>/lib/agstatus/dist/cli.js`, so the shim lands at `<prefix>/bin/agstatus`
 * — the prefix read back off the CLI's own location, which is what a real
 * `curl … | sh` install looks like. `<home>/opt/agstatus` deliberately is not
 * the default prefix (`<home>/.agstatus`), so a test that sees the shim there
 * has proved the derivation and not the fallback.
 */
const prefix = (): string => path.join(ws.home, 'opt', 'agstatus');
const cliPath = (): string => path.join(prefix(), 'lib', 'agstatus', 'dist', 'cli.js');
const shim = (): string => path.join(prefix(), 'bin', 'agstatus');
/** The resume launcher, which lives in the state dir rather than the prefix. */
const launcher = (): string => path.join(ws.state, 'agstatus-resume');

const darwin = (extra: Record<string, unknown> = {}) => ({
  platform: 'darwin' as const,
  uid: 501,
  cliPath: cliPath(),
  nodePath: '/usr/local/bin/node',
  ...extra,
});

describe('boardBase', () => {
  it('strips one trailing slash and one trailing /webhook, like the hook', () => {
    expect(boardBase('https://s.example/w/ags_x')).toBe('https://s.example/w/ags_x');
    expect(boardBase('https://s.example/w/ags_x/')).toBe('https://s.example/w/ags_x');
    expect(boardBase('https://s.example/w/ags_x/webhook')).toBe('https://s.example/w/ags_x');
    expect(boardBase('https://s.example/w/ags_x/webhook/')).toBe('https://s.example/w/ags_x');
    expect(boardBase('http://localhost:3000')).toBe('http://localhost:3000');
    // Only one of each: a second slash is the caller's typo, not ours to fix.
    expect(boardBase('https://s.example//')).toBe('https://s.example/');
  });
});

describe('machine key and public id', () => {
  it('match the derivation the hook uses for the same machine and board', () => {
    const key = machineKey(MACHINE_ID, BOARD);
    expect(key).toBe(EXPECTED_KEY);
    expect(publicId(key)).toBe(EXPECTED_PUBLIC_ID);
    // Two rounds, exactly as host.test.ts's expectedMachineId() computes it.
    const hookKey = crypto.createHash('sha256').update(`${MACHINE_ID}\n${BOARD}`).digest('hex');
    const hookId = crypto.createHash('sha256').update(hookKey).digest('hex').slice(0, 32);
    expect(publicId(machineKey(MACHINE_ID, BOARD))).toBe(hookId);
  });

  it('give the same id however the board URL was pasted', () => {
    const id = (url: string) => publicId(machineKey(MACHINE_ID, boardBase(url)));
    expect(id(`${BOARD}/`)).toBe(EXPECTED_PUBLIC_ID);
    expect(id(`${BOARD}/webhook`)).toBe(EXPECTED_PUBLIC_ID);
    expect(id('https://other.example/w/ags_x')).not.toBe(EXPECTED_PUBLIC_ID);
  });
});

describe('machine.json', () => {
  it('round-trips with a 0600 file, and rejects anything without a uuid', () => {
    writeMachine(ws.state, { machineId: MACHINE_ID, name: 'Studio', machineHost: 'host.local' });
    const file = path.join(ws.state, 'machine.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readMachine(ws.state)).toEqual({ machineId: MACHINE_ID, name: 'Studio', machineHost: 'host.local' });

    fs.writeFileSync(file, JSON.stringify({ machineId: 'not-a-uuid', name: 'x' }));
    expect(readMachine(ws.state)).toBeNull();
    fs.writeFileSync(file, '{oops');
    expect(readMachine(ws.state)).toBeNull();
    expect(() => writeMachine(ws.state, { machineId: 'nope' })).toThrow(/uuid/);
  });
});

describe('renderPlist', () => {
  it('escapes XML and carries the label, PATH, program arguments and both log paths', () => {
    const xml = renderPlist({
      label: LAUNCH_AGENT_LABEL,
      program: '/Users/a&b/<agstatus>/bin/agstatus',
      args: ['listener', 'run'],
      path: '/opt/homebrew/bin:/usr/bin:"q"',
      logFile: '/Users/a&b/Library/listener.log',
    });
    expect(xml).toContain(`<key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(xml).toContain('<string>/Users/a&amp;b/&lt;agstatus&gt;/bin/agstatus</string>');
    expect(xml).not.toContain('<agstatus>');
    expect(xml).toContain('<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:&quot;q&quot;</string>');
    expect(xml).toContain('<key>StandardOutPath</key><string>/Users/a&amp;b/Library/listener.log</string>');
    expect(xml).toContain('<key>StandardErrorPath</key><string>/Users/a&amp;b/Library/listener.log</string>');
    expect(xml).toContain('<key>RunAtLoad</key><true/>');
    // KeepAlive + ThrottleInterval is the self-heal: the shim resolves Node at
    // every start, so a Node that vanished under the running agent costs one
    // restart, not a reinstall.
    expect(xml).toContain('<key>KeepAlive</key><true/>');
    expect(xml).toContain('<key>ThrottleInterval</key><integer>10</integer>');
    expect(plistProgramArguments(xml)).toEqual(['/Users/a&b/<agstatus>/bin/agstatus', 'listener', 'run']);
  });

  it('names one program and never an interpreter', () => {
    // launchd resolves ProgramArguments[0] against its OWN default PATH and
    // never against EnvironmentVariables.PATH below — a bare name there exits
    // 78 without running. So argv[0] is the shim, and nothing in the file is
    // allowed to be `node` or a cli.js again.
    const xml = renderPlist({
      label: LAUNCH_AGENT_LABEL,
      program: '/Users/demo/.agstatus/bin/agstatus',
      args: ['listener', 'run', '--url', 'https://s.example/w/ags_x'],
      path: '/usr/local/bin:/usr/bin',
      logFile: '/tmp/listener.log',
    });
    expect(plistProgramArguments(xml)).toEqual([
      '/Users/demo/.agstatus/bin/agstatus', 'listener', 'run', '--url', 'https://s.example/w/ags_x',
    ]);
    expect(xml).not.toContain('/bin/node');
    expect(xml).not.toContain('cli.js');
  });
});

describe('install', () => {
  it('creates machine.json, turns focus on without dropping keys, writes the plist and bootstraps it', async () => {
    withSettingsUrl(ws.home, BOARD);
    const agstatusJson = path.join(ws.home, '.agstatus.json');
    writeJson(agstatusJson, { url: 'https://old.example/w/ags_old', secret: 's3cr3t', extra: 1 });
    const { exec, calls } = recorder();
    const { log, out } = quiet();

    expect(await install(darwin({ name: 'Studio', exec, log }))).toBe(0);

    const machineFile = path.join(ws.state, 'machine.json');
    expect(fs.statSync(machineFile).mode & 0o777).toBe(0o600);
    const machine = readJson(machineFile);
    expect(machine.machineId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(machine.name).toBe('Studio');
    expect(machine.machineHost).toBe(os.hostname());

    // url/secret untouched, focus added, mode tightened.
    expect(readJson(agstatusJson)).toEqual({
      url: 'https://old.example/w/ags_old',
      secret: 's3cr3t',
      extra: 1,
      focus: true,
    });
    expect(fs.statSync(agstatusJson).mode & 0o777).toBe(0o600);

    const plist = plistPath(ws.home);
    expect(plist).toBe(path.join(ws.home, 'Library', 'LaunchAgents', 'com.agstatus.listener.plist'));
    const xml = fs.readFileSync(plist, 'utf8');
    // argv[0] is the shim under the prefix, never node and never cli.js.
    expect(plistProgramArguments(xml)).toEqual([shim(), 'listener', 'run']);
    expect(xml).not.toContain('cli.js');
    expect(fs.statSync(shim()).mode & 0o777).toBe(0o700);
    expect(xml).toContain(`<key>AGSTATUS_STATE_DIR</key><string>${ws.state}</string>`);
    expect(xml).toContain(`<string>${path.join(ws.state, 'listener.log')}</string>`);

    expect(calls).toEqual([
      ['launchctl', 'bootout', 'gui/501/com.agstatus.listener'],
      ['launchctl', 'bootstrap', 'gui/501', plist],
    ]);

    const expectedId = publicId(machineKey(machine.machineId as string, BOARD));
    expect(out()).toContain('This machine will appear on your board as "Studio"');
    expect(out()).toContain(`Launcher:  ${shim()}`);
    expect(out()).toContain(`CLI:       ${cliPath()}`);
    expect(out()).toContain(`"id": "${expectedId}"`);
    expect(out()).toContain(path.join(ws.state, 'sessions'));
    expect(out()).not.toContain(machine.machineId as string); // the raw id never leaves machine.json
  });

  it('writes the url into a fresh ~/.agstatus.json and keeps the machine id on a re-run', async () => {
    withSettingsUrl(ws.home, BOARD);
    const { exec } = recorder();
    const { log } = quiet();
    expect(await install(darwin({ exec, log }))).toBe(0);
    const first = readJson(path.join(ws.state, 'machine.json'));
    expect(first.name).toBe('Mac');
    expect(readJson(path.join(ws.home, '.agstatus.json'))).toEqual({ focus: true, url: BOARD });

    expect(await install(darwin({ exec, log, name: 'Renamed' }))).toBe(0);
    const second = readJson(path.join(ws.state, 'machine.json'));
    expect(second.machineId).toBe(first.machineId);
    expect(second.name).toBe('Renamed');
  });

  it('refuses when no board URL is configured, writing nothing', async () => {
    const { exec, calls } = recorder();
    const { log, out } = quiet();
    expect(await install(darwin({ exec, log }))).toBe(1);
    expect(out()).toMatch(/No board URL configured/);
    expect(fs.existsSync(path.join(ws.state, 'machine.json'))).toBe(false);
    expect(fs.existsSync(path.join(ws.home, '.agstatus.json'))).toBe(false);
    expect(fs.existsSync(plistPath(ws.home))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses when Claude Code and Codex name different boards', async () => {
    withSettingsUrl(ws.home, BOARD);
    withCodexUrl(ws.home, 'https://s.example/w/ags_other');
    const { exec, calls } = recorder();
    const { log, out } = quiet();
    expect(await install(darwin({ exec, log }))).toBe(1);
    expect(out()).toMatch(/different boards/);
    expect(calls).toEqual([]);
    // An explicit --url settles it.
    expect(await install(darwin({ exec, log, url: BOARD }))).toBe(0);
  });

  it('refuses off macOS without touching anything', async () => {
    withSettingsUrl(ws.home, BOARD);
    const { exec, calls } = recorder();
    const { log, out } = quiet();
    expect(await install({ platform: 'linux', exec, log })).toBe(1);
    expect(out()).toMatch(/macOS/);
    expect(out()).toMatch(/listener run/);
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(ws.state, 'machine.json'))).toBe(false);
  });

  it('keeps --url in the agent arguments, so run, status and doctor follow the board the id was printed for', async () => {
    withSettingsUrl(ws.home, BOARD);
    const other = 'https://s.example/w/ags_other';
    const { exec } = recorder(PRINTS_RUNNING);
    const { log, out } = quiet();
    expect(await install(darwin({ exec, log, url: other }))).toBe(0);

    const xml = fs.readFileSync(plistPath(ws.home), 'utf8');
    expect(plistProgramArguments(xml)).toEqual([shim(), 'listener', 'run', '--url', other]);
    expect(plistUrlFlag(xml)).toBe(other);
    const machine = readJson(path.join(ws.state, 'machine.json'));
    const idFor = (url: string): string => publicId(machineKey(machine.machineId as string, url));
    expect(out()).toContain(`"id": "${idFor(other)}"`);
    // The hook follows settings.json, so the installer says the two ids will not match.
    expect(out()).toContain('⚠ --url names a different board than');
    expect(out()).toContain(path.join(ws.home, '.claude', 'settings.json'));
    expect(out()).toContain(`    ${BOARD}`);

    // `listener run --url` derives the same key install printed.
    const cfg = resolveListenerConfig({ url: other });
    if ('error' in cfg) throw new Error(cfg.error);
    expect(cfg.machinePublicId).toBe(idFor(other));

    const s = quiet();
    expect(await status(darwin({ exec, log: s.log }))).toBe(0);
    expect(s.out()).toContain(`Board:     ${other} (--url kept in the agent)`);
    expect(s.out()).toContain(idFor(other));
    expect(s.out()).not.toContain(idFor(BOARD));

    const d = quiet();
    expect(await doctor(darwin({ log: d.log }))).toBe(1);
    expect(d.out()).toContain(`✖ the agent runs with --url ${other}, but the hook reads ${BOARD}`);
  });

  it('writes plain `listener run` without --url, and no warning when --url agrees with the files', async () => {
    withSettingsUrl(ws.home, BOARD);
    const { exec } = recorder();
    const { log, out } = quiet();
    expect(await install(darwin({ exec, log, url: `${BOARD}/` }))).toBe(0);
    expect(plistProgramArguments(fs.readFileSync(plistPath(ws.home), 'utf8')).slice(1)).toEqual(['listener', 'run', '--url', `${BOARD}/`]);
    expect(out()).not.toContain('⚠ --url');
    expect(await install(darwin({ exec, log }))).toBe(0);
    const xml = fs.readFileSync(plistPath(ws.home), 'utf8');
    expect(plistProgramArguments(xml).slice(1)).toEqual(['listener', 'run']);
    expect(plistUrlFlag(xml)).toBeUndefined();
    // A plist edited by hand into something that is not a board URL is not followed either.
    expect(plistUrlFlag(renderPlist({
      label: LAUNCH_AGENT_LABEL, program: '/p/bin/agstatus', args: ['listener', 'run', '--url', 'not a url'], path: '', logFile: '/l',
    }))).toBeUndefined();
  });
});

describe('a hook that predates Focus', () => {
  it('is named by install and doctor, with the way out', async () => {
    withSettingsUrl(ws.home, BOARD);
    const hook = path.join(ws.home, '.claude', 'hooks', 'agstatus-hook.js');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '// agstatus 1.3.0 — reports status, knows nothing about Focus\n');

    const { exec } = recorder();
    const installed = quiet();
    expect(await install(darwin({ exec, log: installed.log }))).toBe(0);
    expect(installed.out()).toContain('predates Focus');
    expect(installed.out()).toContain(hook);
    // The documented channel, not the retired one: npm still serves 1.3.0, so
    // `npx agstatus init` keeps working — it is simply not what we say.
    expect(installed.out()).toContain('Run `agstatus init` to refresh it.');
    expect(installed.out()).not.toContain('npx agstatus');

    const checked = quiet();
    expect(await doctor(darwin({ exec: recorder().exec, log: checked.log }))).toBe(1);
    expect(checked.out()).toContain('predates Focus');

    // A hook that carries the Focus code is silent.
    fs.writeFileSync(hook, 'function machineKey(machineId, base) { return machineId + base; }\n');
    const current = quiet();
    await doctor(darwin({ exec: recorder().exec, log: current.log }));
    expect(current.out()).not.toContain('predates Focus');
  });
});

describe('the resume launcher', () => {
  it('is written 0700 with both absolute paths baked in, and doctor vouches for it', async () => {
    withSettingsUrl(ws.home, BOARD);
    const { exec } = recorder();
    const { log, out } = quiet();
    expect(await install(darwin({ exec, log }))).toBe(0);

    expect(fs.statSync(launcher()).mode & 0o777).toBe(0o700);
    // One interpolated path, and it is the shim: node and cli.js are no
    // longer frozen into this file either.
    expect(fs.readFileSync(launcher(), 'utf8')).toBe(
      '#!/bin/sh\n' +
        '# AgStatus Focus resume launcher — written by `agstatus listener install`.\n' +
        `exec "${shim()}" listener resume-exec "$1"\n`
    );
    expect(out()).toContain(launcher());

    const checked = quiet();
    await doctor(darwin({ exec: recorder().exec, log: checked.log }));
    expect(checked.out()).toContain(`✔ ${launcher()}`);

    const shown = quiet();
    await status(darwin({ exec: recorder().exec, log: shown.log }));
    expect(shown.out()).toContain(`Resume:    on — ${launcher()}`);
  });

  it('is reported as a problem by doctor once its mode is loosened', async () => {
    withSettingsUrl(ws.home, BOARD);
    expect(await install(darwin({ exec: recorder().exec, log: quiet().log }))).toBe(0);
    fs.chmodSync(launcher(), 0o755);

    const checked = quiet();
    expect(await doctor(darwin({ exec: recorder().exec, log: checked.log }))).toBe(1);
    // The mode it actually has, not a phrase that covers three unrelated faults.
    expect(checked.out()).toContain(`✖ ${launcher()}: mode 755, expected 700`);

    fs.rmSync(launcher());
    const missing = quiet();
    expect(await doctor(darwin({ exec: recorder().exec, log: missing.log }))).toBe(1);
    expect(missing.out()).toContain(`✖ ${launcher()} missing`);
  });

  it('is named for what it is when it predates the shim, not called "not 0700"', async () => {
    withSettingsUrl(ws.home, BOARD);
    withCliAt(cliPath());
    expect(await install(darwin({ exec: recorder().exec, log: quiet().log }))).toBe(0);

    // What every install up to 1.3.0 has on disk: node and cli.js frozen into
    // the launcher itself — the pair the shim exists to stop freezing. The
    // file is 0700 and ours; its shape is the only thing wrong with it, and
    // "not a 0700 regular file owned by you" is a claim `ls -l` disproves.
    fs.writeFileSync(
      launcher(),
      '#!/bin/sh\n' +
        '# AgStatus Focus resume launcher — written by `agstatus listener install`.\n' +
        `exec "/usr/local/bin/node" "${cliPath()}" listener resume-exec "$1"\n`
    );
    fs.chmodSync(launcher(), 0o700);

    const checked = quiet();
    expect(await doctor(darwin({ exec: recorder(PRINTS_RUNNING).exec, log: checked.log }))).toBe(1);
    expect(checked.out()).toContain(
      `✖ ${launcher()}: not the one-line launcher this version writes (it predates the launcher shim)`
    );
    expect(checked.out()).not.toContain('is not a 0700 regular file owned by you');
    expect(fs.statSync(launcher()).mode & 0o777).toBe(0o700);

    const shown = quiet();
    await status(darwin({ exec: recorder(PRINTS_RUNNING).exec, log: shown.log }));
    expect(shown.out()).toContain('it predates the launcher shim');
  });

  it('--no-resume writes "resume": false, and install, doctor and status all say resume is off', async () => {
    withSettingsUrl(ws.home, BOARD);
    const { log, out } = quiet();
    expect(await install(darwin({ exec: recorder().exec, log, resume: false }))).toBe(0);
    expect(readJson(path.join(ws.home, '.agstatus.json'))).toEqual({ focus: true, url: BOARD, resume: false });
    expect(out()).toContain('Resume:    off');

    const checked = quiet();
    await doctor(darwin({ exec: recorder().exec, log: checked.log }));
    expect(checked.out()).toContain('resume is off');
    expect(checked.out()).not.toContain(`✖ ${launcher()}`); // a choice, not a fault

    const shown = quiet();
    await status(darwin({ exec: recorder().exec, log: shown.log }));
    expect(shown.out()).toContain('Resume:    off');

    // Off means the file is gone: the one mechanism that starts a process is
    // not left installed and runnable behind a switch (design §11).
    expect(fs.existsSync(launcher())).toBe(false);

    // …and an install that clears the switch writes it back.
    fs.writeFileSync(path.join(ws.home, '.agstatus.json'), JSON.stringify({ focus: true, url: BOARD }));
    expect(await install(darwin({ exec: recorder().exec, log: quiet().log }))).toBe(0);
    expect(fs.existsSync(launcher())).toBe(true);
  });

  it('AGSTATUS_RESUME=off at install time travels with the agent, and the launcher is not written', async () => {
    withSettingsUrl(ws.home, BOARD);
    process.env.AGSTATUS_RESUME = 'off';
    const { log, out } = quiet();
    expect(await install(darwin({ exec: recorder().exec, log }))).toBe(0);
    // The plist is the listener's whole environment, so the switch has to be
    // in it or `status`/`doctor` would report a shell variable the running
    // listener never sees.
    expect(plistEnv(fs.readFileSync(plistPath(ws.home), 'utf8')).AGSTATUS_RESUME).toBe('off');
    expect(fs.existsSync(launcher())).toBe(false);
    expect(out()).toContain('Resume:    off (AGSTATUS_RESUME=off');
    expect(readJson(path.join(ws.home, '.agstatus.json'))).toEqual({ focus: true, url: BOARD });

    // Unset in this shell, the agent still carries it: both reports follow
    // the agent, not the shell.
    delete process.env.AGSTATUS_RESUME;
    const shown = quiet();
    await status(darwin({ exec: recorder().exec, log: shown.log }));
    expect(shown.out()).toContain("Resume:    off (AGSTATUS_RESUME=off in the LaunchAgent's environment)");
  });

  it('says so when AGSTATUS_RESUME=off is only in this shell, not in the installed agent', async () => {
    withSettingsUrl(ws.home, BOARD);
    expect(await install(darwin({ exec: recorder().exec, log: quiet().log }))).toBe(0);
    process.env.AGSTATUS_RESUME = 'off';

    const shown = quiet();
    await status(darwin({ exec: recorder().exec, log: shown.log }));
    expect(shown.out()).toContain(`Resume:    on — ${launcher()}`);
    expect(shown.out()).toContain('AGSTATUS_RESUME=off is set in this shell');
    expect(shown.out()).toContain('does not apply to the running listener');

    const checked = quiet();
    await doctor(darwin({ exec: recorder().exec, log: checked.log }));
    expect(checked.out()).toContain(`✔ ${launcher()}`);
    expect(checked.out()).toContain('AGSTATUS_RESUME=off is set in this shell');
  });

  it('refuses the feature honestly when the state directory is not the one the launcher would read', async () => {
    withSettingsUrl(ws.home, BOARD);
    const own = path.join(ws.home, 'state-of-its-own');
    process.env.AGSTATUS_STATE_DIR = own;
    const { log, out } = quiet();
    expect(await install(darwin({ exec: recorder().exec, log }))).toBe(0);

    // No launcher at all: it would be handed no environment, read the
    // default state dir, find nothing, and the board would still have been
    // told `resumed` (design §5.2 step 4).
    expect(fs.existsSync(path.join(own, 'agstatus-resume'))).toBe(false);
    expect(out()).toContain('Resume:    off — a state directory of its own cannot be resumed');
    expect(out()).toContain(ws.state);

    const shown = quiet();
    await status(darwin({ exec: recorder().exec, log: shown.log }));
    expect(shown.out()).toContain('Resume:    off — a state directory of its own cannot be resumed');

    const checked = quiet();
    expect(await doctor(darwin({ exec: recorder().exec, log: checked.log }))).toBe(1);
    expect(checked.out()).toContain('which resume cannot use');
    expect(checked.out()).toContain('Resume taps answer unsupported-host');
  });

  it('is off for one run under AGSTATUS_RESUME=off, without touching the file', async () => {
    withSettingsUrl(ws.home, BOARD);
    expect(await install(darwin({ exec: recorder().exec, log: quiet().log }))).toBe(0);
    expect(readJson(path.join(ws.home, '.agstatus.json'))).toEqual({ focus: true, url: BOARD });

    process.env.AGSTATUS_RESUME = 'off';
    const checked = quiet();
    await doctor(darwin({ exec: recorder().exec, log: checked.log }));
    expect(checked.out()).toContain('AGSTATUS_RESUME=off');
  });
});

describe('the launcher shim', () => {
  it('is what launchd runs: an absolute path we own, with the CLI and a Node *hint* inside it', async () => {
    withSettingsUrl(ws.home, BOARD);
    const { exec } = recorder();
    expect(await install(darwin({ exec, log: quiet().log }))).toBe(0);

    const text = fs.readFileSync(shim(), 'utf8');
    expect(text.split('\n')[0]).toBe('#!/bin/sh');
    expect(text).toContain(`CLI="${cliPath()}"`);
    expect(text).toContain('NODE_HINT="/usr/local/bin/node"');
    expect(fs.statSync(shim()).mode & 0o777).toBe(0o700);

    // And the plist names the shim and nothing else: the node this install ran
    // under is a hint inside a script, never a path launchd has to resolve.
    const xml = fs.readFileSync(plistPath(ws.home), 'utf8');
    expect(plistProgramArguments(xml)[0]).toBe(shim());
    expect(xml).not.toContain('/usr/local/bin/node');
    expect(xml).not.toContain('cli.js');
    // PATH stays: §5.1 resolves agtermctl, kitten, tmux and codex inside the
    // listener, and a LaunchAgent's own PATH is four system directories.
    expect(plistEnv(xml).PATH).toBe(process.env.PATH ?? '');
  });

  it('falls back to ~/.agstatus for a CLI that is not in the installed layout', async () => {
    withSettingsUrl(ws.home, BOARD);
    // A dev checkout: `cli/dist/cli.js` is nobody's prefix, so the shim goes
    // to the default one. The install still works — it just cannot promise
    // that the cli.js it points at will still be there.
    const dev = path.join(ws.home, 'src', 'claude-status', 'cli', 'dist', 'cli.js');
    const { exec } = recorder();
    const { log, out } = quiet();
    expect(await install(darwin({ exec, log, cliPath: dev }))).toBe(0);

    const fallback = path.join(ws.home, '.agstatus', 'bin', 'agstatus');
    expect(fs.existsSync(fallback)).toBe(true);
    expect(fs.readFileSync(fallback, 'utf8')).toContain(`CLI="${dev}"`);
    expect(plistProgramArguments(fs.readFileSync(plistPath(ws.home), 'utf8'))[0]).toBe(fallback);
    expect(out()).not.toContain('⚠'); // a checkout is not a rotting path, just an unmanaged one
  });

  it('follows $AGSTATUS_HOME when there is no layout to read', async () => {
    withSettingsUrl(ws.home, BOARD);
    process.env.AGSTATUS_HOME = path.join(ws.home, 'elsewhere');
    const { exec } = recorder();
    expect(await install(darwin({ exec, log: quiet().log, cliPath: path.join(ws.home, 'x', 'dist', 'cli.js') }))).toBe(0);
    expect(fs.existsSync(path.join(ws.home, 'elsewhere', 'bin', 'agstatus'))).toBe(true);
  });

  it('refuses, before writing anything at all, a CLI path it could not quote', async () => {
    withSettingsUrl(ws.home, BOARD);
    const { exec, calls } = recorder();
    const { log, out } = quiet();
    expect(await install(darwin({ exec, log, cliPath: '/opt/ag"status/lib/agstatus/dist/cli.js' }))).toBe(1);
    expect(out()).toMatch(/cannot quote/);
    expect(fs.existsSync(path.join(ws.state, 'machine.json'))).toBe(false);
    expect(fs.existsSync(path.join(ws.home, '.agstatus.json'))).toBe(false);
    expect(fs.existsSync(plistPath(ws.home))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('warns about a version-stamped prefix without refusing it, and never says `npm i -g`', async () => {
    withSettingsUrl(ws.home, BOARD);
    const cases: Array<[string, RegExp]> = [
      [path.join(ws.home, '.npm', '_npx', 'a1b2', 'node_modules', 'agstatus', 'dist', 'cli.js'), /the npx cache/],
      // The old advice was `npm i -g agstatus`, which on an nvm machine moves
      // the CLI from one version-stamped directory into another one.
      [path.join(ws.home, '.nvm', 'versions', 'node', 'v20.9.0', 'lib', 'node_modules', 'agstatus', 'dist', 'cli.js'),
        /a Node version directory \(node\/v20\.9\.0\)/],
      ['/opt/homebrew/Cellar/agstatus/1.3.0/libexec/dist/cli.js', /a Homebrew cellar \(agstatus\/1\.3\.0\)/],
    ];
    for (const [cli, why] of cases) {
      const { log, out } = quiet();
      expect(await install(darwin({ exec: recorder().exec, log, cliPath: cli }))).toBe(0);
      expect(out()).toMatch(why);
      expect(out()).toContain('curl -fsSL https://agstatus.online/install.sh | sh');
      expect(out()).not.toContain('npm i -g');
    }
  });
});

describe('doctor and the agent', () => {
  /** A healthy install: the layout on disk, the CLI present, launchd answering. */
  const healthy = async (): Promise<void> => {
    withSettingsUrl(ws.home, BOARD);
    withCliAt(cliPath());
    expect(await install(darwin({ exec: recorder().exec, log: quiet().log }))).toBe(0);
  };

  it('passes a healthy install, and never reads "listener" as the entry point', async () => {
    await healthy();
    const { log, out } = quiet();
    expect(await doctor(darwin({ exec: recorder(PRINTS_RUNNING).exec, log }))).toBe(0);

    // The regression this whole change would otherwise have caused: argv[1]
    // is the subcommand now, so reading it as a path reported a healthy
    // install as broken.
    expect(out()).not.toContain('entry point listener');
    expect(out()).toContain(`✔ launcher ${shim()} (0700, yours)`);
    expect(out()).toContain(`✔ entry point ${cliPath()}`);
    expect(out()).toContain('✔ Node /usr/local/bin/node (20.9.0)');
    expect(out()).toContain('✔ running, pid 4242');
    expect(out()).toContain('Everything looks fine.');
  });

  it('checks the program launchd would exec, not just that a plist exists', async () => {
    await healthy();

    fs.chmodSync(shim(), 0o755);
    const loose = quiet();
    expect(await doctor(darwin({ exec: recorder(PRINTS_RUNNING).exec, log: loose.log }))).toBe(1);
    expect(loose.out()).toContain(`✖ launcher ${shim()}: mode 755, expected 700`);

    fs.rmSync(shim());
    const gone = quiet();
    expect(await doctor(darwin({ exec: recorder(PRINTS_RUNNING).exec, log: gone.log }))).toBe(1);
    expect(gone.out()).toContain(`✖ launcher ${shim()}: missing`);
    // …and with no shim there is no resume either: the launcher delegates to
    // it. The resume launcher itself is untouched — still 0700, still ours —
    // so saying it is not is a claim the reader can disprove with `ls -l`.
    expect(gone.out()).toContain(`✖ ${launcher()}: its shim ${shim()} is missing`);
    expect(gone.out()).not.toContain('is not a 0700 regular file owned by you');
  });

  it('stats the entry point the prefix names, and says when it is gone', async () => {
    await healthy();
    fs.rmSync(cliPath());
    const { log, out } = quiet();
    expect(await doctor(darwin({ exec: recorder(PRINTS_RUNNING).exec, log }))).toBe(1);
    expect(out()).toContain(`✖ entry point ${cliPath()} no longer exists`);
  });

  it('explains a 127 from the launcher, and a 78 from launchd', async () => {
    await healthy();

    // 127 is the shim's own "no Node >=18" exit. A KeepAlive job that never
    // execs writes nothing to the log, so this is the only evidence there is.
    const dead = 'com.agstatus.listener = {\n\tstate = not running\n\tlast exit code = 127\n}\n';
    const noNode = quiet();
    expect(await doctor(darwin({ exec: recorder(dead).exec, log: noNode.log }))).toBe(1);
    expect(noNode.out()).toContain('✖ its last run exited 127 — the launcher found no Node >=18');
    expect(noNode.out()).toContain('AGSTATUS_NODE=/absolute/path/to/node');

    // 78 is EX_CONFIG: launchd could not exec argv[0] at all — the failure the
    // old plist produced whenever node moved, and the reason argv[0] must be
    // an absolute path we own.
    const misconfigured = 'com.agstatus.listener = {\n\tlast exit code = 78\n}\n';
    const config = quiet();
    expect(await doctor(darwin({ exec: recorder(misconfigured).exec, log: config.log }))).toBe(1);
    expect(config.out()).toContain('✖ its last run exited 78 (EX_CONFIG)');
    expect(config.out()).toContain(shim());

    // Anything else is a note, not a verdict: the log says why.
    const crashed = 'com.agstatus.listener = {\n\tpid = 4242\n\tlast exit status = 1\n}\n';
    const other = quiet();
    expect(await doctor(darwin({ exec: recorder(crashed).exec, log: other.log }))).toBe(0);
    expect(other.out()).toContain('⚠ its last run exited 1');
  });

  it('says so when launchd has never been handed the agent', async () => {
    await healthy();
    const { log, out } = quiet();
    expect(await doctor(darwin({ exec: recorder().exec, log }))).toBe(1); // print exits 113
    expect(out()).toContain('✖ launchctl has no job gui/501/com.agstatus.listener');
    expect(out()).toContain('launchctl bootstrap gui/501');
  });

  it('runs the shim\'s own resolution rather than guessing, and reports a 127 from it', async () => {
    await healthy();
    const { log, out } = quiet();
    // The probe is a copy of the shim pointed at a two-line script; the same
    // find_node(), so the answer cannot drift from what launchd will get.
    expect(await doctor(darwin({ exec: recorder(PRINTS_RUNNING, { code: 127, stdout: '' }).exec, log }))).toBe(1);
    expect(out()).toContain('✖ the launcher finds no Node >=18 on this machine');
  });

  it('survives a shim whose NODE_HINT cannot be quoted, and names that hint', async () => {
    await healthy();
    // A shim edited by hand into something renderShim refuses. doctor renders
    // a copy of it to ask which Node it would pick, so this threw straight
    // out of doctor — no report at all — and the message blamed "the cli.js
    // path", which is neither the offending path nor anything the reader has.
    fs.writeFileSync(
      shim(),
      fs.readFileSync(shim(), 'utf8').replace(/^NODE_HINT=.*$/m, 'NODE_HINT="/opt/$(id -u)/node"')
    );
    fs.chmodSync(shim(), 0o700);

    const { log, out } = quiet();
    expect(await doctor(darwin({ exec: recorder(PRINTS_RUNNING).exec, log }))).toBe(1);
    expect(out()).toContain(`the NODE_HINT in ${shim()} ("/opt/$(id -u)/node")`);
    expect(out()).not.toContain('cli.js path');
    // And the report goes on: the entry point, launchd's verdict, the footer.
    expect(out()).toContain(`✔ entry point ${cliPath()}`);
    expect(out()).toContain('✔ running, pid 4242');
    expect(out()).toContain('1 problem found.');
  });

  it('warns that the entry point sits in a version-stamped directory, from the shim it named', async () => {
    withSettingsUrl(ws.home, BOARD);
    const npx = withCliAt(path.join(ws.home, '.npm', '_npx', 'a1b2', 'node_modules', 'agstatus', 'dist', 'cli.js'));
    expect(await install(darwin({ exec: recorder().exec, log: quiet().log, cliPath: npx }))).toBe(0);

    const { log, out } = quiet();
    expect(await doctor(darwin({ exec: recorder(PRINTS_RUNNING).exec, log }))).toBe(0);
    // No layout under the fallback prefix, so doctor reads the entry point
    // back out of the shim itself — and still stats it.
    expect(out()).toContain(`✔ entry point ${npx}`);
    expect(out()).toContain('⚠ it lives in the npx cache');
    expect(out()).toContain('curl -fsSL https://agstatus.online/install.sh | sh');
  });
});

describe('a plist from before the launcher shim', () => {
  /** What 1.3.0 registered: `[<node>, <cli.js>, "listener", "run"]`, node first. */
  const legacyPlist = (node: string): void => {
    fs.writeFileSync(
      plistPath(ws.home),
      renderPlist({
        label: LAUNCH_AGENT_LABEL,
        program: node,
        args: [cliPath(), 'listener', 'run'],
        path: '/usr/local/bin:/usr/bin',
        logFile: path.join(ws.state, 'listener.log'),
      })
    );
  };

  /**
   * A stand-in for the Node such a plist named. Deliberately not a file called
   * `node`: nothing in this suite may look like a toolchain binary, and doctor
   * only ever `stat`s this path.
   */
  const oldNode = (version: string): string => path.join(ws.home, 'old-toolchain', `node-${version}`);

  it('is diagnosed as itself, on an install that is running perfectly', async () => {
    withSettingsUrl(ws.home, BOARD);
    withCliAt(cliPath());
    expect(await install(darwin({ exec: recorder().exec, log: quiet().log }))).toBe(0);
    const node = oldNode('v20.9.0');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '');
    legacyPlist(node);

    const { log, out } = quiet();
    expect(await doctor(darwin({ exec: recorder(PRINTS_RUNNING).exec, log }))).toBe(1);
    expect(out()).toContain('✖ this plist predates the launcher shim; re-run the installer to upgrade it');
    expect(out()).toContain('curl -fsSL https://agstatus.online/install.sh | sh');
    // Not one of the shim-era verdicts, every one of which would have been
    // aimed at the user's node binary on a machine with nothing wrong with it.
    expect(out()).not.toContain(`launcher ${node}`);
    expect(out()).not.toContain('no entry point');
    expect(out()).not.toContain('is already gone');
    // …and the rest of the report still prints, ending on that one problem.
    expect(out()).toContain('✔ running, pid 4242');
    expect(out()).toContain('1 problem found.');
  });

  it('says the frozen Node is gone when it is, and reads 78 and 127 in its own terms', async () => {
    withSettingsUrl(ws.home, BOARD);
    withCliAt(cliPath());
    expect(await install(darwin({ exec: recorder().exec, log: quiet().log }))).toBe(0);
    const node = oldNode('v18.20.0');
    legacyPlist(node);

    // 78 (EX_CONFIG) is what launchd reports when it cannot exec argv[0] —
    // the failure mode a frozen node path has been waiting to hit all along.
    const misconfigured = 'com.agstatus.listener = {\n\tlast exit code = 78\n}\n';
    const { log, out } = quiet();
    expect(await doctor(darwin({ exec: recorder(misconfigured).exec, log }))).toBe(1);
    expect(out()).toContain(`${node} is already gone`);
    expect(out()).toContain('✖ its last run exited 78 (EX_CONFIG)');
    expect(out()).toContain('cannot be re-pointed in place');

    // A 127 here is that node failing to run the CLI, not a shim that found
    // no Node — and AGSTATUS_NODE, which only the shim reads, would do nothing.
    const dead = 'com.agstatus.listener = {\n\tlast exit code = 127\n}\n';
    const other = quiet();
    expect(await doctor(darwin({ exec: recorder(dead).exec, log: other.log }))).toBe(1);
    expect(other.out()).toContain('✖ its last run exited 127 — the node in this plist could not run the CLI');
    expect(other.out()).not.toContain('AGSTATUS_NODE');
  });
});

describe('AGSTATUS_NODE', () => {
  it('travels into the agent, and doctor probes with the agent environment', async () => {
    withSettingsUrl(ws.home, BOARD);
    withCliAt(cliPath());
    const chosen = path.join(ws.home, 'old-toolchain', 'node-v22.0.0');
    process.env.AGSTATUS_NODE = chosen;
    const { log, out } = quiet();
    expect(await install(darwin({ exec: recorder().exec, log }))).toBe(0);
    // The plist is the listener's whole environment (design §11): the shim
    // tries $AGSTATUS_NODE first, and this is the only way it ever gets one.
    expect(plistEnv(fs.readFileSync(plistPath(ws.home), 'utf8')).AGSTATUS_NODE).toBe(chosen);
    expect(out()).toContain(`Node:      ${chosen}`);

    const r = recorder(PRINTS_RUNNING);
    const checked = quiet();
    expect(await doctor(darwin({ exec: r.exec, log: checked.log }))).toBe(0);
    expect(r.probeEnv()?.AGSTATUS_NODE).toBe(chosen);
    expect(checked.out()).not.toContain('is set in this shell');
  });

  it('is called out when only this shell has it, because launchd never will', async () => {
    withSettingsUrl(ws.home, BOARD);
    withCliAt(cliPath());
    expect(await install(darwin({ exec: recorder().exec, log: quiet().log }))).toBe(0);
    // doctor's old advice, followed to the letter: it turned the probe green
    // while launchd went on exiting 127, because the probe inherited this
    // environment and the agent never did.
    process.env.AGSTATUS_NODE = path.join(ws.home, 'old-toolchain', 'node-v22.0.0');

    const r = recorder(PRINTS_RUNNING);
    const checked = quiet();
    expect(await doctor(darwin({ exec: r.exec, log: checked.log }))).toBe(0);
    expect(r.probeEnv()?.AGSTATUS_NODE).toBeUndefined();
    expect(checked.out()).toContain("is set in this shell, but the agent's environment");
    expect(checked.out()).toContain('AGSTATUS_NODE=/absolute/path/to/node agstatus listener install');
  });
});

describe('what these commands tell people to run', () => {
  it('names the installer and a bare `agstatus`, never the retired npx channel', async () => {
    withSettingsUrl(ws.home, BOARD);
    const hook = path.join(ws.home, '.claude', 'hooks', 'agstatus-hook.js');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '// agstatus 1.3.0 — reports status, knows nothing about Focus\n');
    const { log, out } = quiet();
    // One run of each command, over the states that print advice: a stale
    // hook, a --url that disagrees, then a shim and a CLI that are gone.
    expect(await install(darwin({ exec: recorder().exec, log, url: 'https://s.example/w/ags_other' }))).toBe(0);
    await status(darwin({ exec: recorder().exec, log }));
    fs.rmSync(shim());
    expect(await doctor(darwin({ exec: recorder().exec, log }))).toBe(1);

    // npm still serves 1.3.0 forever, so an `npx agstatus init` in somebody's
    // notes keeps working — it is simply not a channel this output points
    // anybody at any more.
    expect(out()).not.toContain('npx agstatus');
    expect(out()).toContain('curl -fsSL https://agstatus.online/install.sh | sh');
    expect(out()).toContain('`agstatus init`');
    expect(out()).toContain('`agstatus listener install`');
  });
});

describe('uninstall', () => {
  it('boots the agent out, removes the plist, sets focus:false, and purges only on request', async () => {
    withSettingsUrl(ws.home, BOARD);
    const { exec, calls } = recorder();
    const { log } = quiet();
    expect(await install(darwin({ exec, log }))).toBe(0);
    fs.mkdirSync(path.join(ws.state, 'sessions', 'abc'), { recursive: true });
    fs.writeFileSync(path.join(ws.state, 'sessions', 'abc', '1.json'), '{}');
    fs.writeFileSync(path.join(ws.state, 'listener.log'), 'hello\n');
    calls.length = 0;

    expect(await uninstall(darwin({ exec, log }))).toBe(0);
    expect(calls).toEqual([['launchctl', 'bootout', 'gui/501/com.agstatus.listener']]);
    expect(fs.existsSync(plistPath(ws.home))).toBe(false);
    expect(readJson(path.join(ws.home, '.agstatus.json'))).toEqual({ focus: false, url: BOARD });
    expect(fs.existsSync(path.join(ws.state, 'sessions', 'abc', '1.json'))).toBe(true);
    expect(fs.existsSync(path.join(ws.state, 'machine.json'))).toBe(true);

    // The launcher goes with the agent, purge or no purge: nothing that can
    // start a session is left behind on a machine with no listener.
    expect(fs.existsSync(path.join(ws.state, 'agstatus-resume'))).toBe(false);

    expect(await uninstall(darwin({ exec, log, purge: true }))).toBe(0);
    expect(fs.existsSync(path.join(ws.state, 'sessions'))).toBe(false);
    expect(fs.existsSync(path.join(ws.state, 'listener.log'))).toBe(false);
    expect(fs.existsSync(path.join(ws.state, 'machine.json'))).toBe(true);
  });

  it('refuses a malformed ~/.agstatus.json before the agent comes down, and `agstatus uninstall` says so', async () => {
    withSettingsUrl(ws.home, BOARD);
    process.env.CLAUDE_CONFIG_DIR = path.join(ws.home, '.claude');
    process.env.CODEX_HOME = path.join(ws.home, '.codex');
    const { exec, calls } = recorder();
    const { log, out } = quiet();
    expect(await install(darwin({ exec, log }))).toBe(0);
    calls.length = 0;
    const file = path.join(ws.home, '.agstatus.json');
    fs.writeFileSync(file, '{oops');

    expect(await uninstall(darwin({ exec, log }))).toBe(1);
    expect(out()).toContain('not valid JSON');
    expect(out()).not.toContain('Focus listener uninstalled');
    expect(calls).toEqual([]);
    expect(fs.existsSync(plistPath(ws.home))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{oops');

    await expect(runUninstall(log, { listener: darwin({ exec }) })).rejects.toThrow(/still installed/);
    expect(calls).toEqual([]);
    expect(fs.existsSync(plistPath(ws.home))).toBe(true);

    // Once the file is fixed the same command takes everything down.
    fs.writeFileSync(file, JSON.stringify({ url: BOARD, focus: true }));
    expect(await uninstall(darwin({ exec, log }))).toBe(0);
    expect(calls).toEqual([['launchctl', 'bootout', 'gui/501/com.agstatus.listener']]);
    expect(readJson(file)).toEqual({ url: BOARD, focus: false });
  });
});

describe('listenerInstalled', () => {
  it('sees the plist, or a "focus": true left behind, and nothing else', () => {
    expect(listenerInstalled(ws.home)).toBe(false);
    writeJson(path.join(ws.home, '.agstatus.json'), { url: BOARD, focus: true });
    expect(listenerInstalled(ws.home)).toBe(true);
    writeJson(path.join(ws.home, '.agstatus.json'), { url: BOARD, focus: false });
    expect(listenerInstalled(ws.home)).toBe(false);
    fs.mkdirSync(path.dirname(plistPath(ws.home)), { recursive: true });
    fs.writeFileSync(plistPath(ws.home), '<plist/>');
    expect(listenerInstalled(ws.home)).toBe(true);
    fs.unlinkSync(plistPath(ws.home));
    fs.writeFileSync(path.join(ws.home, '.agstatus.json'), '{ not json');
    expect(listenerInstalled(ws.home)).toBe(false);
  });
});

describe('agstatus uninstall', () => {
  it('takes the listener down only when asked to and only when one is installed', async () => {
    withSettingsUrl(ws.home, BOARD);
    process.env.CLAUDE_CONFIG_DIR = path.join(ws.home, '.claude');
    process.env.CODEX_HOME = path.join(ws.home, '.codex');
    const { exec, calls } = recorder();
    const { log, out } = quiet();
    expect(await install(darwin({ exec, log }))).toBe(0);
    calls.length = 0;

    // The library default leaves the listener alone (what the e2e suites rely on).
    await runUninstall(log);
    expect(calls).toEqual([]);
    expect(fs.existsSync(plistPath(ws.home))).toBe(true);
    expect(readJson(path.join(ws.home, '.agstatus.json')).focus).toBe(true);
    expect(out()).not.toContain('Focus listener uninstalled');

    await runUninstall(log, { listener: darwin({ exec }) });
    expect(calls).toEqual([['launchctl', 'bootout', 'gui/501/com.agstatus.listener']]);
    expect(fs.existsSync(plistPath(ws.home))).toBe(false);
    expect(readJson(path.join(ws.home, '.agstatus.json'))).toEqual({ focus: false, url: BOARD });
    expect(out().match(/Focus listener uninstalled/g)).toHaveLength(1);

    // Nothing left to take down: the listener step is silent and launchctl is not run again.
    await runUninstall(log, { listener: darwin({ exec }) });
    expect(calls).toHaveLength(1);
    expect(out().match(/Focus listener uninstalled/g)).toHaveLength(1);
  });
});

describe('status', () => {
  it('reports the agent pid, the machine, the board and the log tail', async () => {
    withSettingsUrl(ws.home, BOARD);
    const { exec } = recorder(PRINTS_RUNNING);
    const { log, out } = quiet();
    expect(await install(darwin({ exec, log }))).toBe(0);
    fs.writeFileSync(path.join(ws.state, 'listener.log'), Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const s = quiet();
    expect(await status(darwin({ exec, log: s.log }))).toBe(0);
    const text = s.out();
    expect(text).toContain('pid 4242');
    expect(text).toContain(`${BOARD} (${path.join(ws.home, '.claude', 'settings.json')})`);
    const machine = readJson(path.join(ws.state, 'machine.json'));
    expect(text).toContain(publicId(machineKey(machine.machineId as string, BOARD)));
    expect(text).toContain('line 11');
    expect(text).toContain('line 2');
    expect(text).not.toContain('line 1\n');
  });

  it('strips control characters out of the log tail before it reaches the terminal', async () => {
    withSettingsUrl(ws.home, BOARD);
    const { exec } = recorder();
    const { log } = quiet();
    expect(await install(darwin({ exec, log }))).toBe(0);
    fs.writeFileSync(
      path.join(ws.state, 'listener.log'),
      'plain line\nsse: \u001b[2J\u001b]0;pwned\u0007 handler threw\rforged \u007f line\n'
    );
    const s = quiet();
    expect(await status(darwin({ exec, log: s.log }))).toBe(0);
    const text = s.out();
    expect(text).toContain('  plain line');
    expect(text).toContain('  sse: [2J]0;pwned handler threwforged  line');
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
  });
});

describe('resolveBins', () => {
  let savedPath: string | undefined;
  beforeEach(() => {
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  it('takes from PATH only a binary root or we own that nobody else can write, in a directory nobody else can write', () => {
    const bin = path.join(ws.state, 'bin');
    fs.mkdirSync(bin, { mode: 0o755 });
    const tmux = path.join(bin, 'tmux');
    fs.writeFileSync(tmux, '');
    fs.chmodSync(tmux, 0o755);
    process.env.PATH = `relative/bin:${bin}`;
    expect(resolveBins().tmux).toBe(tmux);

    fs.chmodSync(tmux, 0o775); // group-writable
    expect(resolveBins().tmux).not.toBe(tmux);
    fs.chmodSync(tmux, 0o757); // other-writable
    expect(resolveBins().tmux).not.toBe(tmux);
    fs.chmodSync(tmux, 0o644); // no execute bit
    expect(resolveBins().tmux).not.toBe(tmux);

    fs.chmodSync(tmux, 0o755);
    expect(resolveBins().tmux).toBe(tmux);
    fs.chmodSync(bin, 0o1777); // a /tmp-like directory: anyone could drop a tmux there first
    expect(resolveBins().tmux).not.toBe(tmux);
    fs.chmodSync(bin, 0o755);
    expect(resolveBins().tmux).toBe(tmux);

    fs.rmSync(tmux);
    fs.mkdirSync(tmux); // a directory of that name
    expect(resolveBins().tmux).not.toBe(tmux);
  });
});

describe('resolveBoardUrl', () => {
  it('prefers env, then settings.json, then the Codex hook prefix, then ~/.agstatus.json', () => {
    expect(resolveBoardUrl()).toBeNull();

    writeJson(path.join(ws.home, '.agstatus.json'), { url: 'https://s.example/w/file', secret: 'from-file' });
    expect(resolveBoardUrl()).toEqual({ url: 'https://s.example/w/file', source: 'file' });
    expect(resolveSecret()).toEqual({ secret: 'from-file', source: 'file' });

    withCodexUrl(ws.home, 'https://s.example/w/codex', `it'\\''s`);
    expect(resolveBoardUrl()).toEqual({ url: 'https://s.example/w/codex', source: 'codex' });
    expect(resolveSecret()).toEqual({ secret: "it's", source: 'codex' });

    withSettingsUrl(ws.home, 'https://s.example/w/settings');
    expect(resolveBoardUrl()).toEqual({ url: 'https://s.example/w/settings', source: 'settings' });
    expect(resolveSecret()).toEqual({ secret: "it's", source: 'codex' }); // settings has no secret

    process.env.CLAUDE_STATUS_URL = 'https://s.example/w/env';
    process.env.CLAUDE_STATUS_SECRET = 'from-env';
    expect(resolveBoardUrl()).toEqual({ url: 'https://s.example/w/env', source: 'env' });
    expect(resolveSecret()).toEqual({ secret: 'from-env', source: 'env' });
  });

  it('ignores hook commands that are not ours', () => {
    writeJson(path.join(ws.home, '.codex', 'hooks.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'CLAUDE_STATUS_URL="https://x.example" other-tool.sh' }] }] },
    });
    expect(resolveBoardUrl()).toBeNull();
  });

  it('refuses to guess over a malformed settings.json', () => {
    fs.mkdirSync(path.join(ws.home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ws.home, '.claude', 'settings.json'), '{nope');
    expect(() => resolveBoardUrl()).toThrow(/not valid JSON/);
  });
});

describe('mergeAgstatusJson', () => {
  it('never overwrites an existing url or secret, never drops keys, never clobbers a malformed file', () => {
    const file = path.join(ws.home, '.agstatus.json');
    mergeAgstatusJson({ focus: true, url: 'https://a.example' });
    expect(readJson(file)).toEqual({ focus: true, url: 'https://a.example' });
    mergeAgstatusJson({ focus: false, url: 'https://b.example', secret: 's', other: [1] });
    expect(readJson(file)).toEqual({ focus: false, url: 'https://a.example', secret: 's', other: [1] });
    fs.writeFileSync(file, '{oops');
    expect(() => mergeAgstatusJson({ focus: true })).toThrow(/not valid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{oops');
  });
});

describe('resolveListenerConfig', () => {
  it('assembles the credential, the public id, the paths and the tools', () => {
    withSettingsUrl(ws.home, `${BOARD}/`);
    writeMachine(ws.state, { machineId: MACHINE_ID, name: 'Studio' });
    const cfg = resolveListenerConfig();
    if ('error' in cfg) throw new Error(cfg.error);
    expect(cfg.url).toBe(`${BOARD}/`);
    expect(cfg.base).toBe(BOARD);
    expect(cfg.machineId).toBe(MACHINE_ID);
    expect(cfg.machineKey).toBe(EXPECTED_KEY);
    expect(cfg.machinePublicId).toBe(EXPECTED_PUBLIC_ID);
    expect(cfg.name).toBe('Studio');
    expect(cfg.secret).toBeUndefined();
    expect(cfg.stateDir).toBe(ws.state);
    expect(cfg.logFile).toBe(path.join(ws.state, 'listener.log'));
    expect(cfg.lockFile).toBe(path.join(ws.state, 'listener.lock'));
    for (const p of Object.values(cfg.bins)) expect(path.isAbsolute(p)).toBe(true);
  });

  it('names what is missing instead of guessing', () => {
    expect(resolveListenerConfig()).toEqual({ error: expect.stringMatching(/No board URL/) });
    withSettingsUrl(ws.home, BOARD);
    expect(resolveListenerConfig()).toEqual({ error: expect.stringMatching(/machine\.json/) });
    writeMachine(ws.state, { machineId: MACHINE_ID });
    expect(resolveListenerConfig({ url: 'not a url' })).toEqual({ error: expect.stringMatching(/http\(s\)/) });
    expect(resolveListenerConfig({ url: 'https://s.example/w/x"; rm -rf /' })).toEqual({
      error: expect.stringMatching(/http\(s\)/),
    });
  });
});
