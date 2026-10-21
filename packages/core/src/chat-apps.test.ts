import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseLaunch, chatAppDefs, connectChatApp, detectChatApps, disconnectChatApp, huskLaunch } from './chat-apps.js';

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
    expect(huskLaunch()).toEqual({ command: 'npx', args: ['-y', '@husk-ai/mcp'] });
    expect(huskLaunch({ provider: 'docker', flavor: 'full' }).args).toEqual(['-y', '@husk-ai/mcp', '--provider', 'docker', '--flavor', 'full']);
    expect(huskLaunch({ provider: 'auto' }).args).toEqual(['-y', '@husk-ai/mcp']);
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

  it('adds itself to a JSON config, keeps the other servers, and backs the file up', () => {
    fresh();
    const file = fileOf('claude-desktop');
    mkdirSync(dirOf('claude-desktop'), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
    const r = connectChatApp('claude-desktop', huskLaunch({ provider: 'docker' }), { home });
    expect(r.ok).toBe(true);
    expect(r.backup && existsSync(r.backup)).toBe(true);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after).toEqual({
      mcpServers: { other: { command: 'x' }, husk: { command: 'npx', args: ['-y', '@husk-ai/mcp', '--provider', 'docker'] } },
      theme: 'dark',
    });
    expect(detectChatApps(home).find((a) => a.id === 'claude-desktop')?.connected).toBe(true);
  });

  it('writes VS Code its own shape', () => {
    fresh();
    mkdirSync(dirOf('vscode'), { recursive: true });
    connectChatApp('vscode', huskLaunch(), { home });
    expect(JSON.parse(readFileSync(fileOf('vscode'), 'utf8'))).toEqual({ servers: { husk: { type: 'stdio', command: 'npx', args: ['-y', '@husk-ai/mcp'] } } });
  });

  it('refuses to edit a file it cannot parse, and leaves it exactly as it was', () => {
    fresh();
    mkdirSync(dirOf('cursor'), { recursive: true });
    const text = '{ // a comment\n "mcpServers": {} }';
    writeFileSync(fileOf('cursor'), text);
    const r = connectChatApp('cursor', huskLaunch(), { home });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not plain JSON');
    expect(readFileSync(fileOf('cursor'), 'utf8')).toBe(text);
    expect(readdirSync(dirOf('cursor'))).toEqual(['mcp.json']);
  });

  it('removes only itself', () => {
    fresh();
    mkdirSync(dirOf('gemini'), { recursive: true });
    writeFileSync(fileOf('gemini'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    connectChatApp('gemini', huskLaunch(), { home });
    expect(disconnectChatApp('gemini', { home }).ok).toBe(true);
    expect(JSON.parse(readFileSync(fileOf('gemini'), 'utf8'))).toEqual({ mcpServers: { other: { command: 'x' } } });
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

  it('falls back to npx when HUSK_LAUNCH is missing or malformed', () => {
    expect(baseLaunch({} as NodeJS.ProcessEnv).command).toBe('npx');
    expect(baseLaunch({ HUSK_LAUNCH: '{nope' } as NodeJS.ProcessEnv).command).toBe('npx');
    expect(baseLaunch({ HUSK_LAUNCH: JSON.stringify({ command: 1 }) } as NodeJS.ProcessEnv).command).toBe('npx');
  });

  it('writes the env into a JSON config', () => {
    fresh();
    mkdirSync(dirOf('cursor'), { recursive: true });
    connectChatApp('cursor', { command: 'Husk.exe', args: ['bin.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }, { home });
    expect(JSON.parse(readFileSync(fileOf('cursor'), 'utf8')).mcpServers.husk).toEqual({ command: 'Husk.exe', args: ['bin.js'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  });
});
