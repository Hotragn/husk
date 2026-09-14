import type { ModelInfo } from '@husk/core';
import { parse } from '../args.js';
import { buildProviders } from '../lib/models.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

interface Row extends ModelInfo {
  reachable: boolean;
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, { all: { type: 'boolean', default: false } }, 'models');
  ui.configure(values);

  const spin = ui.spinner('checking model providers');
  const providers = await buildProviders();
  const rows: Row[] = [];
  const offline: Array<{ id: string; reason: string; hint?: string }> = [];

  for (const p of providers) {
    const a = await p.isAvailable().catch((e: Error) => ({ available: false, reason: e.message, hint: undefined }));
    if (!a.available) {
      offline.push({ id: p.id, reason: a.reason ?? 'unavailable', hint: a.hint });
      if (!values.all) continue;
    }
    const models = await p.listModels().catch(() => [] as ModelInfo[]);
    for (const m of models) rows.push({ ...m, reachable: a.available });
  }
  spin.stop();

  if (values.json) {
    ui.json(rows);
    return EXIT_OK;
  }

  if (!rows.length) {
    ui.print(ui.dim('no models reachable'));
    ui.note('');
    for (const o of offline) {
      ui.note(`  ${ui.mark(false)} ${ui.bold(o.id)} ${ui.dim(o.reason)}`);
      if (o.hint) ui.note(`      ${ui.dim('fix: ' + o.hint)}`);
    }
    ui.note('');
    ui.note(ui.dim('The free path: install Ollama, run `ollama pull qwen2.5:7b`, and try again.'));
    ui.note(ui.dim('Computers work with no model at all — `husk up` needs nothing.'));
    return EXIT_OK;
  }

  ui.print(
    ui.table(
      [
        { header: 'id', max: 44 },
        { header: 'context', max: 9 },
        { header: 'tools', max: 5 },
        { header: 'cost /Mtok', max: 16 },
        { header: '', max: 3 },
      ],
      rows.map((m) => [
        m.reachable ? m.id : ui.dim(m.id),
        formatContext(m.contextWindow),
        m.supportsTools ? 'yes' : ui.dim('no'),
        price(m),
        m.reachable ? '' : ui.dim('offline'),
      ]),
    ),
  );

  if (offline.length && !values.all) {
    ui.note('');
    ui.note(ui.dim(`not shown: ${offline.map((o) => `${o.id} (${o.reason})`).join(', ')} — use --all`));
  }

  return EXIT_OK;
}

function formatContext(n: number): string {
  if (!n) return '-';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function price(m: ModelInfo): string {
  if (m.free || !m.pricing) return ui.green('free');
  return `$${m.pricing.inputPerMTok} in / $${m.pricing.outputPerMTok} out`;
}
