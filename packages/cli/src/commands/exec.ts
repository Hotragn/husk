import { UsageError, parse, parseCount, parseEnvPairs, required } from '../args.js';
import { resolve } from '../lib/computers.js';
import { interruptSignal } from '../signal.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

/**
 * Run a command inside a computer and get out of the way.
 *
 * Two decisions define this command. First, output streams: buffering it until
 * the process ends would break `husk exec box -- npm test` for anything that
 * takes more than a moment. Second, the exit code is the child's, not ours --
 * `husk exec box -- test -f /work/x && echo yes` has to work, and a wrapper that
 * always exits 0 is a wrapper nobody can use in a script.
 */
export async function run(argv: string[]): Promise<number> {
  const { values, positionals, rest, hasRest } = parse(
    argv,
    {
      cwd: { type: 'string' },
      timeout: { type: 'string' },
      env: { type: 'string', multiple: true },
      stdin: { type: 'string' },
    },
    'exec',
  );
  ui.configure(values);

  const name = required(positionals, 0, 'name|id', 'exec');

  // Anything after `--` is the command. Without `--`, leftover positionals are
  // accepted so `husk exec box ls` works, but the help teaches `--` because it
  // is the only form that can carry flags safely.
  const cmd = hasRest ? rest : positionals.slice(1);
  if (!cmd.length) {
    throw new UsageError(
      `nothing to run — put the command after \`--\`, e.g. \`husk exec ${name} -- uname -sr\``,
      'exec',
    );
  }

  const computer = await resolve(name);

  // A single argument is a shell string, so `husk exec box -- 'a > b; cat b'`
  // does what it looks like. Multiple arguments are argv and are not re-split,
  // so a filename with a space survives.
  const command = cmd.length === 1 ? (cmd[0] as string) : cmd;

  const result = await computer.exec({
    cmd: command,
    ...(values.cwd ? { cwd: values.cwd as string } : {}),
    ...(values.timeout ? { timeoutSec: parseCount(values.timeout as string, '--timeout', 'exec') } : {}),
    ...(parseEnvPairs(values.env as string[] | undefined, 'exec')
      ? { env: parseEnvPairs(values.env as string[] | undefined, 'exec') }
      : {}),
    ...(values.stdin !== undefined ? { stdin: values.stdin as string } : {}),
    signal: interruptSignal(),
    // Under --json the result is the answer, so nothing may be written early.
    ...(values.json
      ? {}
      : {
          onStdout: (chunk: string) => process.stdout.write(chunk),
          onStderr: (chunk: string) => process.stderr.write(chunk),
        }),
  });

  if (values.json) {
    ui.json(result);
  } else if (result.timedOut) {
    ui.warn(`timed out after ${values.timeout ?? 120}s — the process tree was killed`);
    ui.note(ui.dim('hint:  raise it with --timeout, e.g. --timeout 600'));
  } else if (result.truncated) {
    ui.warn('output was clamped — re-run writing to a file and `husk cp` it out');
  }

  return result.exitCode === 0 ? EXIT_OK : result.exitCode;
}
