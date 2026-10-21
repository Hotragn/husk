import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

/**
 * The chat apps `husk setup` can connect, and how each one is told about Husk.
 *
 * Where an app keeps its MCP servers in a JSON file, Husk edits that file: it
 * backs it up first, changes only its own `husk` entry, and refuses to touch a
 * file it cannot parse. Where the app has its own command for this (Claude
 * Code, Codex), Husk runs that command with fixed arguments. Locations follow
 * each vendor's own documentation.
 */

export type ChatAppId = 'claude-desktop' | 'claude-code' | 'cursor' | 'vscode' | 'windsurf' | 'codex' | 'gemini';

export interface ChatApp {
  id: ChatAppId;
  name: string;
  /** The app is installed, or has its config directory, on this machine. */
  found: boolean;
  /** Husk is already in its MCP servers. */
  connected: boolean;
  /** The file Husk edits, or the command it runs. */
  where: string;
  /** What to do after connecting, e.g. restart the app. */
  after: string;
}

/** How a chat app starts Husk. */
export interface HuskLaunch {
  command: string;
  args: string[];
}

/** `npx -y @husk-ai/mcp`, plus the computer the person chose. */
export function huskLaunch(choice: { provider?: string; flavor?: string } = {}): HuskLaunch {
  const args = ['-y', '@husk-ai/mcp'];
  if (choice.provider && choice.provider !== 'auto') args.push('--provider', choice.provider);
  if (choice.flavor) args.push('--flavor', choice.flavor);
  return { command: 'npx', args };
}

interface FileApp {
  kind: 'file';
  id: ChatAppId;
  name: string;
  dir: string;
  file: string;
  /** The top-level key holding servers. */
  key: 'mcpServers' | 'servers';
  /** Extra fields the entry needs (VS Code wants `type`). */
  extra?: Record<string, string>;
  after: string;
}

interface CliApp {
  kind: 'cli';
  id: ChatAppId;
  name: string;
  bin: string;
  dir: string;
  add: (l: HuskLaunch) => string[];
  remove: string[];
  isConnected: () => boolean;
  after: string;
}

type AppDef = FileApp | CliApp;

/** The OS's per-user application data directory: %APPDATA%, Application Support, or ~/.config. */
function appData(home: string): string {
  // The environment only names the real user's folder. Any other home (a test,
  // a sandbox) gets the standard layout under itself, never the real one.
  const real = home === homedir();
  if (process.platform === 'win32') return (real && process.env.APPDATA) || join(home, 'AppData', 'Roaming');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support');
  return (real && process.env.XDG_CONFIG_HOME) || join(home, '.config');
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Whether a command is on PATH, without running it. */
export function onPath(bin: string): boolean {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && exts.some((ext) => existsSync(join(dir, bin + ext))));
}

export function chatAppDefs(home = homedir()): AppDef[] {
  const data = appData(home);
  return [
    {
      kind: 'file', id: 'claude-desktop', name: 'Claude Desktop',
      dir: join(data, 'Claude'), file: join(data, 'Claude', 'claude_desktop_config.json'), key: 'mcpServers',
      after: 'Quit Claude Desktop fully and open it again.',
    },
    {
      kind: 'cli', id: 'claude-code', name: 'Claude Code', bin: 'claude', dir: join(home, '.claude'),
      add: (l) => ['mcp', 'add', '--scope', 'user', 'husk', '--', l.command, ...l.args],
      remove: ['mcp', 'remove', '--scope', 'user', 'husk'],
      isConnected: () => {
        try {
          return Boolean((JSON.parse(readText(join(home, '.claude.json')) ?? '{}') as { mcpServers?: Record<string, unknown> }).mcpServers?.husk);
        } catch {
          return false;
        }
      },
      after: 'Start a new Claude Code session.',
    },
    {
      kind: 'file', id: 'cursor', name: 'Cursor',
      dir: join(home, '.cursor'), file: join(home, '.cursor', 'mcp.json'), key: 'mcpServers',
      after: 'Restart Cursor, then check Settings, MCP.',
    },
    {
      kind: 'file', id: 'vscode', name: 'VS Code',
      dir: join(data, 'Code', 'User'), file: join(data, 'Code', 'User', 'mcp.json'), key: 'servers', extra: { type: 'stdio' },
      after: 'Reload VS Code. Husk appears in the Copilot chat tools.',
    },
    {
      kind: 'file', id: 'windsurf', name: 'Windsurf',
      dir: join(home, '.codeium', 'windsurf'), file: join(home, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers',
      after: 'Restart Windsurf.',
    },
    {
      kind: 'cli', id: 'codex', name: 'Codex CLI', bin: 'codex', dir: join(home, '.codex'),
      add: (l) => ['mcp', 'add', 'husk', '--', l.command, ...l.args],
      remove: ['mcp', 'remove', 'husk'],
      isConnected: () => /^\[mcp_servers\.husk\]/m.test(readText(join(home, '.codex', 'config.toml')) ?? ''),
      after: 'Start a new Codex session.',
    },
    {
      kind: 'file', id: 'gemini', name: 'Gemini CLI',
      dir: join(home, '.gemini'), file: join(home, '.gemini', 'settings.json'), key: 'mcpServers',
      after: 'Start a new Gemini CLI session.',
    },
  ];
}

function parseConfig(def: FileApp): Record<string, unknown> {
  const text = readText(def.file);
  if (text === undefined || text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${def.file} is not plain JSON, so Husk will not edit it. Add Husk to it by hand, or fix the file and run setup again.`);
  }
}

function fileConnected(def: FileApp): boolean {
  try {
    const servers = parseConfig(def)[def.key] as Record<string, unknown> | undefined;
    return Boolean(servers?.husk);
  } catch {
    return false;
  }
}

/** Every app Husk knows how to connect, whether it is on this machine, and whether Husk is in it. */
export function detectChatApps(home = homedir()): ChatApp[] {
  return chatAppDefs(home).map((def) => {
    const found = def.kind === 'file' ? existsSync(def.dir) : onPath(def.bin) || existsSync(def.dir);
    const connected = found && (def.kind === 'file' ? fileConnected(def) : def.isConnected());
    const where = def.kind === 'file' ? def.file : `${def.bin} ${def.add(huskLaunch()).join(' ')}`;
    return { id: def.id, name: def.name, found, connected, where, after: def.after };
  });
}

export interface ConnectResult {
  id: ChatAppId;
  ok: boolean;
  message: string;
  /** The copy made before the file was changed. */
  backup?: string;
}

function backupOf(file: string, now: Date): string | undefined {
  if (!existsSync(file)) return undefined;
  const backup = `${file}.husk-backup-${now.toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(file, backup);
  return backup;
}

/**
 * Run an app's own CLI. On Windows these are `.cmd` shims, which only start
 * through a shell; every argument is a fixed token from this file or the
 * launch line, never text from a page or a chat, so the shell sees no input.
 */
function runCli(bin: string, args: string[]): { ok: boolean; output: string } {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true, shell: process.platform === 'win32' });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() || (r.error?.message ?? '') };
}

const SAFE_TOKEN = /^[A-Za-z0-9@/._=-]+$/;

/** Add Husk to one app, or update its entry. */
export function connectChatApp(id: ChatAppId, launch: HuskLaunch, opts: { home?: string; now?: Date } = {}): ConnectResult {
  const def = chatAppDefs(opts.home).find((d) => d.id === id);
  if (!def) return { id, ok: false, message: `unknown app ${id}` };
  if (def.kind === 'cli') {
    const args = def.add(launch);
    if (!args.every((a) => SAFE_TOKEN.test(a))) return { id, ok: false, message: 'the launch line has characters Husk will not pass to a shell' };
    if (!onPath(def.bin)) return { id, ok: false, message: `${def.bin} is not on PATH; install ${def.name} first` };
    runCli(def.bin, def.remove); // replace, so a changed computer choice takes effect
    const r = runCli(def.bin, args);
    return { id, ok: r.ok, message: r.ok ? `added to ${def.name}. ${def.after}` : `${def.bin} said: ${r.output}` };
  }
  try {
    const config = parseConfig(def);
    const servers = { ...((config[def.key] as Record<string, unknown> | undefined) ?? {}) };
    servers.husk = { ...(def.extra ?? {}), command: launch.command, args: launch.args };
    const backup = backupOf(def.file, opts.now ?? new Date());
    mkdirSync(dirname(def.file), { recursive: true });
    writeFileSync(def.file, `${JSON.stringify({ ...config, [def.key]: servers }, null, 2)}\n`, 'utf8');
    return { id, ok: true, message: `added to ${def.name}. ${def.after}`, ...(backup ? { backup } : {}) };
  } catch (err) {
    return { id, ok: false, message: (err as Error).message };
  }
}

/** Take Husk out of one app. Its other servers are left as they are. */
export function disconnectChatApp(id: ChatAppId, opts: { home?: string; now?: Date } = {}): ConnectResult {
  const def = chatAppDefs(opts.home).find((d) => d.id === id);
  if (!def) return { id, ok: false, message: `unknown app ${id}` };
  if (def.kind === 'cli') {
    const r = runCli(def.bin, def.remove);
    return { id, ok: r.ok, message: r.ok ? `removed from ${def.name}` : `${def.bin} said: ${r.output}` };
  }
  try {
    const config = parseConfig(def);
    const servers = { ...((config[def.key] as Record<string, unknown> | undefined) ?? {}) };
    if (!('husk' in servers)) return { id, ok: true, message: `${def.name} did not have Husk` };
    delete servers.husk;
    const backup = backupOf(def.file, opts.now ?? new Date());
    writeFileSync(def.file, `${JSON.stringify({ ...config, [def.key]: servers }, null, 2)}\n`, 'utf8');
    return { id, ok: true, message: `removed from ${def.name}`, ...(backup ? { backup } : {}) };
  } catch (err) {
    return { id, ok: false, message: (err as Error).message };
  }
}
