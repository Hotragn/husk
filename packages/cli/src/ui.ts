/**
 * The whole presentation layer: colour, spinners, tables, and the rule about
 * what is allowed on stdout.
 *
 * No chalk, no ora. Not out of purism -- those two pull ~20 transitive packages
 * and cost startup time on a binary people run hundreds of times a day, and what
 * they do is 150 lines of escape codes.
 *
 * The rule that matters: **stdout carries the answer, stderr carries everything
 * else.** With `--json`, stdout carries the JSON and nothing but the JSON, so
 * `husk ps --json | jq` works even while a spinner is turning.
 */

const ESC = String.fromCharCode(27);
const CSI = ESC + '[';

export interface UiOptions {
  json: boolean;
  quiet: boolean;
  color: boolean;
  debug: boolean;
  /** stdout is attached to a terminal. Drives tables and progress. */
  stdoutTty: boolean;
  /** stderr is attached to a terminal. Drives spinners. */
  stderrTty: boolean;
  width: number;
}

const state: UiOptions = {
  json: false,
  quiet: false,
  color: false,
  debug: false,
  stdoutTty: false,
  stderrTty: false,
  width: 80,
};

/**
 * Decide whether to emit colour.
 *
 * NO_COLOR wins over everything (https://no-color.org). FORCE_COLOR is honoured
 * because CI logs are not TTYs but people still want colour in them.
 */
function wantsColor(explicit: boolean | undefined, tty: boolean): boolean {
  if (explicit === false) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.HUSK_NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.TERM === 'dumb') return false;
  if (explicit === true) return true;
  return tty;
}

export function configure(opts: { json?: boolean; quiet?: boolean; color?: boolean; debug?: boolean }): void {
  state.stdoutTty = process.stdout.isTTY === true;
  state.stderrTty = process.stderr.isTTY === true;
  state.json = opts.json ?? false;
  state.quiet = opts.quiet ?? false;
  state.debug = opts.debug ?? false;
  // Colour follows the stream a human is most likely reading. When stdout is
  // piped but stderr is still a terminal, status lines stay readable.
  state.color = wantsColor(opts.color, state.stdoutTty || state.stderrTty);
  state.width = process.stdout.columns ?? process.stderr.columns ?? 80;
}

export function options(): Readonly<UiOptions> {
  return state;
}

function wrap(code: string, s: string): string {
  return state.color ? `${CSI}${code}m${s}${CSI}0m` : s;
}

export const bold = (s: string): string => wrap('1', s);
export const dim = (s: string): string => wrap('2', s);
export const red = (s: string): string => wrap('31', s);
export const green = (s: string): string => wrap('32', s);
export const yellow = (s: string): string => wrap('33', s);
export const blue = (s: string): string => wrap('34', s);
export const cyan = (s: string): string => wrap('36', s);
export const gray = (s: string): string => wrap('90', s);

/** Visible width, ignoring escape sequences we may have already inserted. */
export function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(new RegExp(ESC + '\\[[0-9;]*m', 'g'), '');
}

export function pad(s: string, width: number): string {
  const len = visibleLength(s);
  return len >= width ? s : s + ' '.repeat(width - len);
}

export function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, max);
  return visibleLength(s) <= max ? s : stripAnsi(s).slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

/** The command's answer. Suppressed under --json so stdout stays pure. */
export function print(line = ''): void {
  if (state.json) return;
  process.stdout.write(line + '\n');
}

/** Bytes straight through, no newline. Used by `exec` to relay child output. */
export function raw(chunk: string): void {
  if (state.json) return;
  process.stdout.write(chunk);
}

/** The one legal stdout write when --json is set. */
export function json(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/** Human chatter. Always stderr, so it never pollutes a pipe. */
export function note(line = ''): void {
  if (state.quiet) return;
  process.stderr.write(line + '\n');
}

export function step(line: string): void {
  note(`${green('✓')} ${line}`);
}

export function warn(line: string): void {
  if (state.quiet) return;
  process.stderr.write(`${yellow('warning')} ${line}\n`);
}

export function debug(line: string): void {
  if (!state.debug) return;
  process.stderr.write(`${gray('debug   ' + line)}\n`);
}

/** Errors ignore --quiet. A silenced failure is a bug factory. */
export function fail(line: string): void {
  process.stderr.write(`${red('error')} ${line}\n`);
}

export function hint(line: string): void {
  process.stderr.write(`${dim('hint:  ' + line)}\n`);
}

// ---------------------------------------------------------------------------
// spinner
// ---------------------------------------------------------------------------

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  update(text: string): void;
  stop(finalLine?: string): void;
}

/**
 * A stderr spinner that degrades to a single static line.
 *
 * Only animates on a real terminal: writing cursor moves into a CI log or a file
 * produces the escape-code soup everyone has seen at least once.
 */
export function spinner(text: string): Spinner {
  if (state.quiet || !state.stderrTty) {
    if (!state.quiet) process.stderr.write(`${dim(text + '...')}\n`);
    return {
      update() {},
      stop(finalLine) {
        if (finalLine && !state.quiet) process.stderr.write(finalLine + '\n');
      },
    };
  }

  let label = text;
  let i = 0;
  const render = () => {
    const frame = FRAMES[i++ % FRAMES.length] as string;
    process.stderr.write(`\r${CSI}2K${cyan(frame)} ${label}`);
  };
  render();
  const timer = setInterval(render, 80);
  timer.unref?.();

  return {
    update(next: string) {
      label = next;
    },
    stop(finalLine?: string) {
      clearInterval(timer);
      process.stderr.write(`\r${CSI}2K`);
      if (finalLine) process.stderr.write(finalLine + '\n');
    },
  };
}

// ---------------------------------------------------------------------------
// table
// ---------------------------------------------------------------------------

export interface Column {
  header: string;
  /** Hard ceiling on the rendered width. Long values are elided. */
  max?: number;
}

/**
 * Render rows for whoever is reading.
 *
 * On a terminal: aligned columns with a dim header, which is what a human wants.
 * Piped: tab-separated with no padding, which is what `cut -f2` wants. Padding a
 * piped table is the single most common way a CLI breaks its own scriptability.
 */
export function table(columns: Column[], rows: string[][]): string {
  if (!state.stdoutTty) {
    return [columns.map((c) => c.header).join('\t'), ...rows.map((r) => r.map((c) => stripAnsi(c)).join('\t'))].join('\n');
  }

  const cells = rows.map((row) => row.map((cell, i) => truncate(cell, columns[i]?.max ?? 60)));
  const widths = columns.map((col, i) =>
    Math.max(visibleLength(col.header), ...cells.map((r) => visibleLength(r[i] ?? ''))),
  );

  const header = columns.map((c, i) => pad(dim(c.header.toUpperCase()), widths[i] ?? 0)).join('  ');
  const body = cells.map((row) => row.map((cell, i) => pad(cell, widths[i] ?? 0)).join('  ').trimEnd());
  return [header, ...body].join('\n');
}

/** A two-column definition list, used by doctor and up. */
export function fields(pairs: Array<[string, string]>, indent = '  '): string {
  const width = Math.max(0, ...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${indent}${dim(pad(k, width))}  ${v}`).join('\n');
}

export function heading(text: string): string {
  return bold(text);
}

/**
 * Status glyphs.
 *
 * The only place that still cannot render these is the legacy Windows console
 * host, which sets none of WT_SESSION / TERM_PROGRAM / TERM. Everything else --
 * Windows Terminal, VS Code, git-bash, any Unix -- gets the real glyphs.
 */
export function unicodeOk(): boolean {
  if (process.platform !== 'win32') return true;
  return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.TERM);
}

export function mark(ok: boolean | null): string {
  const unicode = unicodeOk();
  if (ok === null) return unicode ? yellow('○') : yellow('?');
  if (ok) return unicode ? green('✓') : green('+');
  return unicode ? red('✗') : red('x');
}
