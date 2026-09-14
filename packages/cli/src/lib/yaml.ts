import { readFile } from 'node:fs/promises';
import { HuskError, defaultSpec, parseSpec, safeParseSpec } from '@husk-ai/core';
import type { DistilledAgent, HuskSpec, Transcript } from '@husk-ai/core';
import { toSpec } from '@husk-ai/sessions';
import type { ToSpecOverrides } from '@husk-ai/sessions';

/**
 * husk.yaml, read and written.
 *
 * Writing is hand-rolled rather than handed to `yaml.stringify`, because this
 * file is the product's unit of value and it is optimised for a human reviewing
 * a diff: a deliberate key order, block scalars for prose, and a provenance
 * header. A generic serialiser gives none of that and reorders keys on a whim.
 * Reading still goes through the real parser -- guessing at YAML is how you ship
 * a security bug.
 */

export async function readYamlFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new HuskError('E_SPEC_INVALID', `no husk.yaml at ${path}`, {
        hint: 'run `husk init` to scaffold one, or pass the path explicitly',
        cause: err,
      });
    }
    throw err;
  }
  return parseYaml(text, path);
}

export async function parseYaml(text: string, origin = '<input>'): Promise<unknown> {
  const { parse } = await import('yaml');
  try {
    return parse(text);
  } catch (err) {
    throw new HuskError('E_SPEC_INVALID', `${origin} is not valid YAML: ${(err as Error).message.split('\n')[0]}`, {
      hint: 'check the indentation -- YAML wants spaces, never tabs',
      cause: err,
    });
  }
}

/** Read and validate in one step. Throws E_SPEC_INVALID listing every problem. */
export async function loadSpec(path: string): Promise<HuskSpec> {
  return parseSpec(await readYamlFile(path));
}

export async function checkSpec(path: string): Promise<{ ok: true; spec: HuskSpec } | { ok: false; issues: string[] }> {
  return safeParseSpec(await readYamlFile(path));
}

const SCALAR_SAFE = /^[A-Za-z0-9_][A-Za-z0-9 ._\-/@]*$/;

function scalar(value: string): string {
  if (value === '') return "''";
  if (SCALAR_SAFE.test(value) && !/^(y|n|yes|no|true|false|on|off|null|~)$/i.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * A block scalar, which is what makes a persona reviewable in a diff.
 *
 * `|-` rather than `|`: the clip indicator keeps a trailing newline, so a
 * persona would grow a `\n` every time the file was written and re-read. Strip
 * makes the round trip exact.
 */
function block(key: string, value: string, indent: string): string[] {
  const lines = value.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  if (lines.length <= 1 && (lines[0] ?? '').length < 72) {
    return [`${indent}${key}: ${scalar(lines[0] ?? '')}`];
  }
  return [`${indent}${key}: |-`, ...lines.map((l) => `${indent}  ${l}`.trimEnd())];
}

export interface RenderOptions {
  /** Provenance header lines, written as comments above the document. */
  provenance?: string[];
}

/**
 * Render a spec as reviewable YAML.
 *
 * Only fields that differ from the schema default are written. A 200-line file
 * of defaults nobody chose is not a spec, it is noise -- and it makes the one
 * line the user did change impossible to spot in a diff.
 */
export function renderSpec(spec: HuskSpec, opts: RenderOptions = {}): string {
  const base = defaultSpec(spec.name);
  const out: string[] = [];

  if (opts.provenance?.length) {
    for (const line of opts.provenance) out.push(`# ${line}`);
    out.push('');
  }

  out.push(`apiVersion: ${spec.apiVersion}`);
  out.push(`name: ${scalar(spec.name)}`);
  if (spec.displayName) out.push(`displayName: ${scalar(spec.displayName)}`);
  if (spec.version !== base.version) out.push(`version: ${scalar(spec.version)}`);
  if (spec.description) out.push(`description: ${scalar(spec.description)}`);
  out.push('');

  out.push(`model: ${scalar(spec.model)}`);
  if (spec.fallbackModels.length) {
    out.push('fallbackModels:');
    for (const m of spec.fallbackModels) out.push(`  - ${scalar(m)}`);
  }
  if (spec.temperature !== undefined) out.push(`temperature: ${spec.temperature}`);
  out.push('');

  out.push(...block('persona', spec.persona, ''));
  out.push('');

  out.push('tools:');
  for (const t of spec.tools) out.push(`  - ${scalar(t)}`);
  out.push('');

  if (spec.knowledge.length) {
    out.push('knowledge:');
    for (const k of spec.knowledge) {
      out.push(`  - title: ${scalar(k.title)}`);
      if (k.source) out.push(`    source: ${scalar(k.source)}`);
      out.push(...block('content', k.content, '    '));
    }
    out.push('');
  }

  if (spec.examples.length) {
    out.push('examples:');
    for (const e of spec.examples) {
      const [first, ...restUser] = block('user', e.user, '    ');
      out.push(`  -${(first as string).slice(3)}`);
      out.push(...restUser);
      out.push(...block('assistant', e.assistant, '    '));
    }
    out.push('');
  }

  const computer = diffObject(spec.computer, base.computer);
  if (Object.keys(computer).length) {
    out.push('computer:');
    out.push(...renderMap(computer, '  '));
    out.push('');
  }

  const limits = diffObject(spec.limits, base.limits);
  if (Object.keys(limits).length) {
    out.push('limits:');
    out.push(...renderMap(limits, '  '));
    out.push('');
  }

  const guardrails = diffObject(spec.guardrails, base.guardrails);
  if (Object.keys(guardrails).length) {
    out.push('guardrails:');
    out.push(...renderMap(guardrails, '  '));
    out.push('');
  }

  if (spec.memory.enabled) {
    out.push('memory:');
    out.push(...renderMap(diffObject(spec.memory, base.memory), '  '));
    out.push('');
  }

  const triggers = JSON.stringify(spec.triggers) !== JSON.stringify(base.triggers);
  if (triggers) {
    out.push('triggers:');
    for (const t of spec.triggers) {
      const entries = Object.entries(t as Record<string, unknown>);
      const [firstKey, firstValue] = entries[0] as [string, unknown];
      out.push(`  - ${firstKey}: ${renderValue(firstValue)}`);
      for (const [k, v] of entries.slice(1)) out.push(...renderEntry(k, v, '    '));
    }
    out.push('');
  }

  if (spec.origin) {
    out.push('origin:');
    out.push(...renderMap(spec.origin as Record<string, unknown>, '  '));
    out.push('');
  }

  if (Object.keys(spec.metadata).length) {
    out.push('metadata:');
    out.push(...renderMap(spec.metadata, '  '));
    out.push('');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function diffObject(value: Record<string, unknown>, base: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (JSON.stringify(v) === JSON.stringify(base[k])) continue;
    out[k] = v;
  }
  return out;
}

function renderMap(obj: Record<string, unknown>, indent: string): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) out.push(...renderEntry(k, v, indent));
  return out;
}

function renderEntry(key: string, value: unknown, indent: string): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    if (!value.length) return [];
    return [`${indent}${key}:`, ...value.map((v) => `${indent}  - ${renderValue(v)}`)];
  }
  if (value !== null && typeof value === 'object') {
    const inner = renderMap(value as Record<string, unknown>, indent + '  ');
    return inner.length ? [`${indent}${key}:`, ...inner] : [];
  }
  if (typeof value === 'string' && value.includes('\n')) return block(key, value, indent);
  return [`${indent}${key}: ${renderValue(value)}`];
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return scalar(value);
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * A DistilledAgent is not a HuskSpec, and the gap is where bugs live.
 *
 * The mapping itself lives in `@husk-ai/sessions.toSpec` and is shared with
 * `POST /v1/sessions/distill`. This wrapper exists only to apply the CLI's
 * flags -- `--name`, `--model` -- and the transcript it already has in hand.
 * When it had its own copy of the mapping, `husk distill` and the control plane
 * wrote different `metadata` keys for the same husk.
 */
export function specFromDistilled(
  agent: DistilledAgent,
  opts: { name?: string; model?: string; transcript?: Transcript; origin?: HuskSpec['origin'] } = {},
): HuskSpec {
  const overrides: ToSpecOverrides = {};
  if (opts.transcript) overrides.transcript = opts.transcript;
  if (opts.name) {
    overrides.name = slugName(opts.name);
    overrides.displayName = opts.name.slice(0, 96);
  }
  if (opts.model) overrides.model = opts.model;
  if (opts.origin) overrides.origin = opts.origin;
  return toSpec(agent, overrides);
}

/** The schema wants `^[a-z0-9][a-z0-9-]*$`; a distilled title rarely is one. */
export function slugName(input: string): string {
  const s = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return /^[a-z0-9]/.test(s) ? s : `husk-${s}`.slice(0, 64).replace(/-+$/, '') || 'husk';
}
