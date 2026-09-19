import { EXIT_OK, EXIT_SIGINT, EXIT_USAGE } from './exit.js';
import { UsageError, parse } from './args.js';
import { COMMANDS, commandHelp, findCommand, suggest, topLevelHelp } from './help.js';
import { hasBeenOriented } from './lib/first-run.js';
import { trip } from './signal.js';
import { VERSION } from './version.js';
import * as ui from './ui.js';

/**
 * The program, minus the shebang.
 *
 * `bin.ts` is the executable and does nothing but call `main` here. The split is
 * not cosmetic: this module is re-exported from `index.ts`, so importing the
 * package must never start a CLI run, and a file that both exports helpers and
 * launches itself can only tell the two cases apart by guessing from argv. That
 * guess was wrong for every published install of 0.1.1.
 *
 * Nothing above this line touches `@husk-ai/core` (which pulls zod), the runtime, or
 * the model router. Every command is behind a dynamic import, so the only cost a
 * user pays is the cost of the command they actually ran. A CLI invoked a few
 * hundred times a day cannot afford to load the world to print a usage string.
 */
/**
 * Has this machine run husk before?
 *
 * The marker `first-run.ts` already writes is the cheapest honest signal there
 * is -- one `existsSync` -- so the pointer to `husk onboard` appears for exactly
 * the person it was written for, and never again after that.
 */
function isFirstRun(): boolean {
  return !hasBeenOriented();
}

/** Command name -> the module that implements it. Values are lazy on purpose. */
const ROUTES: Record<string, () => Promise<{ run: (argv: string[]) => Promise<number> }>> = {
  doctor: () => import('./commands/doctor.js'),
  onboard: () => import('./commands/onboard.js'),
  up: () => import('./commands/up.js'),
  ps: () => import('./commands/ps.js'),
  rm: () => import('./commands/rm.js'),
  stop: () => import('./commands/stop.js'),
  start: () => import('./commands/start.js'),
  exec: () => import('./commands/exec.js'),
  shell: () => import('./commands/shell.js'),
  cp: () => import('./commands/cp.js'),
  init: () => import('./commands/init.js'),
  import: () => import('./commands/import.js'),
  distill: () => import('./commands/distill.js'),
  run: () => import('./commands/run.js'),
  serve: () => import('./commands/serve.js'),
  mcp: () => import('./commands/mcp.js'),
  models: () => import('./commands/models.js'),
  validate: () => import('./commands/validate.js'),
  version: () => import('./commands/version.js'),
};

const ALIASES: Record<string, string> = {
  ls: 'ps',
  list: 'ps',
  create: 'up',
  destroy: 'rm',
  delete: 'rm',
  run_: 'run',
  sh: 'shell',
  check: 'doctor',
  setup: 'onboard',
  quickstart: 'onboard',
};

/**
 * Find the subcommand without parsing anything.
 *
 * A pre-pass rather than a parseArgs call, because global flags may legally come
 * before the command (`husk --json ps`) and because a strict parse here would
 * reject a command's own flags before that command ever gets a say.
 */
export function findSubcommand(argv: string[]): { name: string | undefined; rest: string[] } {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') break;
    if (!arg.startsWith('-')) {
      return { name: arg, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
    }
  }
  return { name: undefined, rest: argv };
}

export async function main(argv: string[]): Promise<number> {
  const { name, rest } = findSubcommand(argv);

  // Bare flags that must answer without loading a command. `--version` is
  // checked before parsing, because it is not a global flag on subcommands and
  // a strict parse would reject it.
  if (!name) {
    if (argv.includes('--version') || argv.includes('-V')) {
      process.stdout.write(VERSION + '\n');
      return EXIT_OK;
    }
    ui.configure(parse(argv).values);
    process.stdout.write(topLevelHelp(VERSION, isFirstRun()) + '\n');
    // No arguments is a question, not a mistake. Exit 0 so `husk` in a script
    // that just probes for the binary does not look like a failure.
    return EXIT_OK;
  }

  if (name === 'help') {
    const target = rest.find((a) => !a.startsWith('-'));
    ui.configure(parse(rest.filter((a) => a !== target)).values);
    if (!target) {
      process.stdout.write(topLevelHelp(VERSION, isFirstRun()) + '\n');
      return EXIT_OK;
    }
    const entry = findCommand(resolveAlias(target));
    if (!entry) {
      ui.configure({});
      throw new UsageError(unknownCommandMessage(target));
    }
    process.stdout.write(commandHelp(entry) + '\n');
    return EXIT_OK;
  }

  const resolved = resolveAlias(name);
  const route = ROUTES[resolved];
  if (!route) {
    ui.configure({});
    throw new UsageError(unknownCommandMessage(name));
  }

  // `--help` is answered here so every command gets identical help for free,
  // and so an incomplete command line (`husk exec --help`) never has to be valid.
  if (rest.includes('--help') || rest.includes('-h')) {
    ui.configure({});
    const entry = findCommand(resolved);
    process.stdout.write((entry ? commandHelp(entry) : topLevelHelp(VERSION, isFirstRun())) + '\n');
    return EXIT_OK;
  }

  const mod = await route();
  return mod.run(rest);
}

function resolveAlias(name: string): string {
  return ALIASES[name] ?? name;
}

function unknownCommandMessage(name: string): string {
  const guess = suggest(name);
  return guess
    ? `unknown command "${name}" -- did you mean \`husk ${guess}\`?`
    : `unknown command "${name}" -- known commands: ${COMMANDS.map((c) => c.name).join(', ')}`;
}

/**
 * Ctrl-C aborts in-flight work rather than killing the process, so a run stops
 * between steps and a computer is never left half-created. A second Ctrl-C from
 * an impatient user leaves immediately.
 */
export function installSignalHandlers(): void {
  const onSigint = () => {
    if (!trip()) process.exit(EXIT_SIGINT);
    // A grace window: if nothing unwinds, leave anyway rather than hanging.
    const t = setTimeout(() => process.exit(EXIT_SIGINT), 4000);
    t.unref?.();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);
  // Writing to a closed pipe (`husk ps | head -1`) is normal, not a crash.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(EXIT_OK);
  });
}

export { EXIT_OK, EXIT_SIGINT, EXIT_USAGE };
