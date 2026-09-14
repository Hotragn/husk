import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, resolve as resolvePath } from 'node:path';
import { HuskError } from '@husk-ai/core';
import type { DistilledAgent, ModelProvider, Transcript } from '@husk-ai/core';
import { parse, required } from '../args.js';
import { load, parseTranscripts, save, summarise } from '../lib/transcripts.js';
import { pinned, resolveModel } from '../lib/models.js';
import { renderSpec, specFromDistilled } from '../lib/yaml.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

/**
 * chat -> husk.yaml.
 *
 * Two things make this trustworthy rather than magic. It says what it extracted
 * and how sure it is, so a low-confidence result is visible instead of quietly
 * shipping a bad persona. And the free heuristic path is a first-class option,
 * not a fallback -- `--no-model` forces it even when a key is present, because
 * "does this work without an API key?" should be answerable in one command.
 */
export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(
    argv,
    {
      model: { type: 'string' },
      'no-model': { type: 'boolean', default: false },
      out: { type: 'string' },
      name: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
    'distill',
  );
  ui.configure(values);

  const ref = required(positionals, 0, 'transcript-id|path', 'distill');
  const outPath = resolvePath((values.out as string | undefined) ?? 'husk.yaml');

  if (existsSync(outPath) && values.force !== true) {
    throw new HuskError('E_CONFIG', `${outPath} already exists`, {
      hint: 'pass --force to overwrite it, or --out to write somewhere else',
    });
  }

  const transcript = await locate(ref);
  const counts = summarise(transcript);
  ui.note(
    `${ui.dim('source')} ${transcript.title || transcript.id} ${ui.dim(`· ${transcript.messages.length} messages · ${transcript.source}`)}`,
  );

  const { provider, modelId, why } = await pickProvider(values['no-model'] === true, values.model as string | undefined);
  ui.note(`${ui.dim('using ')} ${modelId ?? 'heuristics only'} ${ui.dim(`· ${why}`)}`);

  const spin = ui.spinner(provider ? 'distilling with the model' : 'distilling');
  const { Distiller } = await import('@husk-ai/sessions');
  const agent: DistilledAgent = await new Distiller(provider).distill(transcript).finally(() => spin.stop());

  // The distiller emits a free-form shape; the schema wants a slug and known
  // tool bundles. `toSpec` in @husk-ai/sessions does that normalising -- including
  // `origin`, from the transcript itself, so the CLI and the control plane
  // record provenance the same way.
  const spec = specFromDistilled(agent, {
    transcript,
    ...(values.name ? { name: values.name as string } : {}),
  });

  const yaml = renderSpec(spec, {
    provenance: [
      `Distilled by husk from ${transcript.origin ?? transcript.id} (${transcript.source}).`,
      `${transcript.messages.length} messages · confidence ${agent.confidence.toFixed(2)} · ${modelId ?? 'heuristic'}`,
      'Review the persona before you serve this. Distillation is a draft, not an oracle.',
    ],
  });

  await writeFile(outPath, yaml, 'utf8');

  if (values.json) {
    ui.json({ path: outPath, confidence: agent.confidence, agent, spec });
    return EXIT_OK;
  }

  ui.print(`${ui.green('✓')} wrote ${ui.bold(outPath)}`);
  ui.print();
  ui.print(ui.heading('EXTRACTED'));
  ui.print(
    ui.fields([
      ['name', spec.name],
      ['description', spec.description || ui.dim('(none found)')],
      ['persona', `${spec.persona.split('\n').length} lines, ${spec.persona.length} chars`],
      ['knowledge', spec.knowledge.length ? `${spec.knowledge.length} item(s)` : ui.dim('none')],
      ['examples', spec.examples.length ? `${spec.examples.length} pair(s)` : ui.dim('none')],
      ['tools', spec.tools.join(', ')],
      ['computer', spec.computer.enabled ? 'yes' : ui.dim('no')],
      ['confidence', confidenceBar(agent.confidence)],
    ]),
  );

  if (agent.notes?.length) {
    ui.print();
    ui.print(ui.heading('THE DISTILLER COULD NOT DETERMINE'));
    for (const note of agent.notes) ui.print(`  ${ui.dim('·')} ${note}`);
  }

  if (agent.confidence < 0.5) {
    ui.print();
    ui.warn(
      `low confidence — ${counts.user} user turns is thin signal. Read the persona before serving this, and consider distilling a longer conversation.`,
    );
  }

  ui.print();
  ui.print(ui.dim('  Next:'));
  ui.print(`  ${ui.gray('$')} husk validate ${basename(outPath)}`);
  ui.print(`  ${ui.gray('$')} husk run ${basename(outPath)} "hello"`);
  return EXIT_OK;
}

/** A stored transcript id, or a path to import on the spot. */
async function locate(ref: string): Promise<Transcript> {
  const stored = await load(ref);
  if (stored) return stored;

  const path = resolvePath(ref);
  if (!existsSync(path)) {
    throw new HuskError('E_IMPORT_FAILED', `no transcript "${ref}" — not a stored id and not a file`, {
      hint: 'run `husk import` to discover and import one first',
    });
  }

  const parsed = await parseTranscripts({ path });
  const primary = [...parsed].sort((a, b) => b.messages.length - a.messages.length)[0];
  if (!primary) {
    throw new HuskError('E_IMPORT_FAILED', `${path} parsed but contained no messages`, {
      hint: 'check the file is a real export, or force a format with --source',
    });
  }
  await save(primary);
  return primary;
}

/**
 * Choose the distillation path.
 *
 * `--no-model` wins outright. Otherwise a missing model is not an error: the
 * heuristic path is the free path, and degrading to it with a printed reason is
 * better than failing on a machine that never had a key.
 */
async function pickProvider(
  noModel: boolean,
  requested: string | undefined,
): Promise<{ provider: ModelProvider | undefined; modelId: string | null; why: string }> {
  if (noModel) return { provider: undefined, modelId: null, why: '--no-model, free heuristic path' };

  try {
    const resolved = await resolveModel(requested ?? 'auto');
    return { provider: pinned(resolved), modelId: resolved.info.id, why: 'model-backed' };
  } catch (err) {
    const reason = (err as Error).message;
    return { provider: undefined, modelId: null, why: `no model reachable (${reason}) — falling back to heuristics` };
  }
}

function confidenceBar(value: number): string {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const filled = Math.round(pct / 10);
  const bar = '█'.repeat(filled) + ui.dim('░'.repeat(10 - filled));
  const colour = pct >= 70 ? ui.green : pct >= 40 ? ui.yellow : ui.red;
  return `${colour(bar)} ${pct}%`;
}
