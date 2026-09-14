import { slug } from '@husk/core';
import type { ComputerSpec } from '@husk/core';
import { parse, parseChoice, parseCount, parseMemory } from '../args.js';
import { manager } from '../lib/computers.js';
import { orient } from '../lib/first-run.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

const NETWORK_MODES = ['none', 'egress', 'full'] as const;
const FLAVORS = ['base', 'python', 'node', 'full'] as const;

/**
 * Create a computer, then say what to do with it.
 *
 * The "what to do with it" is the point. A create command that prints an id and
 * stops makes the user go find the docs; printing the three commands they are
 * about to want, with the real name substituted in, means they never have to.
 */
export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(
    argv,
    {
      provider: { type: 'string' },
      flavor: { type: 'string' },
      memory: { type: 'string' },
      cpus: { type: 'string' },
      network: { type: 'string' },
      persist: { type: 'boolean', default: false },
      env: { type: 'string', multiple: true },
      packages: { type: 'string', multiple: true },
      'idle-timeout': { type: 'string' },
    },
    'up',
  );
  ui.configure(values);

  const name = positionals[0] ? slug(positionals[0]) : `box-${Math.random().toString(36).slice(2, 7)}`;
  const mgr = manager();

  // Orientation before the work, not after: the isolation story is something to
  // read before a machine exists, not once it already does.
  const requested = (values.provider as string | undefined) ?? 'auto';
  const status = await mgr.status();
  const picked = requested === 'auto' ? status.find((s) => s.available) : status.find((s) => s.name === requested);
  orient({
    provider: picked ? String(picked.name) : requested,
    isolated: picked?.isolated ?? null,
    detail: picked?.version,
    hint: `husk exec ${name} -- uname -sr`,
  });

  const spec: ComputerSpec = {
    name,
    ...(values.provider ? { provider: values.provider as string } : {}),
    ...(values.flavor ? { flavor: parseChoice(values.flavor as string, FLAVORS, '--flavor', 'up') } : {}),
    ...(values.memory ? { memoryMb: parseMemory(values.memory as string, 'up') } : {}),
    ...(values.cpus ? { cpus: parseCount(values.cpus as string, '--cpus', 'up') } : {}),
    ...(values.network
      ? { network: { mode: parseChoice(values.network as string, NETWORK_MODES, '--network', 'up') ?? 'egress' } }
      : {}),
    ...(values.persist ? { persist: true } : {}),
    // Repeatable and comma-splittable, because `--packages curl,git` is what
    // people type and being told it is wrong helps nobody.
    ...((values.packages as string[] | undefined)?.length
      ? {
          packages: (values.packages as string[])
            .flatMap((p) => p.split(','))
            .map((p) => p.trim())
            .filter(Boolean),
        }
      : {}),
    ...(values['idle-timeout']
      ? { idleTimeoutSec: parseCount(values['idle-timeout'] as string, '--idle-timeout', 'up') }
      : {}),
    ...(parseEnv(values.env as string[] | undefined) ? { env: parseEnv(values.env as string[] | undefined) } : {}),
  };

  const spin = ui.spinner(`creating ${name}`);
  let computer;
  try {
    computer = await mgr.create(spec);
  } finally {
    spin.stop();
  }

  const info = computer.info;

  if (values.json) {
    ui.json(info);
    return EXIT_OK;
  }

  const availability = status.find((s) => s.name === info.provider);
  ui.print(`${ui.green('✓')} ${ui.bold(info.name)} is up`);
  ui.print();
  ui.print(
    ui.fields([
      ['id', ui.dim(info.id)],
      ['provider', `${info.provider}${availability?.version ? ui.dim(`  (${availability.version})`) : ''}`],
      [
        'isolation',
        availability?.isolated
          ? ui.green('kernel-level')
          : ui.yellow('guardrails only — not a sandbox'),
      ],
      ['image', info.imageFallback ? `${info.image} ${ui.yellow('(fallback)')}` : ui.dim(info.image)],
      ['workdir', info.workdir],
      ['network', spec.network?.mode ?? 'egress'],
    ]),
  );

  // Said out loud, because the difference is not cosmetic: the stock fallback
  // has no python3 and no curl, so `husk browse` and the real browser both fail
  // on it -- and they fail complaining about the network, which sends you
  // looking in the wrong place entirely.
  if (info.imageFallback) {
    ui.print();
    ui.print(`  ${ui.yellow('!')} ${ui.bold(info.imageFallback.wanted)} was not available, so this machine is`);
    ui.print(`    stock ${ui.bold(info.image)} — husk's own tools are not in it.`);
    // Named rather than generalised: the base fallback really has no python3,
    // but python:3.12-slim does, and telling someone their python image has no
    // python is the fastest way to lose their trust in every other message.
    if (!/python|node/.test(info.image)) {
      ui.print(`    No python3 and no curl, so ${ui.bold('browsing will not work')} here.`);
      ui.print(`    ${ui.dim('An image that has one:')}`);
      ui.print(`    ${ui.gray('$')} husk rm ${info.name} --yes && husk up ${info.name} --flavor python`);
    }
  }

  ui.print();
  ui.print(ui.dim('  Try it:'));
  ui.print(`  ${ui.gray('$')} husk exec ${info.name} -- uname -sr`);
  ui.print(`  ${ui.gray('$')} husk shell ${info.name}`);
  ui.print(`  ${ui.gray('$')} husk cp ./file.txt ${info.name}:${info.workdir}/file.txt`);
  ui.print(`  ${ui.gray('$')} husk rm ${info.name}`);

  return EXIT_OK;
}

function parseEnv(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs?.length) return undefined;
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}
