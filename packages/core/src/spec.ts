import { z } from 'zod';
import { HuskError } from './errors.js';

/**
 * husk.yaml -- the whole agent in one file.
 *
 * This is the artifact a chat becomes. It is portable, diffable, reviewable,
 * and it is the only thing the runtime needs in order to bring a bot up.
 */

export const NetworkPolicySchema = z.object({
  mode: z.enum(['none', 'egress', 'full']).default('egress'),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

export const ComputerConfigSchema = z.object({
  /** false disables the machine entirely; true accepts every default. */
  enabled: z.boolean().default(true),
  provider: z.string().optional(),
  flavor: z.enum(['base', 'python', 'node', 'full']).default('base'),
  image: z.string().optional(),
  cpus: z.number().positive().max(64).optional(),
  memoryMb: z.number().int().positive().max(131072).optional(),
  diskMb: z.number().int().positive().optional(),
  idleTimeoutSec: z.number().int().min(0).default(900),
  maxLifetimeSec: z.number().int().min(0).default(0),
  network: NetworkPolicySchema.default({ mode: 'egress' }),
  packages: z.array(z.string()).default([]),
  setup: z.string().optional(),
  env: z.record(z.string()).default({}),
  workdir: z.string().default('/work'),
  persist: z.boolean().default(false),
  mounts: z
    .array(z.object({ source: z.string(), target: z.string(), readonly: z.boolean().default(true) }))
    .default([]),
  /**
   * Unprivileged user inside the machine. Omitted means "whatever the provider
   * defaults to" (`husk` on the container images), which is why there is no
   * default here: writing one in would override a provider that knows better.
   */
  user: z.string().optional(),
  /**
   * Provider-specific configuration, carried through to `ComputerSpec.labels`.
   *
   * This is how a single husk.yaml points itself at a particular box or Fly app
   * without an environment variable: `husk.ssh`, `husk.ssh.key`, `husk.fly.app`,
   * `husk.fly.region`, `husk.fly.ports`. The ssh and fly providers read these
   * first and fall back to the environment.
   *
   * Optional rather than `.default({})` so a spec that never mentions labels
   * serialises exactly as it did before.
   */
  labels: z.record(z.string()).optional(),
});

export const LimitsSchema = z.object({
  maxSteps: z.number().int().positive().max(500).default(24),
  maxCostUsd: z.number().min(0).default(0.5),
  maxTokens: z.number().int().positive().default(200_000),
  timeoutSec: z.number().int().positive().default(300),
  /** Per-exec ceiling inside the machine. */
  execTimeoutSec: z.number().int().positive().default(120),
  maxOutputBytes: z.number().int().positive().default(262_144),
});

export const GuardrailsSchema = z.object({
  approvalMode: z.enum(['auto', 'ask', 'readonly']).default('auto'),
  /** Regexes matched against a shell command before it runs. */
  denyCommands: z.array(z.string()).default([]),
  allowCommands: z.array(z.string()).default([]),
  /** Refuse and explain, rather than answering. */
  refuse: z.array(z.string()).default([]),
  /** Strip credential-shaped strings from tool output before the model sees them. */
  redactSecrets: z.boolean().default(true),
});

export const TriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('http'),
    path: z.string().default('/'),
    auth: z.enum(['none', 'token']).default('token'),
  }),
  z.object({ type: z.literal('cron'), schedule: z.string(), prompt: z.string() }),
  z.object({
    type: z.literal('discord'),
    channels: z.array(z.string()).default([]),
    mentionOnly: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('slack'),
    channels: z.array(z.string()).default([]),
    mentionOnly: z.boolean().default(true),
  }),
  z.object({ type: z.literal('telegram'), allowlist: z.array(z.string()).default([]) }),
  z.object({ type: z.literal('webhook'), path: z.string(), secret: z.string().optional() }),
  z.object({ type: z.literal('cli') }),
]);

export const MemorySchema = z.object({
  enabled: z.boolean().default(false),
  backend: z.enum(['sqlite', 'memory', 'file']).default('sqlite'),
  /** Turns of raw history kept verbatim before older turns get summarised. */
  windowTurns: z.number().int().positive().default(20),
  summarise: z.boolean().default(true),
});

export const KnowledgeItemSchema = z.object({
  title: z.string(),
  content: z.string(),
  source: z.string().optional(),
});

export const ExampleSchema = z.object({
  user: z.string(),
  assistant: z.string(),
});

export const HuskSpecSchema = z.object({
  /** Schema version. Bumped only on breaking changes. */
  apiVersion: z.literal('husk/v1').default('husk/v1'),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be lowercase alphanumeric with dashes'),
  displayName: z.string().max(96).optional(),
  version: z.string().default('0.1.0'),
  description: z.string().max(280).default(''),
  /** Primary model, by alias or fully-qualified id. */
  model: z.string().default('auto'),
  /** Tried in order when the primary is unavailable, rate limited, or over budget. */
  fallbackModels: z.array(z.string()).default([]),
  temperature: z.number().min(0).max(2).optional(),
  /** The system prompt. Supports {{var}} interpolation from RunOptions.vars. */
  persona: z.string().default(''),
  knowledge: z.array(KnowledgeItemSchema).default([]),
  examples: z.array(ExampleSchema).default([]),
  /** Tool names, or the computer / files / web / http bundles. */
  tools: z.array(z.string()).default(['computer']),
  computer: ComputerConfigSchema.default({}),
  limits: LimitsSchema.default({}),
  guardrails: GuardrailsSchema.default({}),
  memory: MemorySchema.default({}),
  triggers: z.array(TriggerSchema).default([{ type: 'cli' }]),
  /** Free-form, carried through untouched. */
  metadata: z.record(z.unknown()).default({}),
  /** Provenance: which transcript this husk was distilled from. */
  origin: z
    .object({
      source: z.string(),
      transcriptId: z.string().optional(),
      importedAt: z.string().optional(),
      messageCount: z.number().optional(),
    })
    .optional(),
});

export type HuskSpec = z.infer<typeof HuskSpecSchema>;
export type HuskSpecInput = z.input<typeof HuskSpecSchema>;
export type ComputerConfig = z.infer<typeof ComputerConfigSchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type Guardrails = z.infer<typeof GuardrailsSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;

/** Parse and normalise. Throws a HuskError carrying every field-level problem. */
export function parseSpec(input: unknown): HuskSpec {
  const result = HuskSpecSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new HuskError('E_SPEC_INVALID', `husk.yaml is not valid:\n  ${issues.join('\n  ')}`, {
      hint: 'Run `husk validate` to see the expected shape, or `husk init` to regenerate.',
      details: { issues },
    });
  }
  return result.data;
}

export function safeParseSpec(
  input: unknown,
): { ok: true; spec: HuskSpec } | { ok: false; issues: string[] } {
  const result = HuskSpecSchema.safeParse(input);
  if (result.success) return { ok: true, spec: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

/** A minimal, valid husk. Used by `husk init` and by tests. */
export function defaultSpec(name: string): HuskSpec {
  return HuskSpecSchema.parse({
    name,
    displayName: name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description: 'A husk.',
    persona: 'You are a careful, concise assistant with access to a Linux computer.',
  });
}

/** Interpolate {{var}} placeholders in the persona. Unknown vars are left intact. */
export function renderPersona(spec: HuskSpec, vars: Record<string, string> = {}): string {
  const base = spec.persona.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
  const parts = [base];
  if (spec.knowledge.length) {
    parts.push('\n## Reference\n' + spec.knowledge.map((k) => `### ${k.title}\n${k.content}`).join('\n\n'));
  }
  if (spec.guardrails.refuse.length) {
    parts.push(
      '\n## Out of scope\nDecline these, briefly, and say what you can do instead:\n' +
        spec.guardrails.refuse.map((r) => `- ${r}`).join('\n'),
    );
  }
  return parts.join('\n').trim();
}
