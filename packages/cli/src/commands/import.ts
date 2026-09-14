import { resolve as resolvePath } from 'node:path';
import { formatBytes } from '@husk/core';
import { UsageError, parse, parseCount } from '../args.js';
import { discover } from '../lib/discover.js';
import type { Candidate } from '../lib/discover.js';
import { parseTranscripts, save, summarise } from '../lib/transcripts.js';
import { choose, interactive } from '../lib/prompt.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

/**
 * Find a chat and bring it in.
 *
 * With no argument this is a discovery command, not an error. Asking someone to
 * know the path to a Claude Code session file -- a uuid inside a mangled project
 * directory -- before they can try the feature is how a feature goes unused.
 */
export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(
    argv,
    { source: { type: 'string' }, pick: { type: 'string' }, limit: { type: 'string' } },
    'import',
  );
  ui.configure(values);

  const explicit = positionals[0];
  const source = values.source as string | undefined;

  if (explicit) {
    return importOne(resolvePath(explicit), source, values.json === true);
  }

  const limit = parseCount(values.limit as string | undefined, '--limit', 'import') ?? 20;
  const spin = ui.spinner('looking for transcripts');
  const candidates = await discover({ source, limit }).finally(() => spin.stop());

  if (!candidates.length) {
    ui.print(ui.dim('no transcripts found'));
    ui.note('');
    ui.note(ui.dim('husk looked in:'));
    ui.note(ui.dim('  ~/.claude/projects   Claude Code sessions'));
    ui.note(ui.dim('  ~/Downloads          ChatGPT and Gemini exports'));
    ui.note(ui.dim('  ~/.cursor            Cursor chat history'));
    ui.note(ui.dim('  ./                   markdown and jsonl'));
    ui.note('');
    ui.note(`${ui.dim('point at one directly:')} husk import ./chat.md`);
    return EXIT_OK;
  }

  const pick = values.pick as string | undefined;
  if (pick !== undefined) {
    const n = Number(pick);
    if (!Number.isInteger(n) || n < 1 || n > candidates.length) {
      throw new UsageError(`--pick must be between 1 and ${candidates.length}`, 'import');
    }
    return importOne((candidates[n - 1] as Candidate).path, source, values.json === true);
  }

  if (values.json) {
    ui.json(candidates);
    return EXIT_OK;
  }

  ui.print(ui.heading(`Found ${candidates.length} transcript${candidates.length === 1 ? '' : 's'}`));
  ui.print();
  ui.print(
    ui.table(
      [{ header: '#', max: 3 }, { header: 'source', max: 12 }, { header: 'what', max: 44 }, { header: 'size', max: 8 }, { header: 'modified', max: 10 }],
      candidates.map((c, i) => [
        String(i + 1),
        String(c.source),
        c.title,
        formatBytes(c.sizeBytes),
        c.modifiedAt.slice(0, 10),
      ]),
    ),
  );
  ui.print();

  if (!interactive()) {
    // Non-interactive: the list IS the answer. Never block waiting on a tty
    // that will not arrive.
    ui.note(`${ui.dim('choose one:')} husk import --pick 1`);
    return EXIT_OK;
  }

  const index = await choose('import which?', candidates.length);
  if (index < 0) {
    ui.note(ui.dim('nothing imported'));
    return EXIT_OK;
  }

  return importOne((candidates[index] as Candidate).path, source, false);
}

async function importOne(path: string, source: string | undefined, json: boolean): Promise<number> {
  const spin = ui.spinner(`reading ${path}`);
  const transcripts = await parseTranscripts({
    path,
    ...(source ? { source: source as never } : {}),
  }).finally(() => spin.stop());

  // A ChatGPT export is many conversations in one file; the biggest is almost
  // always the one someone means, and the rest are still saved.
  const sorted = [...transcripts].sort((a, b) => b.messages.length - a.messages.length);
  for (const t of sorted) await save(t);
  const primary = sorted[0];
  if (!primary) {
    ui.print(ui.dim('that file parsed, but contained no messages'));
    return EXIT_OK;
  }

  if (json) {
    ui.json({ imported: sorted.length, primary, ids: sorted.map((t) => t.id) });
    return EXIT_OK;
  }

  const counts = summarise(primary);
  ui.print(`${ui.green('✓')} imported ${ui.bold(primary.title || primary.id)}`);
  ui.print();
  ui.print(
    ui.fields([
      ['id', primary.id],
      ['source', String(primary.source)],
      ['messages', `${primary.messages.length}  ${ui.dim(`(${counts.user} user, ${counts.assistant} assistant, ${counts.tool} tool)`)}`],
      ['size', formatBytes(counts.chars)],
      ...(sorted.length > 1 ? ([['also saved', `${sorted.length - 1} more conversation(s) from the same file`]] as Array<[string, string]>) : []),
    ]),
  );
  ui.print();
  ui.print(ui.dim('  Next:'));
  ui.print(`  ${ui.gray('$')} husk distill ${primary.id} --no-model`);
  return EXIT_OK;
}
