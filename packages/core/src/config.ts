import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

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
  model: 'auto',
  host: '127.0.0.1',
  port: 7377,
  maxCostUsd: 5,
  maxComputers: 8,
  telemetry: false,
  logLevel: 'info',
  modelAliases: {},
};

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
export const HUSK_USER_AGENT = 'husk/0.1.1 (+https://github.com/Hotragn/husk)';
