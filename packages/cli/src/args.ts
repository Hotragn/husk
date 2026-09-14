import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';

/** A usage mistake, not a runtime failure. Exits 2 and prints the command's help. */
export class UsageError extends Error {
  readonly command: string | undefined;
  constructor(message: string, command?: string) {
    super(message);
    this.name = 'UsageError';
    this.command = command;
  }
}

export type OptionConfig = NonNullable<ParseArgsConfig['options']>;

/** Flags every command accepts. Their meaning never changes between commands. */
export const GLOBAL_OPTIONS = {
  json: { type: 'boolean', default: false },
  quiet: { type: 'boolean', short: 'q', default: false },
  debug: { type: 'boolean', default: false },
  color: { type: 'boolean' },
  'no-color': { type: 'boolean', default: false },
  yes: { type: 'boolean', short: 'y', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const satisfies OptionConfig;

export interface GlobalFlags {
  json: boolean;
  quiet: boolean;
  debug: boolean;
  color: boolean | undefined;
  yes: boolean;
  help: boolean;
}

export interface Parsed<V = Record<string, unknown>> {
  values: V & GlobalFlags;
  positionals: string[];
  /** Everything after a bare `--`. Empty when there was none. */
  rest: string[];
  /** True when the argv actually contained a bare `--`. */
  hasRest: boolean;
}

/**
 * Split argv at the first bare `--`.
 *
 * Node's parseArgs folds everything after `--` into positionals, which loses the
 * boundary -- and `husk exec box -- ls -la` depends on that boundary to know that
 * `-la` belongs to `ls`, not to husk. So the split happens before parsing.
 */
export function splitRest(argv: string[]): { head: string[]; rest: string[]; hasRest: boolean } {
  const i = argv.indexOf('--');
  if (i === -1) return { head: argv, rest: [], hasRest: false };
  return { head: argv.slice(0, i), rest: argv.slice(i + 1), hasRest: true };
}

/**
 * Parse one command's argv.
 *
 * Strict on purpose: a typo'd flag is a usage error, not a silently ignored
 * string. Guessing what `--jsno` meant is how a script quietly stops emitting
 * JSON and nobody notices for a week.
 */
export function parse<V = Record<string, unknown>>(
  argv: string[],
  options: OptionConfig = {},
  command?: string,
): Parsed<V> {
  const { head, rest, hasRest } = splitRest(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: head,
      options: { ...GLOBAL_OPTIONS, ...options },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(cleanParseError((err as Error).message), command);
  }

  const values = parsed.values as Record<string, unknown>;
  const color = values['no-color'] === true ? false : (values.color as boolean | undefined);

  return {
    values: {
      ...(values as V),
      json: values.json === true,
      quiet: values.quiet === true,
      debug: values.debug === true,
      color,
      yes: values.yes === true,
      help: values.help === true,
    } as V & GlobalFlags,
    positionals: parsed.positionals,
    rest,
    hasRest,
  };
}

/** parseArgs messages are decent but shout about internals. Trim to the useful part. */
function cleanParseError(message: string): string {
  const unknown = /Unknown option '([^']+)'/.exec(message);
  if (unknown) return `unknown flag ${unknown[1]} -- run with --help to see what this command accepts`;
  const needsValue = /Option '([^']+)' argument missing/.exec(message);
  if (needsValue) return `${needsValue[1]} needs a value`;
  return message.replace(/\.\s*To specify.*$/s, '').trim().toLowerCase();
}

/** Positional at `index`, or a usage error naming what was expected. */
export function required(positionals: string[], index: number, name: string, command: string): string {
  const v = positionals[index];
  if (v === undefined || v === '') throw new UsageError(`missing <${name}>`, command);
  return v;
}

/** Accept 2g / 512m / 2048 (MB) and reject anything else loudly. */
export function parseMemory(input: string | undefined, command: string): number | undefined {
  if (input === undefined) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(g|gb|m|mb)?$/i.exec(input.trim());
  if (!m) throw new UsageError(`--memory expects a size like 2g, 512m, or a plain number of MB (got "${input}")`, command);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  const mb = unit.startsWith('g') ? n * 1024 : n;
  if (!Number.isFinite(mb) || mb <= 0) throw new UsageError(`--memory must be positive (got "${input}")`, command);
  return Math.round(mb);
}

export function parseCount(input: string | undefined, flag: string, command: string): number | undefined {
  if (input === undefined) return undefined;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} expects a positive number (got "${input}")`, command);
  return n;
}

/**
 * A money amount, where zero is a meaningful answer.
 *
 * Separate from `parseCount` because `--max-cost 0` is a real instruction --
 * "spend nothing, use a local model" -- while `--max-steps 0` is nonsense.
 * The important half is rejecting junk: `Number('abc')` is NaN, every
 * `projected > NaN` comparison is false, and the spend ceiling silently stops
 * existing.
 */
export function parseAmount(input: string | undefined, flag: string, command: string): number | undefined {
  if (input === undefined) return undefined;
  const trimmed = input.trim().replace(/^\$/, '');
  const n = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(n) || n < 0) {
    throw new UsageError(`${flag} expects a non-negative number of US dollars (got "${input}")`, command);
  }
  return n;
}

export function parseChoice<T extends string>(
  input: string | undefined,
  choices: readonly T[],
  flag: string,
  command: string,
): T | undefined {
  if (input === undefined) return undefined;
  if (!(choices as readonly string[]).includes(input)) {
    throw new UsageError(`${flag} must be one of ${choices.join(', ')} (got "${input}")`, command);
  }
  return input as T;
}

/** `--env K=V --env K2=V2` into an object. */
export function parseEnvPairs(input: string[] | undefined, command: string): Record<string, string> | undefined {
  if (!input?.length) return undefined;
  const out: Record<string, string> = {};
  for (const pair of input) {
    const i = pair.indexOf('=');
    if (i <= 0) throw new UsageError(`--env expects KEY=VALUE (got "${pair}")`, command);
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

/**
 * Split `name:/path` into its two halves.
 *
 * The Windows trap: `C:\work\a.txt` looks exactly like a remote reference. A
 * single-character prefix is always a drive letter -- no computer name is one
 * character -- so that case resolves to a local path, and `husk cp C:\a.txt
 * box:/work/` does what a Windows user expects.
 */
export function splitRemote(input: string): { name: string; path: string } | null {
  const i = input.indexOf(':');
  if (i <= 0) return null;
  const name = input.slice(0, i);
  const path = input.slice(i + 1);
  if (name.length === 1) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  if (path === '') return null;
  // `http://...` parses as name "http", path "//..." by shape alone. The `//`
  // is a URL scheme separator, and no in-computer path starts with it.
  if (path.startsWith('//')) return null;
  return { name, path };
}
