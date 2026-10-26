import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  baseLaunch,
  chatAppDefs,
  connectChatApp,
  detectChatApps,
  disconnectChatApp,
  findCli,
  followDesktopApp,
  huskLaunch,
  keepingTheirs,
  sameLaunch,
  shellSafe,
  shimTarget,
} from './chat-apps.js';
import { HUSK_RANGE } from './identity.js';

let home = '';
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

function fresh(): string {
  home = mkdtempSync(join(tmpdir(), 'husk-apps-'));
  return home;
}
const fileOf = (id: string) => (chatAppDefs(home).find((d) => d.id === id) as { file: string }).file;
const dirOf = (id: string) => chatAppDefs(home).find((d) => d.id === id)!.dir;

describe('chat apps', () => {
  it('builds the launch line from the computer choice', () => {
    expect(huskLaunch()).toEqual({ command: 'npx', args: ['-y', `@husk-ai/mcp@${HUSK_RANGE}`] });
    expect(huskLaunch({ provider: 'docker', flavor: 'full' }).args).toEqual(['-y', `@husk-ai/mcp@${HUSK_RANGE}`, '--provider', 'docker', '--flavor', 'full']);
    expect(huskLaunch({ provider: 'auto' }).args).toEqual(['-y', `@husk-ai/mcp@${HUSK_RANGE}`]);
  });

  it('finds an app by its folder, and never looks outside the home it was given', () => {
    fresh();
    mkdirSync(dirOf('cursor'), { recursive: true });
    const apps = detectChatApps(home);
    expect(apps.find((a) => a.id === 'cursor')).toMatchObject({ found: true, connected: false });
    expect(apps.find((a) => a.id === 'windsurf')?.found).toBe(false);
    // Every file it would edit sits under the home it was given.
    for (const def of chatAppDefs(home)) expect(def.dir.startsWith(home)).toBe(true);
  });

  it('adds itself to a JSON config, keeps the other servers, and backs the file up', async () => {
    fresh();
    const file = fileOf('claude-desktop');
    mkdirSync(dirOf('claude-desktop'), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
    const r = await connectChatApp('claude-desktop', huskLaunch({ provider: 'docker' }), { home });
    expect(r.ok).toBe(true);
    expect(r.backup && existsSync(r.backup)).toBe(true);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after).toEqual({
      mcpServers: { other: { command: 'x' }, husk: { command: 'npx', args: ['-y', `@husk-ai/mcp@${HUSK_RANGE}`, '--provider', 'docker'] } },
      theme: 'dark',
    });
    expect(detectChatApps(home).find((a) => a.id === 'claude-desktop')?.connected).toBe(true);
  });

  it('writes VS Code its own shape', async () => {
    fresh();
    mkdirSync(dirOf('vscode'), { recursive: true });
    await connectChatApp('vscode', huskLaunch(), { home });
    expect(JSON.parse(readFileSync(fileOf('vscode'), 'utf8'))).toEqual({ servers: { husk: { type: 'stdio', command: 'npx', args: ['-y', `@husk-ai/mcp@${HUSK_RANGE}`] } } });
  });

  it('refuses to edit a file it cannot parse, and leaves it exactly as it was', async () => {
    fresh();
    mkdirSync(dirOf('cursor'), { recursive: true });
    const text = '{ // a comment\n "mcpServers": {} }';
    writeFileSync(fileOf('cursor'), text);
    const r = await connectChatApp('cursor', huskLaunch(), { home });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not plain JSON');
    expect(readFileSync(fileOf('cursor'), 'utf8')).toBe(text);
    expect(readdirSync(dirOf('cursor'))).toEqual(['mcp.json']);
  });

  it('removes only itself', async () => {
    fresh();
    mkdirSync(dirOf('gemini'), { recursive: true });
    writeFileSync(fileOf('gemini'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    await connectChatApp('gemini', huskLaunch(), { home });
    expect((await disconnectChatApp('gemini', { home })).ok).toBe(true);
    expect(JSON.parse(readFileSync(fileOf('gemini'), 'utf8'))).toEqual({ mcpServers: { other: { command: 'x' } } });
  });
});

describe("the person's own CLI, to run a bot on", () => {
  // npm's shims, as npm writes them: a native binary, and a script with node.exe named first.
  const claudeShim = '@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  const codexShim =
    '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';

  it('starts what an npm shim names, so no cmd.exe stands between Husk and the prompt', () => {
    expect(shimTarget(claudeShim)).toBe('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
    expect(shimTarget(codexShim)).toBe('node_modules\\@openai\\codex\\bin\\codex.js');
    expect(shimTarget('"%dp0%\\..\\..\\evil.exe" %*')).toBeUndefined();
    expect(shimTarget('@ECHO off')).toBeUndefined();
  });

  it('runs a script under this Node, and anything else as it is', () => {
    const dir = fresh();
    writeFileSync(join(dir, 'claude.mjs'), '');
    expect(findCli('claude-code', { HUSK_CLAUDE_CLI: join(dir, 'claude.mjs') })).toMatchObject({ command: process.execPath, args: [join(dir, 'claude.mjs')] });
    writeFileSync(join(dir, 'codex'), '');
    expect(findCli('codex', { HUSK_CODEX_CLI: join(dir, 'codex') })).toEqual({ command: join(dir, 'codex'), args: [] });
    expect(findCli('codex', { HUSK_CODEX_CLI: join(dir, 'missing') })).toBeUndefined();
  });

  it('finds Claude Code where its own installer puts it', () => {
    const dir = fresh();
    const bin = join(dir, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    mkdirSync(join(dir, '.local', 'bin'), { recursive: true });
    writeFileSync(bin, '');
    const saved = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(findCli('claude-code', {}, dir)).toEqual({ command: bin, args: [] });
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('the launch line', () => {
  it('uses the desktop app’s own Husk when HUSK_LAUNCH names it, env included', () => {
    const env = { HUSK_LAUNCH: JSON.stringify({ command: 'C:/Program Files/Husk/Husk.exe', args: ['C:/Program Files/Husk/resources/runtime/bin.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }) };
    const l = huskLaunch({ provider: 'docker' }, baseLaunch(env as NodeJS.ProcessEnv));
    expect(l).toEqual({
      command: 'C:/Program Files/Husk/Husk.exe',
      args: ['C:/Program Files/Husk/resources/runtime/bin.js', '--provider', 'docker'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('keeps chat apps on the desktop app when a chat, not the app, started this Husk', () => {
    const self = { electron: '44.6.0', execPath: 'C:/Program Files/Husk/Husk.exe', script: 'C:/Program Files/Husk/resources/runtime/bin.js' };
    expect(baseLaunch({ ELECTRON_RUN_AS_NODE: '1' } as NodeJS.ProcessEnv, self)).toEqual({
      command: self.execPath, args: [self.script], env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(baseLaunch({ APPIMAGE: '/home/me/Husk.AppImage' } as NodeJS.ProcessEnv, self)).toEqual({ command: '/home/me/Husk.AppImage', args: ['--husk-mcp'] });
    expect(baseLaunch({} as NodeJS.ProcessEnv, { execPath: 'node' }).command).toBe('npx');
  });

  it('falls back to npx when HUSK_LAUNCH is missing or malformed', () => {
    expect(baseLaunch({} as NodeJS.ProcessEnv).command).toBe('npx');
    expect(baseLaunch({ HUSK_LAUNCH: '{nope' } as NodeJS.ProcessEnv).command).toBe('npx');
    expect(baseLaunch({ HUSK_LAUNCH: JSON.stringify({ command: 1 }) } as NodeJS.ProcessEnv).command).toBe('npx');
  });

  it('writes the env into a JSON config', async () => {
    fresh();
    mkdirSync(dirOf('cursor'), { recursive: true });
    await connectChatApp('cursor', { command: 'Husk.exe', args: ['bin.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }, { home });
    expect(JSON.parse(readFileSync(fileOf('cursor'), 'utf8')).mcpServers.husk).toEqual({ command: 'Husk.exe', args: ['bin.js'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  });

  it('passes Claude Code and Codex a launch line their CLIs can take, version range included', () => {
    for (const id of ['claude-code', 'codex']) {
      const def = chatAppDefs(home || undefined).find((d) => d.id === id) as { add: (l: unknown) => string[] };
      expect(shellSafe(def.add(huskLaunch({ provider: 'docker', flavor: 'full' })))).toBe(true);
    }
    expect(shellSafe(['a&b'])).toBe(false);
    expect(shellSafe(['%PATH%'])).toBe(false);
  });

  it('puts Claude Code’s -e after the server name, because -e takes several values', () => {
    const def = chatAppDefs(home || undefined).find((d) => d.id === 'claude-code') as { add: (l: unknown) => string[] };
    expect(def.add({ command: 'Husk.exe', args: ['bin.js'], env: { ELECTRON_RUN_AS_NODE: '1' } })).toEqual([
      'mcp', 'add', '--scope', 'user', 'husk', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', 'Husk.exe', 'bin.js',
    ]);
  });
});

type CliDef = {
  entries: () => Array<{ command: string; args: string[]; env: Record<string, string>; project?: string }>;
  add: (l: unknown, scope?: string) => string[];
};
const cliDef = (id: string) => chatAppDefs(home).find((d) => d.id === id) as unknown as CliDef;

describe('after the desktop app updates or moves', () => {
  const app = (dir: string) => ({ command: `${dir}/Husk`, args: [`${dir}/resources/runtime/node_modules/@husk-ai/mcp/dist/bin.js`], env: { ELECTRON_RUN_AS_NODE: '1' } });
  const old = app('/Users/ada/Downloads');
  const now = app('/Applications/Husk.app/Contents/MacOS');

  it('moves a chat app that starts an older copy of the app, computer choice and all, and leaves an npx entry alone', async () => {
    fresh();
    mkdirSync(dirOf('claude-desktop'), { recursive: true });
    writeFileSync(fileOf('claude-desktop'), JSON.stringify({ mcpServers: { husk: { ...old, args: [...old.args, '--provider', 'docker', '--session', 'proj'] } } }));
    mkdirSync(dirOf('cursor'), { recursive: true });
    const theirs = { command: 'npx', args: ['-y', `@husk-ai/mcp@${HUSK_RANGE}`] };
    writeFileSync(fileOf('cursor'), JSON.stringify({ mcpServers: { husk: theirs } }));

    const moved = await followDesktopApp(now, { home });
    expect(moved.map((m) => [m.id, m.ok])).toEqual([['claude-desktop', true]]);
    expect(JSON.parse(readFileSync(fileOf('claude-desktop'), 'utf8')).mcpServers.husk).toEqual({
      command: now.command,
      args: [...now.args, '--provider', 'docker', '--session', 'proj'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(JSON.parse(readFileSync(fileOf('cursor'), 'utf8')).mcpServers.husk).toEqual(theirs);
  });

  it('moves nothing already current, and nothing for a Husk that is not the desktop app’s', async () => {
    fresh();
    mkdirSync(dirOf('claude-desktop'), { recursive: true });
    writeFileSync(fileOf('claude-desktop'), JSON.stringify({ mcpServers: { husk: old } }));
    expect(await followDesktopApp(huskLaunch(), { home })).toEqual([]);
    await followDesktopApp(now, { home });
    expect(await followDesktopApp(now, { home })).toEqual([]);
  });

  it('knows the same launch line, env included, and nothing else', () => {
    expect(sameLaunch(now, JSON.parse(JSON.stringify(now)))).toBe(true);
    expect(sameLaunch(now, { ...now, env: {} })).toBe(false);
    expect(sameLaunch(now, { ...now, args: [...now.args, '--provider', 'docker'] })).toBe(false);
    expect(sameLaunch(now, old)).toBe(false);
    expect(sameLaunch(now, 'npx')).toBe(false);
    expect(sameLaunch(now, null)).toBe(false);
  });
});

describe('coming from 0.1.4', () => {
  // The line 0.1.4 told people to add, with flags and env a person put on it.
  const old = { command: 'npx', args: ['-y', '@husk-ai/mcp', '--session', 'proj', '--provider', 'docker', '--keep'], env: { HUSK_LOG_LEVEL: 'debug' } };

  it('sees an entry that starts an older Husk, and moves it here with the person’s own flags and env', async () => {
    fresh();
    mkdirSync(dirOf('claude-desktop'), { recursive: true });
    writeFileSync(fileOf('claude-desktop'), JSON.stringify({ mcpServers: { husk: old } }));
    expect(detectChatApps(home).find((a) => a.id === 'claude-desktop')).toMatchObject({ connected: true, outdated: true });
    await connectChatApp('claude-desktop', huskLaunch({ provider: 'podman', flavor: 'full' }), { home });
    // The computer is the one just chosen; the session, --keep and the env are the person's.
    expect(JSON.parse(readFileSync(fileOf('claude-desktop'), 'utf8')).mcpServers.husk).toEqual({
      command: 'npx',
      args: ['-y', `@husk-ai/mcp@${HUSK_RANGE}`, '--provider', 'podman', '--flavor', 'full', '--session', 'proj', '--keep'],
      env: { HUSK_LOG_LEVEL: 'debug' },
    });
    expect(detectChatApps(home).find((a) => a.id === 'claude-desktop')?.outdated).toBe(false);
  });

  it('reads Claude Code’s user-wide entry and each project’s own, and moves a project’s in place', () => {
    fresh();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { husk: { type: 'stdio', command: 'npx', args: ['-y', `@husk-ai/mcp@${HUSK_RANGE}`], env: {} } },
        projects: { '/work/proj': { mcpServers: { husk: { type: 'stdio', ...old } } }, '/work/other': { mcpServers: {} } },
      }),
    );
    const def = cliDef('claude-code');
    const entries = def.entries();
    expect(entries.map((e) => e.project ?? 'user')).toEqual(['user', '/work/proj']);
    expect(detectChatApps(home).find((a) => a.id === 'claude-code')).toMatchObject({ connected: true, outdated: true });
    // In its own project, with its own computer choice, flags and env, on this launch line.
    expect(def.add(keepingTheirs(huskLaunch({ provider: 'podman' }), entries[1], true), 'local')).toEqual([
      'mcp', 'add', '--scope', 'local', 'husk', '-e', 'HUSK_LOG_LEVEL=debug', '--',
      'npx', '-y', `@husk-ai/mcp@${HUSK_RANGE}`, '--session', 'proj', '--provider', 'docker', '--keep',
    ]);
  });

  it('reads a Codex entry’s flags and env, inline or in a table of its own', () => {
    fresh();
    mkdirSync(join(home, '.codex'), { recursive: true });
    const toml = join(home, '.codex', 'config.toml');
    writeFileSync(
      toml,
      ['model = "o3"', '', '[mcp_servers.husk]', 'command = "npx"', 'args = ["-y", "@husk-ai/mcp", "--session", "proj"]', '', '[mcp_servers.husk.env]', 'HUSK_LOG_LEVEL = "debug"', '', '[mcp_servers.other]', 'command = "x"'].join('\n'),
    );
    expect(cliDef('codex').entries()).toEqual([{ command: 'npx', args: ['-y', '@husk-ai/mcp', '--session', 'proj'], env: { HUSK_LOG_LEVEL: 'debug' } }]);
    writeFileSync(toml, '[mcp_servers.husk]\ncommand = "npx"\nargs = []\nenv = { HUSK_LOG_LEVEL = "debug" }\n');
    expect(cliDef('codex').entries()[0]?.env).toEqual({ HUSK_LOG_LEVEL: 'debug' });
  });
});

describe('editing configs safely', () => {
  it('reads a file saved with a byte-order mark', async () => {
    fresh();
    mkdirSync(dirOf('cursor'), { recursive: true });
    writeFileSync(fileOf('cursor'), '﻿{"mcpServers":{"husk":{"command":"old"}}}');
    expect(detectChatApps(home).find((a) => a.id === 'cursor')?.connected).toBe(true);
    expect((await connectChatApp('cursor', huskLaunch(), { home })).ok).toBe(true);
  });

  it('keeps fields the person added to the husk entry, and leaves no temp file', async () => {
    fresh();
    mkdirSync(dirOf('cursor'), { recursive: true });
    writeFileSync(fileOf('cursor'), JSON.stringify({ mcpServers: { husk: { command: 'old', env: { HUSK_TOKEN: 'x' }, disabled: false } } }));
    await connectChatApp('cursor', huskLaunch({ provider: 'docker' }), { home });
    expect(JSON.parse(readFileSync(fileOf('cursor'), 'utf8')).mcpServers.husk).toEqual({
      command: 'npx', args: ['-y', `@husk-ai/mcp@${HUSK_RANGE}`, '--provider', 'docker'], env: { HUSK_TOKEN: 'x' }, disabled: false,
    });
    expect(readdirSync(dirOf('cursor')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('never runs claude or codex for a home that is not the real one', async () => {
    fresh();
    const r = await connectChatApp('claude-code', huskLaunch(), { home });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('real home folder');
    expect((await disconnectChatApp('codex', { home })).ok).toBe(false);
  });
});
