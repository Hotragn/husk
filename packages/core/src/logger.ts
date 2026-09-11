export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 99 };

export interface Logger {
  level: LogLevel;
  trace(msg: string, meta?: unknown): void;
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  /** Emit newline-delimited JSON instead of pretty text. HUSK_LOG_JSON=1 forces it. */
  json?: boolean;
  sink?: (line: string) => void;
}

const CSI = String.fromCharCode(27) + '[';
const RESET = CSI + '0m';
const DIM = CSI + '2m';
const COLOR: Record<Exclude<LogLevel, 'silent'>, string> = {
  trace: CSI + '90m',
  debug: CSI + '36m',
  info: CSI + '32m',
  warn: CSI + '33m',
  error: CSI + '31m',
};

export function createLogger(opts: LoggerOptions = {}): Logger {
  const envLevel = process.env.HUSK_LOG_LEVEL as LogLevel | undefined;
  const json = opts.json ?? process.env.HUSK_LOG_JSON === '1';
  const sink = opts.sink ?? ((line: string) => process.stderr.write(line + '\n'));
  const state = { level: opts.level ?? envLevel ?? 'info', scope: opts.scope ?? '' };
  const useColor = !json && process.stderr.isTTY === true && !process.env.NO_COLOR;

  function emit(level: Exclude<LogLevel, 'silent'>, msg: string, meta?: unknown) {
    if (ORDER[level] < ORDER[state.level]) return;
    if (json) {
      sink(JSON.stringify({ t: new Date().toISOString(), level, scope: state.scope || undefined, msg, meta }));
      return;
    }
    const tag = useColor ? COLOR[level] + level.padEnd(5) + RESET : level.padEnd(5);
    const scope = state.scope ? (useColor ? `${DIM}[${state.scope}]${RESET} ` : `[${state.scope}] `) : '';
    let line = `${tag} ${scope}${msg}`;
    if (meta !== undefined) {
      const s = typeof meta === 'string' ? meta : safeStringify(meta);
      line += useColor ? ` ${DIM}${s}${RESET}` : ` ${s}`;
    }
    sink(line);
  }

  const logger: Logger = {
    get level() {
      return state.level;
    },
    set level(l: LogLevel) {
      state.level = l;
    },
    trace: (m, x) => emit('trace', m, x),
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
    child: (scope) =>
      createLogger({ ...opts, level: state.level, scope: state.scope ? `${state.scope}:${scope}` : scope }),
  };
  return logger;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (val instanceof Error ? { name: val.name, message: val.message } : val)) ?? '';
  } catch {
    return String(v);
  }
}

export const log = createLogger({ scope: 'husk' });
