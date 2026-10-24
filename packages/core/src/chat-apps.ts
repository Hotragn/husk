import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  env?: Record<string, string>;
}

/**
 * How this install of Husk is started. `npx -y @husk-ai/mcp` by default. The
 * Husk desktop app sets HUSK_LAUNCH on the Husk it runs, naming its own
 * bundled copy, so the apps it connects need no Node install of their own.
 */
export function baseLaunch(
  env: NodeJS.ProcessEnv = process.env,
  self: { electron?: string; execPath: string; script?: string } = { electron: process.versions.electron, execPath: process.execPath, script: process.argv[1] },
): HuskLaunch {
  const npx: HuskLaunch = { command: 'npx', args: ['-y', '@husk-ai/mcp'] };
  if (!env.HUSK_LAUNCH) {
    // A Husk the desktop app's own launch line started (a chat started it,
    // not the app) is still the app's copy: keep chat apps on it, not npx.
    if (self.electron && env.APPIMAGE) return { command: env.APPIMAGE, args: ['--husk-mcp'] };
    if (self.electron && env.ELECTRON_RUN_AS_NODE && self.script) {
      return { command: self.execPath, args: [self.script], env: { ELECTRON_RUN_AS_NODE: '1' } };
    }
    return npx;
  }
  try {
    const l = JSON.parse(env.HUSK_LAUNCH) as Partial<HuskLaunch>;
    const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
    if (typeof l.command !== 'string' || !strings(l.args)) return npx;
    const vars = l.env && typeof l.env === 'object' ? Object.fromEntries(Object.entries(l.env).filter(([, v]) => typeof v === 'string')) : undefined;
    return { command: l.command, args: l.args, ...(vars && Object.keys(vars).length ? { env: vars as Record<string, string> } : {}) };
  } catch {
    return npx;
  }
}

/** This install's launch line, plus the computer the person chose. */
export function huskLaunch(choice: { provider?: string; flavor?: string } = {}, base: HuskLaunch = baseLaunch()): HuskLaunch {
  const args = [...base.args];
  if (choice.provider && choice.provider !== 'auto') args.push('--provider', choice.provider);
  if (choice.flavor) args.push('--flavor', choice.flavor);
  return { ...base, args };
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

/** A file's text, without the byte-order mark Windows PowerShell 5.1 and older Notepad write. */
function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return undefined;
  }
}

/**
 * The absolute path of a command on PATH, without running it. Husk runs that
 * exact file, never the bare name: cmd.exe would look in the current folder
 * first, where an untrusted project could plant a `claude.cmd`.
 */
export function findOnPath(bin: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat'] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, bin + ext);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

export function onPath(bin: string): boolean {
  return findOnPath(bin) !== undefined;
}

/** Write-then-rename in the same folder, so a crash never leaves half a config. */
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.husk-${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

function envFlags(flag: string, l: HuskLaunch): string[] {
  return Object.entries(l.env ?? {}).flatMap(([k, v]) => [flag, `${k}=${v}`]);
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
      // `-e` takes several values, so it goes after the name or it swallows it.
      add: (l) => ['mcp', 'add', '--scope', 'user', 'husk', ...envFlags('-e', l), '--', l.command, ...l.args],
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
      add: (l) => ['mcp', 'add', 'husk', ...envFlags('--env', l), '--', l.command, ...l.args],
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
 * Run an app's own CLI, by its absolute path, from the home folder, without
 * blocking: the shared Husk serving every chat runs this too. On Windows the
 * CLIs are `.cmd` shims, which only start through a shell; every argument is
 * a fixed token from this file or the launch line, never text from a page or
 * a chat, and SAFE_TOKEN keeps out every character cmd.exe treats specially.
 */
function runCli(exe: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  const win = process.platform === 'win32';
  return new Promise((resolveRun) => {
    execFile(
      win ? `"${exe}"` : exe,
      win ? args.map((a) => (a.includes(' ') ? `"${a}"` : a)) : args,
      { cwd: homedir(), timeout: 60_000, windowsHide: true, shell: win, encoding: 'utf8' },
      (err, stdout, stderr) => resolveRun({ ok: !err, output: `${stdout ?? ''}${stderr ?? ''}`.trim() || (err?.message ?? '') }),
    );
  });
}

/** A test or sandbox home cannot redirect another program's own config, so those apps are left alone there. */
function cliRefused(def: CliApp, home: string | undefined): ConnectResult | undefined {
  if (home === undefined || home === homedir()) return undefined;
  return { id: def.id, ok: false, message: `${def.name} keeps its settings in the real home folder, so Husk changes it only for the real user` };
}

// Letters and digits in any script (a profile folder such as C:\Users\José), and
// the punctuation a path needs. Every character cmd.exe treats specially stays out.
const SAFE_TOKEN = /^[\p{L}\p{N}@/\\._=:() '-]+$/u;

/** Add Husk to one app, or update its entry, keeping any fields the person added to it. */
export async function connectChatApp(id: ChatAppId, launch: HuskLaunch, opts: { home?: string; now?: Date } = {}): Promise<ConnectResult> {
  const def = chatAppDefs(opts.home).find((d) => d.id === id);
  if (!def) return { id, ok: false, message: `unknown app ${id}` };
  if (def.kind === 'cli') {
    const refused = cliRefused(def, opts.home);
    if (refused) return refused;
    const args = def.add(launch);
    if (!args.every((a) => SAFE_TOKEN.test(a))) return { id, ok: false, message: 'the launch line has characters Husk will not pass to a shell' };
    const exe = findOnPath(def.bin);
    if (!exe || /[&|<>^%"!]/.test(exe)) return { id, ok: false, message: `${def.bin} is not on PATH; install ${def.name} first` };
    // Replace, so a changed computer choice takes effect.
    const removed = await runCli(exe, def.remove);
    const r = await runCli(exe, args);
    if (r.ok) return { id, ok: true, message: `added to ${def.name}. ${def.after}` };
    const lost = removed.ok ? ' Its earlier Husk entry was removed first, so run setup again once this is fixed.' : '';
    return { id, ok: false, message: `${def.bin} said: ${r.output}${lost}` };
  }
  try {
    const config = parseConfig(def);
    const servers = { ...((config[def.key] as Record<string, unknown> | undefined) ?? {}) };
    const prev = servers.husk && typeof servers.husk === 'object' ? (servers.husk as Record<string, unknown>) : {};
    const prevEnv = prev.env && typeof prev.env === 'object' ? (prev.env as Record<string, string>) : {};
    servers.husk = {
      ...prev,
      ...(def.extra ?? {}),
      command: launch.command,
      args: launch.args,
      ...(launch.env ? { env: { ...prevEnv, ...launch.env } } : {}),
    };
    const backup = backupOf(def.file, opts.now ?? new Date());
    writeAtomic(def.file, `${JSON.stringify({ ...config, [def.key]: servers }, null, 2)}\n`);
    return { id, ok: true, message: `added to ${def.name}. ${def.after}`, ...(backup ? { backup } : {}) };
  } catch (err) {
    return { id, ok: false, message: (err as Error).message };
  }
}

/** Take Husk out of one app. Its other servers are left as they are. */
export async function disconnectChatApp(id: ChatAppId, opts: { home?: string; now?: Date } = {}): Promise<ConnectResult> {
  const def = chatAppDefs(opts.home).find((d) => d.id === id);
  if (!def) return { id, ok: false, message: `unknown app ${id}` };
  if (def.kind === 'cli') {
    const refused = cliRefused(def, opts.home);
    if (refused) return refused;
    const exe = findOnPath(def.bin);
    if (!exe) return { id, ok: false, message: `${def.bin} is not on PATH` };
    const r = await runCli(exe, def.remove);
    return { id, ok: r.ok, message: r.ok ? `removed from ${def.name}` : `${def.bin} said: ${r.output}` };
  }
  try {
    const config = parseConfig(def);
    const servers = { ...((config[def.key] as Record<string, unknown> | undefined) ?? {}) };
    if (!('husk' in servers)) return { id, ok: true, message: `${def.name} did not have Husk` };
    delete servers.husk;
    const backup = backupOf(def.file, opts.now ?? new Date());
    writeAtomic(def.file, `${JSON.stringify({ ...config, [def.key]: servers }, null, 2)}\n`);
    return { id, ok: true, message: `removed from ${def.name}`, ...(backup ? { backup } : {}) };
  } catch (err) {
    return { id, ok: false, message: (err as Error).message };
  }
}
