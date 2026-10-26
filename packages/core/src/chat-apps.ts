import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { HUSK_RANGE } from './identity.js';

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
  /**
   * Some `husk` entry starts another Husk than this one: an older release
   * (0.1.4 told people to add `npx -y @husk-ai/mcp`), or another install.
   * Connecting moves it to this launch line, keeping the person's own flags and env.
   */
  outdated: boolean;
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
  // A range, not "latest": a later release that speaks another protocol must not start under a running Husk.
  const npx: HuskLaunch = { command: 'npx', args: ['-y', `@husk-ai/mcp@${HUSK_RANGE}`] };
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

type Scope = 'user' | 'local';

interface CliApp {
  kind: 'cli';
  id: ChatAppId;
  name: string;
  bin: string;
  dir: string;
  add: (l: HuskLaunch, scope?: Scope) => string[];
  remove: (scope?: Scope) => string[];
  /** Its `husk` entries, read from the app's own settings: Claude Code's user-wide one first, then each project's. */
  entries: () => Entry[];
  after: string;
}

/** A `husk` entry as an app has it. */
interface Entry {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Claude Code's local scope: the project folder it is for. */
  project?: string;
}

function entryOf(value: unknown, project?: string): Entry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const e = value as { command?: unknown; args?: unknown; env?: unknown };
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const env = e.env && typeof e.env === 'object' ? Object.entries(e.env).filter((kv): kv is [string, string] => typeof kv[1] === 'string') : [];
  return { command: typeof e.command === 'string' ? e.command : '', args: strings(e.args), env: Object.fromEntries(env), ...(project ? { project } : {}) };
}

/** Claude Code's `~/.claude.json`: the user-wide entry, and each project's own (`claude mcp add` without `--scope`). */
function claudeEntries(home: string): Entry[] {
  try {
    const json = JSON.parse(readText(join(home, '.claude.json')) ?? '{}') as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> } | null>;
    };
    const user = entryOf(json.mcpServers?.husk);
    const local = Object.entries(json.projects ?? {}).flatMap(([project, p]) => entryOf(p?.mcpServers?.husk, project) ?? []);
    return [...(user ? [user] : []), ...local];
  } catch {
    return [];
  }
}

/**
 * Codex's `[mcp_servers.husk]` table, with its env inline or as its own table.
 * ponytail: reads the shapes `codex mcp add` writes (double-quoted strings, a
 * one-line array, an inline env); anything else reads as no flags and no env.
 */
function codexEntry(text: string): Entry | undefined {
  let table: 'husk' | 'env' | undefined;
  let seen = false;
  const entry: Entry = { command: '', args: [], env: {} };
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1];
    if (header !== undefined) {
      table = header === 'mcp_servers.husk' ? 'husk' : header === 'mcp_servers.husk.env' ? 'env' : undefined;
      seen ||= table === 'husk';
      continue;
    }
    const kv = table && /^\s*"?([\w.-]+)"?\s*=\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv as unknown as [string, string, string];
    // An inline table is JSON once its keys are quoted and `=` is `:`.
    const json = raw.startsWith('{') ? raw.replace(/([{,]\s*)"?([\w.-]+)"?\s*=/g, '$1"$2":') : raw;
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      continue;
    }
    if (table === 'env' && typeof value === 'string') entry.env[key] = value;
    else if (key === 'command' && typeof value === 'string') entry.command = value;
    else if (key === 'args') entry.args = entryOf({ args: value })?.args ?? [];
    else if (key === 'env') entry.env = { ...entry.env, ...entryOf({ env: value })?.env };
  }
  return seen ? entry : undefined;
}

/** The bin's own flags a person may have set. The computer choice's two are setup's to decide. */
const PERSON_FLAGS = new Set(['--session', '--profile', '--network', '--memory', '--cpus']);
const CHOICE_FLAGS = new Set(['--provider', '--flavor']);

/** The person's own flags in an entry's args, in order; with `choice`, its provider and flavor too. */
function theirFlags(args: string[], choice: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const name = arg.split('=')[0] as string;
    if (arg === '--keep') out.push(arg);
    else if (!PERSON_FLAGS.has(name) && !(choice && CHOICE_FLAGS.has(name))) continue;
    else if (arg.includes('=')) out.push(arg);
    else if (i + 1 < args.length) out.push(arg, args[++i] as string);
  }
  return out;
}

/** Whether an entry starts this install's Husk: its command and launch line, whatever flags follow. */
function isCurrent(e: Entry, base: HuskLaunch): boolean {
  return e.command === base.command && base.args.every((a, i) => e.args[i] === a);
}

/**
 * `launch` for the entry it replaces, keeping the person's own flags and env.
 * With `own`, the entry keeps its computer choice too: a project's own entry
 * moving in place, whose choice the person made for that project.
 */
export function keepingTheirs(launch: HuskLaunch, prev: { args: string[]; env: Record<string, string> } | undefined, own = false): HuskLaunch {
  const base = own ? launch.args.filter((_, i, all) => !CHOICE_FLAGS.has(all[i] as string) && !CHOICE_FLAGS.has(all[i - 1] as string)) : launch.args;
  const env = { ...(prev?.env ?? {}), ...(launch.env ?? {}) };
  return { command: launch.command, args: [...base, ...theirFlags(prev?.args ?? [], own)], ...(Object.keys(env).length ? { env } : {}) };
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
      add: (l, scope = 'user') => ['mcp', 'add', '--scope', scope, 'husk', ...envFlags('-e', l), '--', l.command, ...l.args],
      remove: (scope = 'user') => ['mcp', 'remove', '--scope', scope, 'husk'],
      entries: () => claudeEntries(home),
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
      remove: () => ['mcp', 'remove', 'husk'],
      entries: () => [codexEntry(readText(join(home, '.codex', 'config.toml')) ?? '')].filter((e): e is Entry => e !== undefined),
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

function entriesOf(def: AppDef): Entry[] {
  if (def.kind === 'cli') return def.entries();
  try {
    const servers = parseConfig(def)[def.key] as Record<string, unknown> | undefined;
    return [entryOf(servers?.husk)].filter((e): e is Entry => e !== undefined);
  } catch {
    return [];
  }
}

/**
 * Every app Husk knows how to connect, whether it is on this machine, whether
 * Husk is in it, and whether that entry starts another Husk than `base`.
 */
export function detectChatApps(home = homedir(), base: HuskLaunch = baseLaunch()): ChatApp[] {
  return chatAppDefs(home).map((def) => {
    const found = def.kind === 'file' ? existsSync(def.dir) : onPath(def.bin) || existsSync(def.dir);
    const entries = found ? entriesOf(def) : [];
    const where = def.kind === 'file' ? def.file : `${def.bin} ${def.add(huskLaunch()).join(' ')}`;
    return {
      id: def.id,
      name: def.name,
      found,
      connected: entries.length > 0,
      outdated: entries.some((e) => !isCurrent(e, base)),
      where,
      after: def.after,
    };
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
function runCli(exe: string, args: string[], cwd = homedir()): Promise<{ ok: boolean; output: string }> {
  const win = process.platform === 'win32';
  return new Promise((resolveRun) => {
    execFile(
      win ? `"${exe}"` : exe,
      win ? args.map((a) => (a.includes(' ') ? `"${a}"` : a)) : args,
      { cwd, timeout: 60_000, windowsHide: true, shell: win, encoding: 'utf8' },
      (err, stdout, stderr) => resolveRun({ ok: !err, output: `${stdout ?? ''}${stderr ?? ''}`.trim() || (err?.message ?? '') }),
    );
  });
}

/** A test or sandbox home cannot redirect another program's own config, so those apps are left alone there. */
function cliRefused(def: CliApp, home: string | undefined): ConnectResult | undefined {
  if (home === undefined || home === homedir()) return undefined;
  return { id: def.id, ok: false, message: `${def.name} keeps its settings in the real home folder, so Husk changes it only for the real user` };
}

// Letters and digits in any script (a profile folder such as C:\Users\José), the
// punctuation a path needs, and the `~` of the version range, which cmd.exe reads
// only inside %...%. Every character cmd.exe treats specially stays out.
const SAFE_TOKEN = /^[\p{L}\p{N}@/\\._=:() '~-]+$/u;

/** Whether every argument can go to an app's CLI through cmd.exe as it is. */
export function shellSafe(args: string[]): boolean {
  return args.every((a) => SAFE_TOKEN.test(a));
}

/**
 * Claude Code's per-project entries win over the user-wide one in their
 * project, and `claude mcp add` writes one by default: 0.1.4's setup line did.
 * Each that starts another Husk moves to this launch line in place, with its
 * own flags, computer choice and env. Says what it moved, or could not.
 */
async function moveProjects(def: CliApp, exe: string, stale: Entry[], launch: HuskLaunch): Promise<string> {
  const moved: string[] = [];
  const failed: string[] = [];
  for (const e of stale) {
    const args = def.add(keepingTheirs(launch, e, true), 'local');
    if (!e.project || !existsSync(e.project) || !shellSafe(args)) {
      failed.push(e.project ?? 'a project');
      continue;
    }
    await runCli(exe, def.remove('local'), e.project);
    ((await runCli(exe, args, e.project)).ok ? moved : failed).push(e.project);
  }
  const n = moved.length;
  return [
    n ? ` Its own entry in ${n === 1 ? 'one project' : `${n} projects`} now starts this Husk too.` : '',
    failed.length ? ` Could not update the one in ${failed.join(', ')}: run \`claude mcp remove husk\` there.` : '',
  ].join('');
}

/**
 * Add Husk to one app, or update its entry, keeping any fields, flags and env
 * the person added to it. An entry from an older Husk moves to this launch line.
 */
export async function connectChatApp(
  id: ChatAppId,
  launch: HuskLaunch,
  // `keepChoice`: the entry keeps its own computer choice too, as when it only follows the desktop app.
  opts: { home?: string; now?: Date; keepChoice?: boolean } = {},
): Promise<ConnectResult> {
  const def = chatAppDefs(opts.home).find((d) => d.id === id);
  if (!def) return { id, ok: false, message: `unknown app ${id}` };
  if (def.kind === 'cli') {
    const refused = cliRefused(def, opts.home);
    if (refused) return refused;
    const entries = def.entries();
    const args = def.add(keepingTheirs(launch, entries.find((e) => !e.project), opts.keepChoice));
    if (!shellSafe(args)) return { id, ok: false, message: 'the launch line has characters Husk will not pass to a shell' };
    const exe = findOnPath(def.bin);
    if (!exe || /[&|<>^%"!]/.test(exe)) return { id, ok: false, message: `${def.bin} is not on PATH; install ${def.name} first` };
    // Replace, so a changed computer choice takes effect.
    const removed = await runCli(exe, def.remove());
    const r = await runCli(exe, args);
    if (!r.ok) {
      const lost = removed.ok ? ' Its earlier Husk entry was removed first, so run setup again once this is fixed.' : '';
      return { id, ok: false, message: `${def.bin} said: ${r.output}${lost}` };
    }
    const base = { command: launch.command, args: keepingTheirs(launch, undefined, true).args };
    const projects = await moveProjects(def, exe, entries.filter((e) => e.project && !isCurrent(e, base)), launch);
    return { id, ok: true, message: `added to ${def.name}.${projects} ${def.after}` };
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
      args: keepingTheirs(launch, entryOf(prev), opts.keepChoice).args,
      ...(launch.env ? { env: { ...prevEnv, ...launch.env } } : {}),
    };
    const backup = backupOf(def.file, opts.now ?? new Date());
    writeAtomic(def.file, `${JSON.stringify({ ...config, [def.key]: servers }, null, 2)}\n`);
    return { id, ok: true, message: `added to ${def.name}. ${def.after}`, ...(backup ? { backup } : {}) };
  } catch (err) {
    return { id, ok: false, message: (err as Error).message };
  }
}

/**
 * Whether a `husk` entry starts a Husk desktop app's own copy: the app's
 * binary run as Node on its bundled bin.js, or a Linux AppImage's --husk-mcp.
 */
function startsDesktopApp(e: { args: string[]; env?: Record<string, string> }): boolean {
  if (e.args[0] === '--husk-mcp') return true;
  return e.env?.ELECTRON_RUN_AS_NODE === '1' && /[\\/]runtime[\\/]node_modules[\\/]@husk-ai[\\/]mcp[\\/]dist[\\/]bin\.js$/.test(e.args[0] ?? '');
}

/** Whether two launch lines start the same Husk the same way. `b` is unchecked input. */
export function sameLaunch(a: HuskLaunch, b: unknown): boolean {
  const l = b as Partial<HuskLaunch> | null | undefined;
  if (!l || typeof l.command !== 'string' || !Array.isArray(l.args)) return false;
  const env = (x: unknown) => JSON.stringify(Object.entries(x && typeof x === 'object' ? x : {}).sort());
  return a.command === l.command && a.args.length === l.args.length && a.args.every((x, i) => x === l.args![i]) && env(a.env) === env(l.env);
}

/**
 * The desktop app updated, or moved: every chat app whose `husk` entry starts
 * a desktop app's Husk by another line than `launch` moves to it, keeping the
 * person's own flags and env. An entry the person pointed elsewhere, such as
 * npx, stays theirs, and nothing moves unless `launch` is a desktop app's own.
 */
export async function followDesktopApp(launch: HuskLaunch, opts: { home?: string; now?: Date } = {}): Promise<ConnectResult[]> {
  if (!startsDesktopApp(launch)) return [];
  const moved: ConnectResult[] = [];
  for (const def of chatAppDefs(opts.home)) {
    const found = def.kind === 'file' ? existsSync(def.dir) : onPath(def.bin) || existsSync(def.dir);
    if (found && entriesOf(def).some((e) => startsDesktopApp(e) && !isCurrent(e, launch))) {
      moved.push(await connectChatApp(def.id, launch, { ...opts, keepChoice: true }));
    }
  }
  return moved;
}

/** Take Husk out of one app, Claude Code's projects included. Its other servers are left as they are. */
export async function disconnectChatApp(id: ChatAppId, opts: { home?: string; now?: Date } = {}): Promise<ConnectResult> {
  const def = chatAppDefs(opts.home).find((d) => d.id === id);
  if (!def) return { id, ok: false, message: `unknown app ${id}` };
  if (def.kind === 'cli') {
    const refused = cliRefused(def, opts.home);
    if (refused) return refused;
    const exe = findOnPath(def.bin);
    if (!exe) return { id, ok: false, message: `${def.bin} is not on PATH` };
    const projects = def.entries().flatMap((e) => (e.project && existsSync(e.project) ? [e.project] : []));
    const r = await runCli(exe, def.remove());
    for (const project of projects) await runCli(exe, def.remove('local'), project);
    // Gone from everywhere it can run: a project folder deleted since cannot start it.
    const gone = def.entries().every((e) => e.project !== undefined && !existsSync(e.project));
    return { id, ok: gone, message: gone ? `removed from ${def.name}` : `${def.bin} said: ${r.output}` };
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
