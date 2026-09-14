import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, resolve as resolvePath } from 'node:path';
import { HuskError, defaultSpec, parseSpec } from '@husk-ai/core';
import { parse } from '../args.js';
import { renderSpec, slugName } from '../lib/yaml.js';
import { interactive, session } from '../lib/prompt.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

/**
 * Scaffold a husk.yaml.
 *
 * Interactive on a terminal, silent and defaulted when piped -- a scaffolder
 * that blocks on a question inside a Dockerfile is a scaffolder people stop
 * using. Every prompt has a working default, so pressing enter four times
 * produces a valid spec.
 */
export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(
    argv,
    { out: { type: 'string' }, force: { type: 'boolean', default: false } },
    'init',
  );
  ui.configure(values);

  const outPath = resolvePath((values.out as string | undefined) ?? 'husk.yaml');
  if (existsSync(outPath) && values.force !== true) {
    throw new HuskError('E_CONFIG', `${outPath} already exists`, {
      hint: 'pass --force to overwrite it, or --out to write somewhere else',
    });
  }

  const suggested = slugName(positionals[0] ?? basename(process.cwd()));
  const ask = values.yes !== true && interactive();

  let name = suggested;
  let description = '';
  let model = 'auto';
  let persona = 'You are a careful, concise assistant with access to a Linux computer.';
  let wantsComputer = true;
  let approvalMode: 'auto' | 'ask' | 'readonly' = 'auto';

  if (ask) {
    const s = session();
    try {
      ui.note(ui.dim('Four questions. Enter accepts the default.'));
      ui.note('');
      name = slugName(await s.ask('name', suggested));
      description = await s.ask('one-line description', 'A husk.');
      model = await s.ask('model (auto, sonnet, gemma, ollama/llama3.2)', 'auto');
      const p = await s.ask('what should it do? this becomes the system prompt', persona);
      persona = p;
      wantsComputer = /^y/i.test(await s.ask('give it a Linux computer? [Y/n]', 'y'));
      const mode = await s.ask('approvals for dangerous tools: auto, ask, readonly', 'auto');
      approvalMode = mode === 'ask' || mode === 'readonly' ? mode : 'auto';
    } finally {
      s.close();
    }
  } else if (values.yes !== true) {
    ui.note(ui.dim('stdin is not a terminal — writing defaults. Pass --yes to silence this.'));
  }

  const base = defaultSpec(name);
  const spec = parseSpec({
    ...base,
    name,
    displayName: base.displayName,
    description: description || 'A husk.',
    model,
    persona,
    tools: wantsComputer ? ['computer', 'files'] : ['files'],
    computer: { ...base.computer, enabled: wantsComputer },
    guardrails: { ...base.guardrails, approvalMode },
  });

  const yaml = renderSpec(spec, {
    provenance: [`husk.yaml — created by \`husk init\` on ${new Date().toISOString().slice(0, 10)}`, 'Docs: husk help run'],
  });

  await writeFile(outPath, yaml, 'utf8');

  if (values.json) {
    ui.json({ path: outPath, spec });
    return EXIT_OK;
  }

  ui.print(`${ui.green('✓')} wrote ${ui.bold(outPath)}`);
  ui.print();
  ui.print(ui.dim('  Next:'));
  ui.print(`  ${ui.gray('$')} husk validate ${basename(outPath)}`);
  ui.print(`  ${ui.gray('$')} husk run ${basename(outPath)} "say hello"`);
  return EXIT_OK;
}
