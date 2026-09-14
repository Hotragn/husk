import { existsSync } from 'node:fs';
import { ENV_KEYS, HUSK_VERSION, huskHome } from '@husk/core';
import type { ModelInfo, ModelProvider } from '@husk/core';
import { parse } from '../args.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';
import { paths } from '@husk/core';
import { findOrphanedWorkspaces } from '@husk/runtime';

/**
 * The command people run when they are confused, so it must never be confusing.
 *
 * It answers four questions in order: what can run a computer, what can run a
 * model, what would husk pick right now, and what is wrong. Every unavailable
 * thing carries the reason it is unavailable and the one command that fixes it.
 * A doctor that says "not available" and stops has wasted the user's time.
 */

export interface ProviderRow {
  name: string;
  description: string;
  priority: number;
  available: boolean;
  isolated: boolean | null;
  /** kernel | machine | guardrails -- what the boundary actually is. */
  isolationKind?: 'kernel' | 'machine' | 'guardrails';
  version?: string;
  reason?: string;
  hint?: string;
}

export interface ModelRow {
  id: string;
  displayName: string;
  priority: number;
  available: boolean;
  reason?: string;
  hint?: string;
  envKey?: string;
  implemented: boolean;
  models: string[];
}

export interface DoctorReport {
  version: string;
  node: string;
  platform: string;
  huskHome: string;
  firstRun: boolean;
  providers: ProviderRow[];
  models: ModelRow[];
  selection: {
    provider: string | null;
    providerReason: string;
    isolated: boolean | null;
    model: string | null;
    modelReason: string;
  };
  warnings: string[];
}

/**
 * Providers named in the build contract.
 *
 * The list exists so that a provider is reported even when it is not built --
 * silently omitting one makes a user with a GROQ_API_KEY sitting right there
 * wonder why husk cannot see it. Anything `@husk/models` implements is probed
 * for real; anything it does not is labelled as such.
 */
const DECLARED_MODEL_PROVIDERS: Array<{ id: string; displayName: string; envKey?: string }> = [
  { id: 'anthropic', displayName: 'Anthropic', envKey: ENV_KEYS.anthropic },
  { id: 'openai', displayName: 'OpenAI', envKey: ENV_KEYS.openai },
  { id: 'google', displayName: 'Google', envKey: ENV_KEYS.google },
  { id: 'groq', displayName: 'Groq', envKey: ENV_KEYS.groq },
  { id: 'openrouter', displayName: 'OpenRouter', envKey: ENV_KEYS.openrouter },
  { id: 'deepseek', displayName: 'DeepSeek', envKey: ENV_KEYS.deepseek },
  { id: 'mistral', displayName: 'Mistral', envKey: ENV_KEYS.mistral },
  { id: 'cerebras', displayName: 'Cerebras', envKey: ENV_KEYS.cerebras },
  { id: 'together', displayName: 'Together AI', envKey: ENV_KEYS.together },
  { id: 'ollama', displayName: 'Ollama', envKey: ENV_KEYS.ollamaHost },
  { id: 'lmstudio', displayName: 'LM Studio', envKey: ENV_KEYS.lmstudioHost },
];

export async function collect(force = false): Promise<DoctorReport> {
  const firstRun = !existsSync(huskHome());
  const [providers, models] = await Promise.all([collectProviders(force), collectModels()]);

  const chosen = providers.find((p) => p.available);
  const chosenModel = models.find((m) => m.available && m.models.length > 0);

  const warnings: string[] = [];

  if (!chosen) {
    warnings.push('No computer provider is usable. That should be impossible — the local provider is always available.');
  } else if (chosen.isolated === false) {
    warnings.push(
      `The "${chosen.name}" provider gives guardrails, not isolation. A prompt-injected model is closer to an adversary than to an accident — start Docker before running anything you did not write.`,
    );
  }

  const docker = providers.find((p) => p.name === 'docker');
  if (docker && !docker.available && /daemon/.test(docker.reason ?? '')) {
    warnings.push('Docker is installed but its daemon is not running, so husk is falling back to weaker isolation.');
  }

  if (!chosenModel) {
    warnings.push(
      // Named explicitly because the largest group of users never needs a model:
      // via `husk mcp`, Claude Code or Codex brings its own, and husk supplies
      // only the computer. Telling them to pull 4.7 GB would be wrong.
      'No model is reachable, so `husk run` and model-backed `husk distill` will fail. Everything else works: `husk mcp` needs no model (your MCP client brings its own), computers run, and `husk distill --no-model` still produces a husk.yaml.',
    );
  }

  const major = Number(process.versions.node.split('.')[0] ?? 0);
  if (major < 20) warnings.push(`Node ${process.versions.node} is below the supported floor of 20.10.`);

  if (process.platform === 'win32' && chosen?.name === 'local' && !/wsl/i.test(chosen.version ?? '')) {
    warnings.push(
      'On Windows without WSL, the local provider runs commands in the Windows shell — it is not a Linux computer. `wsl --install` fixes it.',
    );
  }

  // Disk that a failed destroy left behind. This is the only place husk will
  // ever mention it: the computer is already gone from `husk ps`, so without
  // this the workspace is invisible and permanent. A provisioned Chromium is
  // 325 MB apiece.
  const orphans = await findOrphanedWorkspaces().catch(() => [] as string[]);
  if (orphans.length > 0) {
    warnings.push(
      `${orphans.length} workspace${orphans.length === 1 ? '' : 's'} under ${paths().workspaces} ` +
        `${orphans.length === 1 ? 'belongs' : 'belong'} to no computer — ` +
        'left by a destroy that could not remove its files. Delete them to reclaim the space.',
    );
  }

  return {
    version: HUSK_VERSION,
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    huskHome: huskHome(),
    firstRun,
    providers,
    models,
    selection: {
      provider: chosen?.name ?? null,
      providerReason: chosen
        ? `highest-priority available provider (${chosen.priority})`
        : 'nothing available',
      isolated: chosen?.isolated ?? null,
      model: chosenModel ? (chosenModel.models[0] ?? null) : null,
      modelReason: chosenModel
        ? `first reachable model on ${chosenModel.displayName}`
        : 'no provider has credentials or is listening',
    },
    warnings,
  };
}

async function collectProviders(force: boolean): Promise<ProviderRow[]> {
  const { ComputerManager } = await import('@husk/runtime');
  const status = await new ComputerManager().status(force);
  return status.map((s) => ({
    name: String(s.name),
    description: s.description,
    priority: s.priority,
    available: s.available,
    isolated: s.isolated ?? null,
    isolationKind: s.isolationKind,
    version: s.version,
    reason: s.reason,
    hint: s.hint,
  }));
}

async function collectModels(): Promise<ModelRow[]> {
  const mod = await import('@husk/models');
  // Ask the package what it implements. A hardcoded list here once reported six
  // working providers as "not implemented" for a whole release.
  const built = new Map<string, ModelProvider>();
  for (const p of mod.defaultProviders()) built.set(p.id, p);

  const rows: ModelRow[] = [];
  for (const declared of DECLARED_MODEL_PROVIDERS) {
    const impl = built.get(declared.id);
    if (!impl) {
      const keySet = declared.envKey ? process.env[declared.envKey] !== undefined : false;
      rows.push({
        ...declared,
        priority: 0,
        available: false,
        implemented: false,
        reason: keySet
          ? `${declared.envKey} is set, but @husk/models has no ${declared.id} provider yet`
          : 'not implemented in @husk/models yet',
        hint: 'use anthropic, openai, or ollama until this provider lands',
        models: [],
      });
      continue;
    }

    let available = false;
    let reason: string | undefined;
    let hint: string | undefined;
    let models: ModelInfo[] = [];
    try {
      const a = await impl.isAvailable();
      available = a.available;
      reason = a.reason;
      hint = a.hint;
      if (available) models = await impl.listModels().catch(() => []);
    } catch (err) {
      reason = `probe failed: ${(err as Error).message}`;
      hint = 'this usually means the endpoint is up but speaking a different protocol';
    }

    rows.push({
      id: impl.id,
      displayName: impl.displayName,
      priority: impl.priority,
      available,
      reason,
      hint,
      envKey: declared.envKey,
      implemented: true,
      models: models.map((m) => m.id),
    });
  }

  return rows.sort((a, b) => Number(b.available) - Number(a.available) || b.priority - a.priority);
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, { force: { type: 'boolean', default: false } }, 'doctor');
  ui.configure(values);

  const spin = ui.spinner('probing providers');
  const report = await collect(values.force === true).finally(() => spin.stop());

  if (values.json) {
    ui.json(report);
    return EXIT_OK;
  }

  ui.print(ui.heading('husk') + ` ${report.version}  ${ui.dim(`node ${report.node} · ${report.platform}`)}`);
  ui.print(ui.dim(`state: ${report.huskHome}${report.firstRun ? '  (not created yet)' : ''}`));
  ui.print();

  ui.print(ui.heading('COMPUTERS'));
  for (const p of report.providers) {
    // A plain green "isolated" is a claim, so only kernel isolation gets one.
    // An ssh box is isolated from this laptop and not from itself; saying that in
    // the badge costs three words and prevents a genuine misreading.
    const isolation =
      p.isolationKind === 'kernel'
        ? ui.green('isolated')
        : p.isolationKind === 'machine'
          ? ui.green('isolated') + ui.dim(' from this machine')
          : p.isolationKind === 'guardrails'
            ? ui.yellow('not isolated')
            : p.isolated === null
              ? ''
              : p.isolated
                ? ui.green('isolated')
                : ui.yellow('not isolated');
    ui.print(`  ${ui.mark(p.available)} ${ui.bold(p.name.padEnd(8))} ${isolation}`);
    ui.print(`      ${ui.dim(p.description)}`);
    if (p.version) ui.print(`      ${ui.dim('via ' + p.version)}`);
    if (p.reason) ui.print(`      ${p.available ? ui.dim(p.reason) : ui.yellow(p.reason)}`);
    if (p.hint && !p.available) ui.print(`      ${ui.dim('fix: ' + p.hint)}`);
  }
  ui.print();

  ui.print(ui.heading('MODELS'));
  for (const m of report.models) {
    const label = m.implemented ? m.id : `${m.id} ${ui.dim('(not implemented)')}`;
    ui.print(`  ${ui.mark(m.implemented ? m.available : null)} ${ui.bold(label)}`);
    if (m.available && m.models.length) {
      ui.print(`      ${ui.dim(m.models.slice(0, 4).join(', ') + (m.models.length > 4 ? `, +${m.models.length - 4} more` : ''))}`);
    } else if (m.reason) {
      ui.print(`      ${ui.dim(m.reason)}`);
      if (m.hint) ui.print(`      ${ui.dim('fix: ' + m.hint)}`);
    }
  }
  ui.print();

  ui.print(ui.heading('SELECTION') + ui.dim('  what husk would use right now'));
  ui.print(
    ui.fields([
      ['computer', report.selection.provider ? `${report.selection.provider}  ${ui.dim(report.selection.providerReason)}` : ui.red('none')],
      [
        'isolation',
        report.selection.isolated === null
          ? ui.dim('unknown')
          : report.selection.isolated
            ? ui.green('kernel-level')
            : ui.yellow('guardrails only'),
      ],
      ['model', report.selection.model ? `${report.selection.model}  ${ui.dim(report.selection.modelReason)}` : ui.yellow('none — computers still work')],
    ]),
  );
  ui.print();

  if (report.warnings.length) {
    ui.print(ui.heading('WARNINGS'));
    for (const w of report.warnings) ui.print(`  ${ui.yellow('!')} ${w}`);
    ui.print();
  }

  ui.print(ui.dim('husk sends nothing anywhere except the model provider you configure. There is no telemetry.'));

  // Doctor reports; it does not fail. A script asking "is docker up?" should read
  // the JSON, not infer it from an exit code that also means "husk crashed".
  return EXIT_OK;
}
