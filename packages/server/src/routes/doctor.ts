import { existsSync } from 'node:fs';
import { ENV_KEYS, HUSK_VERSION, mapLimit, paths } from '@husk-ai/core';
import type { FastifyInstance } from 'fastify';
import { ctxOf } from '../context.js';
import { findOrphanedWorkspaces } from '@husk-ai/runtime';

/**
 * `GET /v1/doctor`.
 *
 * The wire shape is identical to what `husk doctor --json` prints and to
 * `DoctorReport` in `@husk-ai/sdk`. It diverged once -- the server answered
 * `selected` while the SDK read `selection` -- which meant the console rendered
 * an empty selection against a server that was reporting one correctly. One
 * shape, three consumers, no translation layer.
 */
export interface DoctorProvider {
  name: string;
  description: string;
  priority: number;
  available: boolean;
  /** null when the provider could not be probed at all. */
  isolated: boolean | null;
  /** kernel | machine | guardrails -- what the boundary actually is. */
  isolationKind?: 'kernel' | 'machine' | 'guardrails';
  version?: string;
  reason?: string;
  hint?: string;
}

export interface DoctorModelProvider {
  id: string;
  displayName: string;
  priority: number;
  available: boolean;
  reason?: string;
  hint?: string;
  envKey?: string;
  /** Model ids this provider can actually reach right now. */
  models: string[];
}

export interface DoctorReport {
  version: string;
  node: string;
  platform: string;
  huskHome: string;
  firstRun: boolean;
  providers: DoctorProvider[];
  models: DoctorModelProvider[];
  /** What husk would choose right now, and why it chose it. */
  selection: {
    provider: string | null;
    providerReason: string;
    isolated: boolean | null;
    model: string | null;
    modelReason: string;
  };
  warnings: string[];
}

const ENV_HINTS: Record<string, string> = {
  anthropic: 'set ANTHROPIC_API_KEY',
  openai: 'set OPENAI_API_KEY',
  google: 'set GOOGLE_API_KEY',
  groq: 'set GROQ_API_KEY',
  openrouter: 'set OPENROUTER_API_KEY',
  together: 'set TOGETHER_API_KEY',
  deepseek: 'set DEEPSEEK_API_KEY',
  mistral: 'set MISTRAL_API_KEY',
  cerebras: 'set CEREBRAS_API_KEY',
  ollama: 'install ollama and run `ollama pull qwen2.5:7b` for a free local model that can call tools',
  lmstudio: 'start LM Studio and enable its local server',
};

const ENV_KEY_BY_PROVIDER: Record<string, string | undefined> = {
  anthropic: ENV_KEYS.anthropic,
  openai: ENV_KEYS.openai,
  google: ENV_KEYS.google,
  groq: ENV_KEYS.groq,
  openrouter: ENV_KEYS.openrouter,
  together: ENV_KEYS.together,
  deepseek: ENV_KEYS.deepseek,
  mistral: ENV_KEYS.mistral,
  cerebras: ENV_KEYS.cerebras,
  ollama: ENV_KEYS.ollamaHost,
  lmstudio: ENV_KEYS.lmstudioHost,
};

export async function doctorRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);
  const { manager, modelProviders, config } = ctx.deps;

  app.get('/v1/doctor', async (): Promise<DoctorReport> => {
    const [providerStatuses, models] = await Promise.all([
      manager.status(false).catch(() => []),
      mapLimit(modelProviders, 4, async (p): Promise<DoctorModelProvider> => {
        const base: DoctorModelProvider = {
          id: p.id,
          displayName: p.displayName,
          priority: p.priority,
          available: false,
          models: [],
        };
        const envKey = ENV_KEY_BY_PROVIDER[p.id];
        if (envKey) base.envKey = envKey;
        try {
          const a = await p.isAvailable();
          base.available = a.available;
          if (a.reason) base.reason = a.reason;
          if (!a.available) base.hint = a.hint ?? ENV_HINTS[p.id] ?? `configure ${p.displayName}`;
          if (a.available) {
            // Only ask a reachable provider for its catalogue; listing against a
            // dead endpoint turns doctor into a pile of timeouts.
            base.models = (await p.listModels().catch(() => [])).map((m) => m.id).slice(0, 12);
          }
          return base;
        } catch (err) {
          base.reason = (err as Error).message;
          base.hint = ENV_HINTS[p.id];
          return base;
        }
      }),
    ]);

    const providers: DoctorProvider[] = providerStatuses.map((p) => {
      const out: DoctorProvider = {
        name: p.name,
        description: p.description,
        priority: p.priority,
        available: p.available,
        isolated: p.isolated ?? null,
        ...(p.isolationKind ? { isolationKind: p.isolationKind } : {}),
      };
      if (p.version) out.version = p.version;
      if (p.reason) out.reason = p.reason;
      if (p.hint) out.hint = p.hint;
      return out;
    });

    const firstProvider = providers.find((p) => p.available);
    const firstModelProvider = models.find((m) => m.available && m.models.length > 0) ?? models.find((m) => m.available);
    const firstModel = firstModelProvider?.models[0] ?? null;

    const warnings: string[] = [];
    if (!firstModelProvider) {
      warnings.push('no model provider is configured -- husk can run computers but not agents');
      const missing = Object.entries(ENV_KEYS)
        .filter(([, key]) => !process.env[key])
        .slice(0, 3)
        .map(([, key]) => key);
      if (missing.length) warnings.push(`none of ${missing.join(', ')} are set`);
    }
    if (!firstProvider) {
      warnings.push('no computer provider is usable -- run `husk doctor` locally for the reasons above');
    } else if (firstProvider.isolated === false) {
      warnings.push(
        `the ${firstProvider.name} provider gives process guardrails, not a sandbox -- do not run untrusted code on it`,
      );
    }
    if (!config.token) {
      warnings.push('HUSK_TOKEN is not set, so this server only accepts loopback connections');
    }

    // Disk a destroy failed to free. Worth surfacing here specifically because
    // the failure used to be silent: the computer disappeared from `husk ps`
    // while its workspace stayed behind, and a provisioned Chromium is 325 MB
    // of that. Nothing else in husk would ever mention it.
    const orphans = await findOrphanedWorkspaces().catch(() => [] as string[]);
    if (orphans.length > 0) {
      warnings.push(
        `${orphans.length} workspace${orphans.length === 1 ? '' : 's'} in ${paths().workspaces} ` +
          `${orphans.length === 1 ? 'belongs' : 'belong'} to no computer -- ` +
          'left by a destroy that could not remove its files',
      );
    }

    return {
      version: HUSK_VERSION,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      huskHome: paths().root,
      firstRun: !existsSync(paths().root),
      providers,
      models,
      selection: {
        provider: firstProvider?.name ?? null,
        providerReason: firstProvider
          ? `highest-priority available provider (${firstProvider.priority})`
          : 'nothing available',
        isolated: firstProvider?.isolated ?? null,
        model: firstModel,
        modelReason: firstModel
          ? `first reachable model on ${firstModelProvider?.displayName ?? 'the selected provider'}`
          : 'no model provider is reachable',
      },
      warnings,
    };
  });
}
