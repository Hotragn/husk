import { resolve as resolvePath } from 'node:path';
import { HuskError } from '@husk-ai/core';
import { parse } from '../args.js';
import { checkSpec } from '../lib/yaml.js';
import * as ui from '../ui.js';
import { EXIT_ERROR, EXIT_OK } from '../exit.js';

/**
 * Check a husk.yaml.
 *
 * Reports every problem at once. A validator that stops at the first error turns
 * one fix into six round trips, and the user learns nothing about the shape of
 * the file in between.
 */
export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {}, 'validate');
  ui.configure(values);

  const typed = positionals[0] ?? 'husk.yaml';
  const path = resolvePath(typed);

  if (values.json) {
    // A file that is missing or not YAML is invalid too, in the same shape.
    const result = await checkSpec(path).catch((err: unknown) => {
      if (err instanceof HuskError && err.code === 'E_SPEC_INVALID') return { ok: false as const, issues: [err.message] };
      throw err;
    });
    ui.json(result.ok ? { valid: true, path, spec: result.spec } : { valid: false, path, issues: result.issues });
    return result.ok ? EXIT_OK : EXIT_ERROR;
  }

  const result = await checkSpec(path);
  if (!result.ok) {
    ui.fail(`${typed} is not a valid husk`);
    for (const issue of result.issues) ui.note(`  ${ui.red('✗')} ${issue}`);
    ui.hint('`husk init --force` regenerates a valid file, or see `husk help init`');
    return EXIT_ERROR;
  }

  const spec = result.spec;
  ui.print(`${ui.green('✓')} ${ui.bold(spec.name)} ${ui.dim('is valid')}`);
  ui.print();
  ui.print(
    ui.fields([
      ['model', spec.model + (spec.fallbackModels.length ? ui.dim(`  → ${spec.fallbackModels.join(' → ')}`) : '')],
      ['tools', spec.tools.join(', ')],
      ['computer', spec.computer.enabled ? `${spec.computer.flavor}, network ${spec.computer.network.mode}` : ui.dim('disabled')],
      ['approvals', spec.guardrails.approvalMode],
      ['limits', `${spec.limits.maxSteps} steps · $${spec.limits.maxCostUsd} · ${spec.limits.timeoutSec}s`],
      ['triggers', spec.triggers.map((t) => t.type).join(', ')],
    ]),
  );
  return EXIT_OK;
}
