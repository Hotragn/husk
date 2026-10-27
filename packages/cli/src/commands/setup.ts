import { spawnSync } from 'node:child_process';
import { connectChatApp, detectChatApps, disconnectChatApp, huskLaunch, readDaemonRecord } from '@husk-ai/core';
import type { ChatApp, ChatAppId, ConnectResult, Flavor } from '@husk-ai/core';
import { leftOutOfAuto } from '@husk-ai/runtime';
import { collect, type DoctorProbes, type DoctorReport, type ProviderRow } from './doctor.js';
import { ask, confirm, interactive } from '../lib/prompt.js';
import { UsageError, parse } from '../args.js';
import * as ui from '../ui.js';
import { EXIT_OK, EXIT_USAGE } from '../exit.js';

/**
 * `husk setup` -- pick the computer, connect your chat apps, start Husk.
 *
 * One command from nothing to "my chat has a computer". Every choice can be
 * passed as a flag, so it runs unattended (`--computer docker --apps all --yes`);
 * in a terminal it asks. It changes another app's settings only after saying
 * which file, backing it up, and touching nothing but its own `husk` entry.
 */

const CONTAINERS = new Set(['docker', 'podman']);

export interface SetupPlan {
  provider: string;
  flavor?: string;
  apps: ChatAppId[];
}

/**
 * The computer to suggest: the first available one with a real boundary, else
 * the first available, and never a paid one unless opted in (it can still be
 * picked by name).
 */
export function recommended(providers: ProviderRow[]): ProviderRow | undefined {
  const free = providers.filter((p) => p.available && !leftOutOfAuto(String(p.name)));
  return free.find((p) => p.isolated) ?? free[0];
}

/** `all` means every app found on this machine; otherwise a comma list of ids. */
export function pickApps(spec: string, apps: ChatApp[]): ChatAppId[] {
  const found = apps.filter((a) => a.found).map((a) => a.id);
  if (spec === 'all') return found;
  const wanted = spec.split(',').map((s) => s.trim()).filter(Boolean);
  const known = new Set(apps.map((a) => a.id));
  const unknown = wanted.filter((w) => !known.has(w as ChatAppId));
  if (unknown.length) throw new UsageError(`unknown app: ${unknown.join(', ')} (known: ${[...known].join(', ')})`, 'setup');
  return wanted as ChatAppId[];
}

export async function run(argv: string[], probes?: DoctorProbes): Promise<number> {
  const { values } = parse(
    argv,
    {
      computer: { type: 'string' },
      flavor: { type: 'string' },
      apps: { type: 'string' },
      yes: { type: 'boolean', default: false },
      remove: { type: 'boolean', default: false },
      'no-start': { type: 'boolean', default: false },
    },
    'setup',
  );
  ui.configure(values);
  const assumeYes = values.yes === true;
  const apps = detectChatApps();

  if (values.remove) return remove(apps, assumeYes);

  // 1. The computer.
  const spin = ui.spinner('checking what this machine can run');
  const report: DoctorReport = await collect(false, probes).finally(() => spin.stop());
  const provider = await chooseComputer(report.providers, values.computer as string | undefined);
  if (!provider) return EXIT_USAGE;
  // `auto` is settled where a chat starts, by the runtime's rule: by priority,
  // the first provider available that auto does not leave out. Its image is that one's.
  const byPriority = [...report.providers].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const runsOn = provider === 'auto' ? (byPriority.find((p) => p.available && !leftOutOfAuto(String(p.name)))?.name ?? provider) : provider;
  const flavor = (values.flavor as string | undefined) ?? (await chooseFlavor(runsOn));

  // 2. The chat apps.
  const chosen = await chooseApps(apps, values.apps as string | undefined);
  const launch = huskLaunch({ provider, ...(flavor ? { flavor } : {}) });
  ui.print();
  ui.print(ui.heading('CHAT APPS'));
  if (!chosen.length) ui.print(`  ${ui.dim('none chosen. Add Husk later with')} ${ui.cyan('husk setup --apps <id>')}`);
  if (chosen.length && !assumeYes && interactive()) {
    for (const id of chosen) ui.print(`  ${ui.dim('will edit')} ${apps.find((a) => a.id === id)?.where}`);
    if (!(await confirm('  Connect these? Each file is backed up first.', { defaultYes: true }))) return EXIT_OK;
  } else if (chosen.length && !assumeYes) {
    ui.print(`  ${ui.dim('no terminal here, so nothing was changed. Pass')} ${ui.cyan('--yes')} ${ui.dim('to connect them.')}`);
    return EXIT_OK;
  }
  const results: ConnectResult[] = [];
  for (const id of chosen) results.push(await connectChatApp(id, launch));
  for (const r of results) report1(r, apps);

  // 3. The computer's image, now rather than in a chat's first call, which
  // cannot show a download's progress. Then Husk itself, so the console can
  // show every chat from the first call. `--no-start` starts and pulls nothing.
  let consoleUrl: string | undefined;
  if (values['no-start'] !== true) await pullImage(runsOn, flavor, values.json === true);
  if (values['no-start'] !== true) {
    const started = ui.spinner('starting Husk');
    try {
      const { connectDaemon } = await import('@husk-ai/mcp/daemon');
      const daemon = await connectDaemon({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never });
      const rec = readDaemonRecord();
      if (daemon && rec) consoleUrl = `${rec.url}/#token=${rec.token ?? ''}`;
    } finally {
      started.stop();
    }
  }

  if (values.json) {
    ui.json({ provider, flavor: flavor ?? null, launch, results, console: consoleUrl ?? null });
    return results.every((r) => r.ok) ? EXIT_OK : 1;
  }
  ui.print();
  ui.print(ui.heading('NEXT'));
  ui.print(`  ${ui.dim('computer')} ${provider}${flavor ? ui.dim(` · ${flavor}`) : ''}`);
  if (consoleUrl) ui.print(`  ${ui.dim('console ')} ${consoleUrl}`);
  else if (values['no-start'] !== true) ui.print(`  ${ui.dim('console ')} ${ui.yellow('Husk did not start')} ${ui.dim('-- chats still work; see ~/.husk/daemon.log')}`);
  ui.print(`  ${ui.dim('try it  ')} ask your chat: "Use Husk to tell me what OS your computer runs."`);
  return results.every((r) => r.ok) ? EXIT_OK : 1;
}

/**
 * Pull a container computer's image with the engine's own progress, unless it
 * is already here. Not fatal: a chat's first call pulls it if this could not.
 */
async function pullImage(provider: string, flavor: string | undefined, quiet: boolean): Promise<void> {
  if (!CONTAINERS.has(provider)) return;
  const { resolveImage } = await import('@husk-ai/runtime');
  const image = resolveImage({ flavor: (flavor ?? 'base') as Flavor }).primary;
  if (spawnSync(provider, ['image', 'inspect', image], { stdio: 'ignore', windowsHide: true }).status === 0) return;
  if (!quiet) ui.print(`  ${ui.dim('getting the computer image, once:')} ${image}${flavor === 'full' ? ui.dim(' (about 2 GB, with the browser)') : ''}`);
  const pulled = spawnSync(provider, ['pull', image], { stdio: quiet ? 'ignore' : ['ignore', 'inherit', 'inherit'], windowsHide: true });
  if (pulled.status !== 0 && !quiet) ui.warn(`could not get ${image} now; the first chat will get it instead`);
}

async function chooseComputer(providers: ProviderRow[], flag: string | undefined): Promise<string | undefined> {
  if (flag) {
    if (flag === 'auto') return 'auto';
    const row = providers.find((p) => p.name === flag);
    if (!row) throw new UsageError(`unknown computer "${flag}" (known: ${providers.map((p) => p.name).join(', ')}, auto)`, 'setup');
    if (!row.available) {
      ui.fail(`${flag} is not available here: ${row.reason ?? 'unknown reason'}`);
      if (row.hint) ui.hint(row.hint);
      return undefined;
    }
    return flag;
  }
  const best = recommended(providers);
  ui.print(ui.heading('WHERE SHOULD YOUR CHATS’ COMPUTERS RUN?'));
  providers.forEach((p, i) => {
    const tag = p === best ? ui.green(' (recommended)') : '';
    const state = p.available
      ? `${ui.green('✓')} ${p.isolated ? 'isolated' : ui.yellow('not isolated')}`
      : `${ui.red('✗')} ${p.reason ?? 'not available'}`;
    ui.print(`  ${i + 1}. ${ui.bold(p.name.padEnd(7))} ${state}${tag}`);
    if (!p.available && p.hint) ui.print(`     ${ui.dim(`fix: ${p.hint}`)}`);
  });
  if (!best) {
    ui.fail('no computer is available on this machine yet; fix one of the above and run setup again');
    return undefined;
  }
  if (!interactive()) return best.name;
  for (;;) {
    const raw = await ask(`Pick one ${ui.dim(`[1-${providers.length}]`)}`, String(providers.indexOf(best) + 1));
    const row = providers[Number(raw) - 1];
    if (row?.available) return row.name;
    ui.warn(row ? `${row.name} is not available: ${row.reason ?? ''}` : 'pick one of the numbers above');
  }
}

async function chooseFlavor(provider: string): Promise<string | undefined> {
  // Only container images come in flavours; the local and ssh providers use
  // what the machine already has.
  if (!CONTAINERS.has(provider)) return undefined;
  // Nobody to ask (the README's paste-into-chat setup): the chats are offered
  // the browser tools, so the image that runs the browser.
  if (!interactive()) return 'full';
  const browser = await confirm('Include a browser? The image is larger, and pages render like in Chrome.', { defaultYes: true });
  // Written out either way: with no flavor, a chat gets `full` regardless.
  return browser ? 'full' : 'base';
}

async function chooseApps(apps: ChatApp[], flag: string | undefined): Promise<ChatAppId[]> {
  if (flag) return pickApps(flag, apps);
  ui.print();
  ui.print(ui.heading('CHAT APPS ON THIS MACHINE'));
  apps.forEach((a, i) => {
    const state = a.outdated ? ui.yellow('older Husk, moves here') : a.connected ? ui.green('connected') : a.found ? 'found' : ui.dim('not found');
    ui.print(`  ${i + 1}. ${a.name.padEnd(15)} ${state}`);
  });
  const found = apps.filter((a) => a.found);
  if (!interactive()) return [];
  const raw = await ask(`Which should use Husk? ${ui.dim('numbers like 1,3, or "all" for every app found')}`, found.length ? 'all' : '');
  if (!raw) return [];
  if (raw === 'all') return found.map((a) => a.id);
  return raw
    .split(',')
    .map((s) => apps[Number(s.trim()) - 1]?.id)
    .filter((id): id is ChatAppId => Boolean(id));
}

function report1(r: ConnectResult, apps: ChatApp[]): void {
  const name = apps.find((a) => a.id === r.id)?.name ?? r.id;
  ui.print(`  ${r.ok ? ui.green('✓') : ui.red('✗')} ${name}: ${r.message}`);
  if (r.backup) ui.print(`    ${ui.dim(`backup: ${r.backup}`)}`);
}

async function remove(apps: ChatApp[], assumeYes: boolean): Promise<number> {
  const connected = apps.filter((a) => a.connected);
  if (!connected.length) {
    ui.print('Husk is not connected to any chat app here.');
    return EXIT_OK;
  }
  if (!(await confirm(`Remove Husk from ${connected.map((a) => a.name).join(', ')}?`, { assumeYes }))) {
    ui.print(ui.dim('nothing changed'));
    return EXIT_OK;
  }
  for (const a of connected) report1(await disconnectChatApp(a.id), apps);
  return EXIT_OK;
}
