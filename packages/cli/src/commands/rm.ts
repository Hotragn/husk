import { HuskError } from '@husk-ai/core';
import { UsageError, parse } from '../args.js';
import { manager, resolve } from '../lib/computers.js';
import { confirm, interactive } from '../lib/prompt.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

/** How recently a computer must have run something to count as busy. */
const BUSY_WINDOW_MS = 60_000;

/**
 * Destroy a computer and its filesystem.
 *
 * The safe path is easy and the dangerous path is deliberate: a single machine
 * is confirmed, `--all` is confirmed with the count spelled out, and a
 * non-interactive shell refuses instead of assuming yes. A CI job that meant to
 * pass `--yes` and did not should fail loudly, not quietly delete everything.
 */
export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(
    argv,
    { all: { type: 'boolean', default: false }, force: { type: 'boolean', short: 'f', default: false } },
    'rm',
  );
  ui.configure(values);

  const assumeYes = values.yes === true || values.force === true;
  const mgr = manager();

  if (values.all) {
    const live = await mgr.list();
    if (!live.length) {
      ui.print(ui.dim('nothing to remove'));
      return EXIT_OK;
    }
    if (!assumeYes) {
      if (!interactive()) {
        throw new UsageError(
          `refusing to destroy ${live.length} computers without confirmation on a non-interactive stdin`,
          'rm',
        );
      }
      ui.note(`about to destroy ${ui.bold(String(live.length))} computers and everything in them:`);
      for (const c of live) ui.note(`  ${ui.dim('-')} ${c.name} ${ui.dim(c.id)}`);
      if (!(await confirm('destroy all of them?'))) {
        ui.note(ui.dim('cancelled'));
        return EXIT_OK;
      }
    }

    // A computer touched seconds ago probably belongs to a run happening right
    // now -- possibly in another terminal, possibly another agent sharing the
    // same husk binding. Destroying it takes the whole workspace with it and the
    // other run starts failing on paths that were valid a moment ago.
    const busy = live.filter((c) => Date.now() - new Date(c.lastUsedAt).getTime() < BUSY_WINDOW_MS);
    if (busy.length > 0 && values.force !== true) {
      throw new HuskError('E_EXEC_DENIED', `${busy.length} of these computers were in use in the last minute`, {
        hint: 'let the run finish, remove them by name, or pass --force if you are sure',
        details: { busy: busy.map((c) => `${c.name} (${c.id})`) },
      });
    }

    const spin = ui.spinner(`destroying ${live.length} computers`);
    const n = await mgr.destroyAll().finally(() => spin.stop());
    if (values.json) ui.json({ destroyed: n });
    else ui.print(`${ui.green('✓')} destroyed ${n} computer${n === 1 ? '' : 's'}`);
    return EXIT_OK;
  }

  const ref = positionals[0];
  if (!ref) throw new UsageError('missing <name|id> — or pass --all to remove every computer', 'rm');

  const computer = await resolve(ref);
  const { name, id, workdir } = computer.info;

  if (!assumeYes) {
    if (!interactive()) {
      throw new UsageError(`refusing to destroy "${name}" without --yes on a non-interactive stdin`, 'rm');
    }
    ui.note(`${ui.bold(name)} ${ui.dim(id)} and everything in ${workdir} will be deleted. This cannot be undone.`);
    if (!(await confirm(`destroy ${name}?`))) {
      ui.note(ui.dim('cancelled'));
      return EXIT_OK;
    }
  }

  const spin = ui.spinner(`destroying ${name}`);
  try {
    await computer.destroy();
  } catch (err) {
    spin.stop();
    throw new HuskError('E_COMPUTER_FAILED', `could not destroy ${name}: ${(err as Error).message}`, {
      hint: 'something may still hold the workspace open — close it and retry, or delete it by hand',
      cause: err,
    });
  }
  spin.stop();

  if (values.json) ui.json({ destroyed: [{ id, name }] });
  else ui.print(`${ui.green('✓')} destroyed ${ui.bold(name)}`);

  return EXIT_OK;
}
