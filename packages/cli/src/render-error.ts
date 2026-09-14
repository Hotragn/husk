import { dim, fail, hint, note, options } from './ui.js';
import { EXIT_ERROR, EXIT_SIGINT, EXIT_USAGE } from './exit.js';
import { UsageError } from './args.js';

/**
 * Render a failure.
 *
 * Deliberately duck-typed instead of `instanceof HuskError`: importing
 * `@husk-ai/core` here would pull zod onto the startup path of every invocation,
 * including `husk --help`. The shape is stable and part of the contract, and a
 * HuskError that crossed a package boundary is still the same object.
 */
interface HuskErrorShape {
  name: string;
  code: string;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export function isHuskErrorShape(e: unknown): e is HuskErrorShape & Error {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as HuskErrorShape).name === 'HuskError' &&
    typeof (e as HuskErrorShape).code === 'string'
  );
}

/**
 * One red line, one dim hint line. Never a stack trace unless --debug.
 *
 * A stack trace shown to someone who is not debugging husk is noise that buries
 * the one line they needed. Behind --debug it is exactly what a maintainer wants.
 */
export function renderError(err: unknown): number {
  const { json, debug } = options();

  if (isHuskErrorShape(err)) {
    if (json) {
      // Even a failure keeps stdout pure, so `husk ps --json | jq` in a script
      // that checks the exit code still gets parseable output on both paths.
      process.stdout.write(
        JSON.stringify({ error: { code: err.code, message: err.message, hint: err.hint, details: err.details } }, null, 2) + '\n',
      );
    }
    fail(err.message);
    if (err.hint) hint(err.hint);
    if (debug) dumpStack(err);
    return EXIT_ERROR;
  }

  if (err instanceof UsageError) {
    fail(err.message);
    hint(err.command ? `husk help ${err.command}` : 'husk --help');
    return EXIT_USAGE;
  }

  if (isAbort(err)) {
    note('');
    note(dim('interrupted'));
    return EXIT_SIGINT;
  }

  const e = err as NodeJS.ErrnoException;

  if (e?.code === 'ENOENT' && e.path) {
    fail(`no such file: ${e.path}`);
    hint('check the path, or run `husk init` to create a husk.yaml here');
    if (debug) dumpStack(e);
    return EXIT_ERROR;
  }

  if (e?.code === 'EACCES' && e.path) {
    fail(`permission denied: ${e.path}`);
    hint('husk runs as you; it will not escalate. Fix the permissions or pick another path.');
    if (debug) dumpStack(e);
    return EXIT_ERROR;
  }

  if (e?.code === 'EADDRINUSE') {
    fail(`that port is already in use`);
    hint('pass --port with a free one, or stop whatever is holding it');
    if (debug) dumpStack(e);
    return EXIT_ERROR;
  }

  if (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND') {
    fail(`a husk package is missing or was not built: ${short(e.message)}`);
    hint('run `npm install && npm run build` at the repo root');
    if (debug) dumpStack(e);
    return EXIT_ERROR;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ error: { code: 'E_INTERNAL', message: short(String(e?.message ?? e)) } }, null, 2) + '\n');
  }
  fail(short(String(e?.message ?? e)));
  hint(debug ? 'the stack trace is below' : 're-run with --debug for the stack trace');
  if (debug) dumpStack(e);
  return EXIT_ERROR;
}

function isAbort(err: unknown): boolean {
  const e = err as { name?: string; message?: string; code?: string };
  return e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || e?.message === 'aborted';
}

function short(message: string): string {
  const first = message.split('\n')[0] ?? message;
  return first.length > 400 ? first.slice(0, 400) + '…' : first;
}

function dumpStack(err: unknown): void {
  const e = err as Error & { cause?: unknown };
  process.stderr.write(dim(e?.stack ?? String(err)) + '\n');
  if (e?.cause) {
    process.stderr.write(dim('caused by: ' + ((e.cause as Error)?.stack ?? String(e.cause))) + '\n');
  }
}
