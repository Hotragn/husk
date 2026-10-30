import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { HuskError } from './errors.js';
import type { BrowserEngine } from './types/computer.js';

/**
 * Where Husk keeps its state.
 *
 * Everything lives under one directory so a user can delete it in one move,
 * back it up in one move, and see exactly what we are storing.
 */
export interface HuskPaths {
  /** Root: $HUSK_HOME, else ~/.husk */
  root: string;
  /** Registered husks, one directory per husk. */
  husks: string;
  /** Computer bookkeeping (metadata, not filesystems). */
  computers: string;
  /** Working directories for the `local` provider. */
  workspaces: string;
  /** Run transcripts and traces. */
  runs: string;
  /** Imported transcripts, cached. */
  transcripts: string;
  /** SQLite databases. */
  data: string;
  /** Downloaded assets, snapshot tarballs. */
  cache: string;
  /** Long-lived config: husk.config.json, credentials pointer. */
  configFile: string;
  /** Local overrides that must never be committed. */
  envFile: string;
}

export function huskHome(): string {
  return process.env.HUSK_HOME ? resolve(process.env.HUSK_HOME) : join(homedir(), '.husk');
}

export function paths(): HuskPaths {
  const root = huskHome();
  return {
    root,
    husks: join(root, 'husks'),
    computers: join(root, 'computers'),
    workspaces: join(root, 'workspaces'),
    runs: join(root, 'runs'),
    transcripts: join(root, 'transcripts'),
    data: join(root, 'data'),
    cache: join(root, 'cache'),
    configFile: join(root, 'config.json'),
    envFile: join(root, '.env'),
  };
}

/** Create every directory Husk expects. Safe to call repeatedly. */
export function ensurePaths(p: HuskPaths = paths()): HuskPaths {
  for (const dir of [p.root, p.husks, p.computers, p.workspaces, p.runs, p.transcripts, p.data, p.cache]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return p;
}

/** Global settings, read from ~/.husk/config.json and the environment. */
export interface HuskConfig {
  /** Preferred computer provider. 'auto' picks the best available. */
  provider: string;
  /** The browser a computer runs when it does not say: `chrome`, or the lighter `lightpanda`. */
  browser: BrowserEngine;
  /** Preferred model alias. 'auto' picks the best available. */
  model: string;
  /** Control-plane bind address for `husk serve`. */
  host: string;
  port: number;
  /** Refuse to spend more than this on a single run, whatever the husk says. */
  maxCostUsd: number;
  /** Hard cap on concurrently running computers. */
  maxComputers: number;
  /** Send nothing anywhere except the model provider you configured. */
  telemetry: false;
  logLevel: string;
  /** Registry of aliases the user has pinned, e.g. { fast: 'groq/llama-3.3-70b' }. */
  modelAliases: Record<string, string>;
}

export const DEFAULT_CONFIG: HuskConfig = {
  provider: 'auto',
  browser: 'chrome',
  model: 'auto',
  host: '127.0.0.1',
  port: 7377,
  maxCostUsd: 5,
  maxComputers: 8,
  telemetry: false,
  logLevel: 'info',
  modelAliases: {},
};

/** What ~/.husk/config.json may set. A key it does not know is refused: a setting that silently does nothing is the bug. */
const ConfigFileSchema = z
  .object({
    provider: z.string().min(1),
    browser: z.enum(['chrome', 'lightpanda']),
    model: z.string().min(1),
    maxCostUsd: z.number().nonnegative(),
    maxComputers: z.number().int().positive(),
    modelAliases: z.record(z.string(), z.string()),
  })
  .partial()
  .strict();

/**
 * ~/.husk/config.json over the defaults.
 *
 * No file is the defaults. A file that is not JSON, or a setting of the wrong
 * type, is refused with its name rather than read as a default nobody asked
 * for. `model` is what `auto` means on this machine, so it is folded into
 * `modelAliases` here, and every consumer reads aliases alone; an `auto` entry
 * in `modelAliases` wins over it.
 */
export function loadConfig(file: string = paths().configFile): HuskConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CONFIG, modelAliases: {} };
    throw new HuskError('E_CONFIG', `could not read ${file}: ${(err as Error).message}`, { hint: 'check its permissions, or move it aside to use the defaults' });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new HuskError('E_CONFIG', `${file} is not valid JSON: ${(err as Error).message}`, { hint: 'fix it, or move it aside to use the defaults' });
  }
  const parsed = ConfigFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HuskError('E_CONFIG', `${file}: ${issue?.path.join('.') || 'the file'}: ${issue?.message}`, {
      hint: 'it takes provider, browser, model, maxCostUsd, maxComputers and modelAliases',
    });
  }
  const { model, modelAliases, ...rest } = parsed.data;
  return {
    ...DEFAULT_CONFIG,
    ...rest,
    ...(model ? { model } : {}),
    modelAliases: { ...(model && model !== 'auto' ? { auto: model } : {}), ...modelAliases },
  };
}

/**
 * ~/.husk/.env into `env`, for the keys `env` does not have yet: the
 * environment Husk was started with wins. `KEY=value` lines, with `#`
 * comments, `export ` and quotes allowed. Returns the keys it set, never a
 * value: the file is for API keys.
 */
export function loadEnvFile(file: string = paths().envFile, env: NodeJS.ProcessEnv = process.env): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new HuskError('E_CONFIG', `could not read ${file}: ${(err as Error).message}`, { hint: 'check its permissions, or move it aside' });
  }
  const set: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || env[m[1]!] !== undefined) continue;
    const quoted = /^(['"])(.*)\1$/.exec(m[2]!);
    env[m[1]!] = quoted ? quoted[2]! : m[2]!.replace(/\s+#.*$/, '');
    set.push(m[1]!);
  }
  return set;
}

/** Environment variable names Husk reads. Documented so `husk doctor` can list them. */
export const ENV_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  together: 'TOGETHER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  ollamaHost: 'OLLAMA_HOST',
  lmstudioHost: 'LMSTUDIO_HOST',
  fly: 'FLY_API_TOKEN',
  discord: 'DISCORD_BOT_TOKEN',
  slack: 'SLACK_BOT_TOKEN',
  telegram: 'TELEGRAM_BOT_TOKEN',
} as const;

export const HUSK_PORT_DEFAULT = 7377;
