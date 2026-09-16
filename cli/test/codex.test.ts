import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createApp } from '../../src/app';
import { runInit, runStatus, runUninstall } from '../src/index';
import {
  CODEX_EVENTS,
  codexConfigPath,
  codexHookCommand,
  codexHookConfig,
  codexHookInstallPath,
  codexHooksPath,
  codexLegacyRegistration,
  mergeCodexHooks,
  readCodexHookConfig,
  readCodexHooks,
  redactCodexCredentials,
  removeCodexHooks,
  writeCodexHookConfig,
} from '../src/codex';
import { resolveBoardUrl, resolveSecret } from '../src/listener/config';

const CMD = 'node "$HOME/.codex/hooks/agstatus-hook.js"';

/** What an install made before the sidecar wrote into hooks.json. */
const LEGACY_CMD = (url: string, secret?: string): string =>
  `CLAUDE_STATUS_URL="${url}" AGSTATUS_SOURCE=codex` +
  `${secret ? ` CLAUDE_STATUS_SECRET='${secret}'` : ''} node "$HOME/.codex/hooks/agstatus-hook.js"`;

const withCommands = (...commands: string[]): Record<string, unknown> => ({
  hooks: { Stop: commands.map((command) => ({ hooks: [{ type: 'command', command }] })) },
});

describe('mergeCodexHooks', () => {
  it('registers all four events with matchers, timeout, and statusMessage', () => {
    const out = mergeCodexHooks({}, CMD);
    const hooks = out.hooks as Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
    for (const { event, matcher } of CODEX_EVENTS) {
      expect(hooks[event]).toHaveLength(1);
      const h = hooks[event][0].hooks[0];
      expect(h.command).toContain('agstatus-hook');
      expect(h.type).toBe('command');
      expect(h.timeout).toBe(10);
      if (matcher) expect(hooks[event][0].matcher).toBe(matcher);
    }
    expect(hooks.PreToolUse[0].matcher).toBe('^(Bash|apply_patch|Edit|Write)$');
  });

  it('is idempotent and preserves foreign entries', () => {
    const input = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'other-tool.sh' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }],
      },
    };
    const twice = mergeCodexHooks(mergeCodexHooks(input, CMD), CMD);
    const hooks = twice.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.Stop[0].hooks[0].command).toBe('other-tool.sh');
    expect(hooks.PostToolUse).toHaveLength(1);
    for (const { event } of CODEX_EVENTS) {
      const ours = hooks[event].filter((e) => e.hooks[0].command.includes('agstatus-hook'));
      expect(ours).toHaveLength(1);
    }
  });

  it('rejects malformed shapes without mutating', () => {
    expect(() => mergeCodexHooks({ hooks: [] }, CMD)).toThrow(/"hooks".*array/);
    expect(() => mergeCodexHooks({ hooks: { Stop: 'oops' } }, CMD)).toThrow(/"hooks\.Stop"/);
  });

  it('removeCodexHooks strips only ours and prunes empties', () => {
    const merged = mergeCodexHooks(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep.sh' }] }] } },
      CMD
    );
    const { hooks: cleaned, removed } = removeCodexHooks(merged);
    const hooks = cleaned.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.Stop[0].hooks[0].command).toBe('keep.sh');
    expect(hooks).not.toHaveProperty('SessionStart');
    expect(removed).toContain('hooks.SessionStart');
    expect(removeCodexHooks(mergeCodexHooks({}, CMD)).hooks).toEqual({});
  });
});

describe('redactCodexCredentials', () => {
  it('strips the board token and the secret from our commands only', () => {
    const ours = LEGACY_CMD('https://s.example/w/ags_tok', `it'\\''s`);
    // Someone else's command, styled to look like ours. Not ours to rewrite:
    // a backup exists to give foreign entries back, byte for byte.
    const foreign = 'CLAUDE_STATUS_URL="https://s.example/w/theirs" other-tool.sh';
    const out = redactCodexCredentials({ ...withCommands(ours, foreign), model: 'gpt-5' });
    const stop = (out.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).Stop;

    expect(stop[0].hooks[0].command).not.toContain('ags_tok');
    expect(stop[0].hooks[0].command).toContain('CLAUDE_STATUS_URL="<redacted by agstatus>"');
    expect(stop[0].hooks[0].command).toContain('CLAUDE_STATUS_SECRET="<redacted by agstatus>"');
    // Everything that is not a credential stays, so a restored file still
    // reads as ours and still says what it used to do.
    expect(stop[0].hooks[0].command).toContain('AGSTATUS_SOURCE=codex');
    expect(stop[0].hooks[0].command).toContain(CMD);
    expect(stop[1].hooks[0].command).toBe(foreign);
    expect(out.model).toBe('gpt-5'); // and nothing else in the file is touched
  });
});

describe('codexLegacyRegistration', () => {
  it('reads the registration, not the sidecar beside it', () => {
    expect(codexLegacyRegistration(withCommands(LEGACY_CMD('https://s.example/w/x')))).toBe(true);
    expect(codexLegacyRegistration(withCommands(CMD))).toBe(false);
    expect(codexLegacyRegistration({})).toBe(false);
    // Someone else's env prefix is not our legacy registration.
    expect(codexLegacyRegistration(withCommands('AGSTATUS_SOURCE=codex other-tool.sh'))).toBe(false);
  });
});

describe('codexHookCommand', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-codexcmd-'));
    prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('carries no configuration at all — just the interpreter and the script', () => {
    const cmd = codexHookCommand();
    expect(cmd).toBe(`node "${path.join(dir, 'hooks', 'agstatus-hook.js')}"`);
    // The Windows blocker: an env-var prefix is a POSIX shell construct with
    // no cmd.exe equivalent, so the whole line would fail to parse there and
    // the registered hook would silently never fire.
    expect(cmd).not.toContain('CLAUDE_STATUS_URL');
    expect(cmd).not.toContain('AGSTATUS_SOURCE');
    expect(cmd).not.toContain('AGSTATUS_DETAIL');
    expect(cmd).not.toContain('CLAUDE_STATUS_SECRET');
    expect(cmd).not.toContain('=');
    // Still recognisable as ours, or merge and uninstall would not find it.
    expect(cmd).toContain('agstatus-hook');
  });
});

describe('codexHookConfig', () => {
  it('carries the board URL, the source tag, and honors minimal', () => {
    expect(codexHookConfig('https://h.example/w/ags_t', true)).toEqual({
      url: 'https://h.example/w/ags_t',
      source: 'codex',
      detail: 'off',
    });
    // source is always present: ~/.agstatus.json is shared by both agents, so
    // the sidecar is the only thing that can tag these sessions as Codex ones.
    expect(codexHookConfig('https://h.example', false)).toEqual({
      url: 'https://h.example',
      source: 'codex',
    });
  });

  it('carries a secret only when provided, verbatim — no quoting to get wrong', () => {
    expect(codexHookConfig('https://h.example', false)).not.toHaveProperty('secret');
    // The value that needed '\'' escaping in the old shell form now just
    // round-trips through JSON.
    expect(codexHookConfig('https://h.example', false, "s3cr'et").secret).toBe("s3cr'et");
  });

  it('refuses a URL carrying shell metacharacters (defense in depth)', () => {
    // The command string no longer meets a shell, but the listener's
    // BOARD_URL_RE refuses the same set and reads this file back, so the two
    // must stay in step.
    expect(() => codexHookConfig('https://h.example/"; rm -rf ~; "', false)).toThrow(
      /shell metacharacters/
    );
    expect(() => codexHookConfig('https://h.example/$(reboot)', false)).toThrow(
      /shell metacharacters/
    );
    expect(() => codexHookConfig('https://h.example/`id`', false)).toThrow(/shell metacharacters/);
  });
});

describe('the sidecar config file', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-sidecar-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips through a 0600 file, creating the hooks dir', () => {
    const file = path.join(dir, 'hooks', 'agstatus-hook.json');
    writeCodexHookConfig(file, codexHookConfig('https://h.example/w/ags_t', true, 's3'));
    // It holds a webhook secret, and the board URL is itself a capability
    // token — nobody else on the machine gets to read it.
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readCodexHookConfig(file)).toEqual({
      url: 'https://h.example/w/ags_t',
      source: 'codex',
      secret: 's3',
      detail: 'off',
    });
    // No temp file left behind next to it.
    expect(fs.readdirSync(path.dirname(file))).toEqual(['agstatus-hook.json']);
  });

  it('replaces a previous config instead of merging into it', () => {
    const file = path.join(dir, 'agstatus-hook.json');
    writeCodexHookConfig(file, codexHookConfig('https://old.example', true, 's3'));
    writeCodexHookConfig(file, codexHookConfig('https://new.example', false));
    expect(readCodexHookConfig(file)).toEqual({ url: 'https://new.example', source: 'codex' });
  });

  it('reads back null rather than throwing on anything unusable', () => {
    const file = path.join(dir, 'agstatus-hook.json');
    expect(readCodexHookConfig(file)).toBeNull(); // missing
    fs.writeFileSync(file, '{ nope');
    expect(readCodexHookConfig(file)).toBeNull(); // malformed
    fs.writeFileSync(file, '[1,2]');
    expect(readCodexHookConfig(file)).toBeNull(); // not an object
    fs.writeFileSync(file, '{"source":"codex"}');
    expect(readCodexHookConfig(file)).toBeNull(); // no url: nothing to configure
    fs.writeFileSync(file, '{"url":"  ","secret":"s"}');
    expect(readCodexHookConfig(file)).toBeNull(); // blank url
  });

  it('ignores a detail value that is not the off switch', () => {
    const file = path.join(dir, 'agstatus-hook.json');
    fs.writeFileSync(file, '{"url":"https://h.example","detail":"on"}');
    expect(readCodexHookConfig(file)).toEqual({ url: 'https://h.example', source: 'codex' });
  });
});

describe('init/uninstall with a detected Codex install', () => {
  const created = createApp({
    multiTenant: true, webhookSecret: '', publicUrl: 'http://x.example',
    sessionTtlMs: 0, databaseUrl: '', trustProxy: false, rateLimit: false,
    maxWorkspaces: 10_000, commandTtlMs: 120_000, version: 'codex-e2e', apns: null,
  });
  let server: Server;
  let base: string;
  let claudeDir: string;
  let codexDir: string;
  let prevClaude: string | undefined;
  let prevCodex: string | undefined;
  const log = (): void => {};

  beforeAll(async () => {
    server = created.app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    created.shutdown();
  });

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-claude-'));
    codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-codex-'));
    prevClaude = process.env.CLAUDE_CONFIG_DIR;
    prevCodex = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.CODEX_HOME = codexDir;
  });

  afterEach(() => {
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
  });

  it('auto-configures Codex, and the hook maps Codex events to statuses', async () => {
    // The hook runs as a subprocess; in some sandboxes a subprocess cannot
    // reach a port owned by the vitest worker, so this test spawns the real
    // compiled server as a sibling process (same pattern as e2e.test.ts).
    const root = path.resolve(__dirname, '..', '..');
    const serverJs = path.join(root, 'dist', 'server.js');
    if (!fs.existsSync(serverJs)) {
      throw new Error('dist/server.js missing — run `npm run build` at the repo root first');
    }
    const port = 3900 + Math.floor(Math.random() * 500);
    const child = spawn(process.execPath, [serverJs], {
      env: {
        ...process.env,
        PORT: String(port),
        MULTI_TENANT: 'true',
        PUBLIC_URL: `http://127.0.0.1:${port}`,
        DB_PATH: '',
        SESSION_TTL_MS: '0',
      },
      stdio: 'ignore',
    });
    const childBase = `http://127.0.0.1:${port}`;
    try {
      const deadline = Date.now() + 8000;
      for (;;) {
        try {
          if ((await fetch(`${childBase}/healthz`)).ok) break;
        } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error('sibling server did not start');
        await new Promise((r) => setTimeout(r, 150));
      }

      await runInit({ url: childBase, noQr: true, log });

      // hooks.json written with our entries; hook script installed.
      const hooks = readCodexHooks(codexHooksPath());
      expect(JSON.stringify(hooks)).toContain('agstatus-hook');
      const hookFile = codexHookInstallPath();
      expect(fs.existsSync(hookFile)).toBe(true);

      // The registered command carries nothing but the script (the shape
      // Windows can run); the board URL lives in the sidecar beside it.
      const cmd = (hooks.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
        .SessionStart[0].hooks[0].command;
      expect(cmd).not.toContain('CLAUDE_STATUS_URL');
      const config = readCodexHookConfig(codexConfigPath());
      const url = config?.url ?? '';
      expect(url).toMatch(new RegExp(`^${childBase}/w/ags_`));
      // Codex sessions must be tagged so dashboards can scope limit bars.
      expect(config?.source).toBe('codex');
      expect(fs.statSync(codexConfigPath()).mode & 0o777).toBe(0o600);

      // Drive the REAL hook with Codex-shaped payloads — and with an empty
      // environment, exactly as Codex invokes the bare `node "<script>"` it
      // now registers. Everything the hook needs must come from the sidecar;
      // this is the Windows delivery path, exercised here on POSIX because
      // the shape is the same on every platform.
      const fire = (payload: Record<string, unknown>, extraEnv: Record<string, string> = {}): string => {
        const clean: Record<string, string | undefined> = { ...process.env };
        for (const key of ['CLAUDE_STATUS_URL', 'CLAUDE_STATUS_SECRET', 'AGSTATUS_SOURCE', 'AGSTATUS_DETAIL']) {
          delete clean[key];
        }
        return execFileSync(process.execPath, [hookFile], {
          input: JSON.stringify(payload),
          // AGSTATUS_USAGE=off: the usage path would read the developer's real
          // Claude credentials and call Anthropic — never from a test.
          env: {
            ...clean,
            AGSTATUS_USAGE: 'off',
            // Keep the Focus record out of the developer's own state directory.
            AGSTATUS_STATE_DIR: codexDir,
            ...extraEnv,
          },
          timeout: 8000,
        }).toString();
      };
      const sessionsAt = async (id: string) => {
        const all = (await (await fetch(`${url}/api/sessions`)).json()) as Array<{
          id: string; status: string; message: string; source: string;
        }>;
        return all.find((s) => s.id === id)!;
      };

      fire({ hook_event_name: 'SessionStart', session_id: 'codex-1', cwd: '/tmp/codex-proj' });
      fire({
        hook_event_name: 'PreToolUse', session_id: 'codex-1', cwd: '/tmp/codex-proj',
        tool_name: 'apply_patch', tool_input: {},
      });
      let s = await sessionsAt('codex-1');
      expect(s.status).toBe('coding');
      expect(s.message).toBe('Editing files');
      // Proof the sidecar alone did all of it: the board URL it posted to and
      // the source tag both came out of agstatus-hook.json, with no env var
      // and no shell in sight.
      expect(s.source).toBe('codex');

      // Codex exec tools deliver the command as an argv array — the test
      // detector must still classify `npm test` as testing (not empty → coding).
      fire({
        hook_event_name: 'PreToolUse', session_id: 'codex-1', cwd: '/tmp/codex-proj',
        tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'npm test'] },
      });
      s = await sessionsAt('codex-1');
      expect(s.status).toBe('testing');

      // PermissionRequest text may quote the command; --minimal must suppress it.
      fire(
        {
          hook_event_name: 'PermissionRequest', session_id: 'codex-1', cwd: '/tmp/codex-proj',
          message: 'Codex wants to run rm -rf ./dist',
        },
        { AGSTATUS_DETAIL: 'off' }
      );
      s = await sessionsAt('codex-1');
      expect(s.status).toBe('blocked');
      expect(s.message).toBe('Needs approval');
      expect(s.message).not.toContain('rm -rf');

      // Without --minimal the full prompt text comes through.
      fire({
        hook_event_name: 'PermissionRequest', session_id: 'codex-1', cwd: '/tmp/codex-proj',
        message: 'Codex wants to run rm -rf ./dist',
      });
      s = await sessionsAt('codex-1');
      expect(s.message).toBe('Codex wants to run rm -rf ./dist');

      // Hook must stay silent on stdout — Codex interprets output as decisions.
      const out = fire({ hook_event_name: 'Stop', session_id: 'codex-1', cwd: '/x' });
      expect(out).toBe('');
    } finally {
      child.kill();
    }
  });

  it('respects --no-codex and force-configures with --codex when undetected', async () => {
    await runInit({ url: base, noQr: true, codex: false, log });
    expect(fs.existsSync(codexHooksPath())).toBe(false);

    fs.rmSync(codexDir, { recursive: true, force: true }); // undetected now
    await runInit({ url: base, noQr: true, codex: true, log });
    expect(fs.existsSync(codexHooksPath())).toBe(true);
  });

  it('uninstall cleans the Codex side and preserves foreign hooks', async () => {
    fs.writeFileSync(
      codexHooksPath(),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep.sh' }] }] } })
    );
    await runInit({ url: base, noQr: true, log });
    await runUninstall(log);

    const hooks = readCodexHooks(codexHooksPath());
    expect(JSON.stringify(hooks)).not.toContain('agstatus-hook');
    expect(JSON.stringify(hooks)).toContain('keep.sh');
    expect(fs.existsSync(codexHookInstallPath())).toBe(false);
    // The sidecar goes with the script it configures — it holds a board URL.
    expect(fs.existsSync(codexConfigPath())).toBe(false);
  });

  it('re-running init rewrites the sidecar in place instead of stacking hooks', async () => {
    await runInit({ url: base, noQr: true, log });
    const first = readCodexHookConfig(codexConfigPath());
    await runInit({ url: base, noQr: true, minimal: true, log });
    const second = readCodexHookConfig(codexConfigPath());
    expect(second?.url).not.toBe(first?.url); // a fresh board each time
    expect(second?.detail).toBe('off'); // --minimal now in effect
    const hooks = readCodexHooks(codexHooksPath()) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    for (const { event } of CODEX_EVENTS) {
      expect(hooks.hooks[event].filter((e) => e.hooks[0].command.includes('agstatus-hook'))).toHaveLength(1);
    }
  });

  it('warns but still finishes Claude setup when hooks.json is malformed, leaving it untouched', async () => {
    fs.writeFileSync(codexHooksPath(), '{ nope');
    const lines: string[] = [];
    // A broken ~/.codex/hooks.json must not abort the Claude Code setup.
    await expect(runInit({ url: base, noQr: true, log: (l) => lines.push(l) })).resolves.toBeUndefined();

    // Claude side succeeded; Codex file untouched and its hook script not written.
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true);
    expect(fs.readFileSync(codexHooksPath(), 'utf8')).toBe('{ nope');
    expect(fs.existsSync(codexHookInstallPath())).toBe(false);
    expect(fs.existsSync(codexConfigPath())).toBe(false);
    expect(lines.join('\n')).toMatch(/Skipped Codex setup/);
  });

  it('status flags a registration left over from the env-prefix era', async () => {
    // What an install made before this change looks like on disk: our hook
    // script and our command, but no sidecar. It still runs on POSIX, so
    // nothing else in `status` would ever hint that Windows cannot run it.
    const legacy =
      'CLAUDE_STATUS_URL="https://s.example/w/ags_x" AGSTATUS_SOURCE=codex' +
      ' node "$HOME/.codex/hooks/agstatus-hook.js"';
    fs.mkdirSync(path.dirname(codexHookInstallPath()), { recursive: true });
    fs.writeFileSync(codexHookInstallPath(), '// hook');
    fs.writeFileSync(
      codexHooksPath(),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: legacy }] }] } })
    );
    const lines: string[] = [];
    await runStatus((l) => lines.push(l));
    expect(lines.join('\n')).toMatch(/older env-prefix command/);

    // And it is quiet once init has written the sidecar.
    await runInit({ url: base, noQr: true, log });
    const after: string[] = [];
    await runStatus((l) => after.push(l));
    expect(after.join('\n')).toContain('Codex:     configured');
    expect(after.join('\n')).not.toMatch(/older env-prefix command/);
  });

  it('keeps flagging a legacy registration when only the sidecar write landed', async () => {
    // setupCodex writes the sidecar, then rewrites hooks.json. When that
    // second write throws — EACCES, a read-only ~/.codex, a full disk — init
    // logs a warning and finishes, leaving exactly this pair on disk: a
    // sidecar beside the env-prefix registration Windows cannot run and the
    // current hook does not read. Inferring "legacy" from a missing sidecar
    // would make `status` permanently silent about the one state it is for.
    fs.mkdirSync(path.dirname(codexHookInstallPath()), { recursive: true });
    fs.writeFileSync(codexHookInstallPath(), '// hook');
    fs.writeFileSync(
      codexHooksPath(),
      JSON.stringify(withCommands(LEGACY_CMD('https://s.example/w/ags_x')))
    );
    writeCodexHookConfig(codexConfigPath(), codexHookConfig('https://s.example/w/ags_x', false));

    const lines: string[] = [];
    await runStatus((l) => lines.push(l));
    expect(lines.join('\n')).toContain('Codex:     configured');
    expect(lines.join('\n')).toMatch(/older env-prefix command/);
  });

  it('leaves no readable copy of the old board token in the backup', async () => {
    // The upgrade path: the file backed up here is the OLD hooks.json, the one
    // carrying the capability token and the secret on every command. Nothing
    // ever deletes a backup, so a verbatim copy would outlive the file init
    // just cleaned and defeat the whole point of the 0600 sidecar.
    const token = 'https://s.example/w/ags_oldtoken';
    fs.writeFileSync(
      codexHooksPath(),
      JSON.stringify(withCommands(LEGACY_CMD(token, 'sup3rs3cret'), 'keep.sh'))
    );
    fs.chmodSync(codexHooksPath(), 0o644); // as Codex leaves it, whatever the umask
    await runInit({ url: base, noQr: true, log });

    const backup = `${codexHooksPath()}.agstatus-backup`;
    expect(fs.existsSync(backup)).toBe(true);
    const text = fs.readFileSync(backup, 'utf8');
    expect(text).not.toContain('ags_oldtoken');
    expect(text).not.toContain('sup3rs3cret');
    // Still a restorable hooks.json, and still carrying the foreign entry that
    // is the only reason to keep a backup at all.
    expect(JSON.parse(text)).toHaveProperty('hooks');
    expect(text).toContain('keep.sh');
    // The live file keeps the mode Codex's own file had; the backup is ours,
    // and it is the copy that outlives the upgrade — nobody else may read it.
    expect(fs.statSync(codexHooksPath()).mode & 0o044).not.toBe(0);
    expect(fs.statSync(backup).mode & 0o077).toBe(0);
    // And a second init overwrites it without inheriting the old mode.
    fs.chmodSync(backup, 0o644);
    await runInit({ url: base, noQr: true, log });
    expect(fs.statSync(backup).mode & 0o077).toBe(0);
    expect(fs.readFileSync(codexHooksPath(), 'utf8')).not.toContain('ags_oldtoken');
  });

  it('prints the sidecar path and the re-run-/hooks warning', async () => {
    const lines: string[] = [];
    await runInit({ url: base, noQr: true, log: (l) => lines.push(l) });
    const out = lines.join('\n');
    expect(out).toContain(codexConfigPath());
    // Codex trusts a hook by hashing its command string, and this release
    // changed that string: without re-running /hooks an upgraded install is
    // silently dead, so the warning has to say why, not just what.
    expect(out).toMatch(/run \/hooks inside Codex/);
    expect(out).toMatch(/changed/);
  });
});

/**
 * The sidecar says what our Codex hook posts to; hooks.json says whether Codex
 * runs it at all. The listener needs both, because this source outranks
 * ~/.agstatus.json — a sidecar taken on its own aims the listener's stream at
 * a board nothing posts to any more.
 */
describe('a leftover sidecar is not a registration', () => {
  const KEYS = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_STATUS_URL', 'CLAUDE_STATUS_SECRET'];
  const saved: Record<string, string | undefined> = {};
  let home: string;

  const stale = (secret?: string): void =>
    writeCodexHookConfig(codexConfigPath(), codexHookConfig('https://s.example/w/stale', false, secret));
  const register = (command: string): void => {
    fs.mkdirSync(path.dirname(codexHooksPath()), { recursive: true });
    fs.writeFileSync(codexHooksPath(), JSON.stringify(withCommands(command)));
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-codexreg-'));
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // HOME too: resolveBoardUrl() reads ~/.agstatus.json, and no test may go
    // anywhere near the developer's own.
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
    process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is ignored until hooks.json actually registers our hook', () => {
    // `agstatus uninstall` leaves both files behind when it cannot clean
    // hooks.json (cli/src/index.ts), and an init whose hooks.json write failed
    // wrote the sidecar first — both end here.
    stale('stale-secret');
    expect(resolveBoardUrl()).toBeNull();
    expect(resolveSecret()).toBeNull();

    register(CMD);
    expect(resolveBoardUrl()).toEqual({ url: 'https://s.example/w/stale', source: 'codex' });
    expect(resolveSecret()).toEqual({ secret: 'stale-secret', source: 'codex' });

    // A hand-edited hooks.json that drops our entry and keeps its own.
    register('other-tool.sh');
    expect(resolveBoardUrl()).toBeNull();
    expect(resolveSecret()).toBeNull();
  });

  it('falls through to ~/.agstatus.json, which it outranks, rather than winning with a stale URL', () => {
    fs.writeFileSync(path.join(home, '.agstatus.json'), JSON.stringify({ url: 'https://s.example/w/file' }));
    stale();
    expect(resolveBoardUrl()).toEqual({ url: 'https://s.example/w/file', source: 'file' });
    register(CMD);
    expect(resolveBoardUrl()).toEqual({ url: 'https://s.example/w/stale', source: 'codex' });
  });

  it('treats a hooks.json it cannot parse as no registration, without failing the resolution', () => {
    // Codex cannot load hooks from a file it cannot parse either, so nothing
    // of ours is running — and this third-party file must not take down a
    // resolution ~/.agstatus.json can still satisfy.
    stale();
    fs.writeFileSync(codexHooksPath(), '{ nope');
    fs.writeFileSync(path.join(home, '.agstatus.json'), JSON.stringify({ url: 'https://s.example/w/file' }));
    expect(resolveBoardUrl()).toEqual({ url: 'https://s.example/w/file', source: 'file' });
  });

  it('still reads a pre-sidecar install straight off the command string', () => {
    register(LEGACY_CMD('https://s.example/w/legacy', "it'\\''s"));
    expect(resolveBoardUrl()).toEqual({ url: 'https://s.example/w/legacy', source: 'codex' });
    expect(resolveSecret()).toEqual({ secret: "it's", source: 'codex' });
  });
});

describe('board token validation (shell-injection guard)', () => {
  it('refuses a server-supplied token bearing shell metacharacters', async () => {
    // Stand up a hostile server that answers /api/config as multi-tenant but
    // hands back a booby-trapped token from /api/workspaces.
    const evil = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/config') {
        res.end(JSON.stringify({ mode: 'multi', version: 'evil' }));
      } else if (req.url === '/api/workspaces') {
        res.statusCode = 201;
        res.end(JSON.stringify({ token: 'ags_x"; rm -rf ~; echo "' }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((r) => evil.listen(0, r));
    const port = (evil.address() as AddressInfo).port;
    try {
      await expect(
        runInit({ url: `http://127.0.0.1:${port}`, noQr: true, log: () => {} })
      ).rejects.toThrow(/malformed board token/);
    } finally {
      await new Promise((r) => evil.close(r));
    }
  });
});
