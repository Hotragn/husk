import { createInterface } from 'node:readline';
import { parse, required } from '../args.js';
import { resolve } from '../lib/computers.js';
import { interruptSignal } from '../signal.js';
import * as ui from '../ui.js';
import { EXIT_OK, EXIT_SIGINT } from '../exit.js';

/**
 * An interactive prompt against a computer.
 *
 * This is a readline loop, not a pty, and the help text says so plainly rather
 * than letting someone discover it when `vim` paints garbage. A pty would need a
 * native module, and the build contract rules those out because one failed
 * `npm install` on a Windows machine costs more users than a pty gains.
 *
 * What it does do is track `cd` across lines, which is the thing people actually
 * miss when a shell is stateless.
 */
export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { cwd: { type: 'string' } }, 'shell');
  ui.configure(values);

  const computer = await resolve(required(positionals, 0, 'name|id', 'shell'));
  const name = computer.info.name;
  let cwd = (values.cwd as string | undefined) ?? computer.info.workdir;

  ui.note(`${ui.bold(name)} ${ui.dim(`(${computer.info.provider})`)}  ${ui.dim(cwd)}`);
  ui.note(ui.dim('Each line is a separate exec, not a pty — cd is tracked, but vim and top will not work.'));
  ui.note(ui.dim('exit, quit, or Ctrl-D to leave.'));

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  const prompt = () => {
    rl.setPrompt(`${ui.cyan(name)}${ui.dim(':')}${ui.blue(cwd)}${ui.dim('$')} `);
    rl.prompt();
  };

  let exitCode = EXIT_OK;
  const signal = interruptSignal();

  await new Promise<void>((done) => {
    let running = false;

    signal.addEventListener('abort', () => {
      exitCode = EXIT_SIGINT;
      rl.close();
    }, { once: true });

    rl.on('line', (raw) => {
      const line = raw.trim();
      if (!line) return prompt();
      if (line === 'exit' || line === 'quit') return rl.close();
      if (running) return;

      // `cd` is the one builtin worth intercepting: without it every command
      // starts back at the workdir and the loop feels broken.
      const cd = /^cd\s*(.*)$/.exec(line);
      if (cd) {
        void changeDir(cd[1]?.trim() ?? '').then(prompt);
        return;
      }

      running = true;
      void computer
        .exec({
          cmd: line,
          cwd,
          signal,
          onStdout: (c) => process.stdout.write(c),
          onStderr: (c) => process.stderr.write(c),
        })
        .then((r) => {
          if (r.timedOut) ui.warn('timed out');
          else if (r.exitCode !== 0) ui.note(ui.dim(`exit ${r.exitCode}`));
        })
        .catch((err: unknown) => {
          ui.fail((err as Error).message);
          const h = (err as { hint?: string }).hint;
          if (h) ui.hint(h);
        })
        .finally(() => {
          running = false;
          prompt();
        });
    });

    rl.on('close', () => done());
    prompt();
  });

  async function changeDir(target: string): Promise<void> {
    const next = !target || target === '~' ? computer.info.workdir : target;
    // Ask the machine to resolve it, so `..` and symlinks behave the way the
    // agent's own shell would rather than the way node's path module would.
    const probe = await computer
      .exec({ cmd: `cd ${JSON.stringify(next)} && pwd`, cwd, signal })
      .catch(() => null);
    if (!probe || probe.exitCode !== 0) {
      ui.fail(`cd: ${next}: no such directory`);
      return;
    }
    cwd = probe.stdout.trim() || cwd;
  }

  if (exitCode === EXIT_OK) ui.note(ui.dim('bye'));
  return exitCode;
}
