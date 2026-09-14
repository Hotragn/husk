/**
 * One interrupt controller for the process.
 *
 * Ctrl-C aborts this signal rather than killing the process, so work unwinds:
 * a run stops between steps, an exec kills its child's process tree, and a
 * half-created computer is never left behind. It lives in its own module so a
 * command can subscribe without importing the entrypoint.
 */
const controller = new AbortController();
let tripped = false;

export function interruptSignal(): AbortSignal {
  return controller.signal;
}

export function wasInterrupted(): boolean {
  return tripped;
}

/** Called by the signal handler in bin.ts. Idempotent. */
export function trip(): boolean {
  const first = !tripped;
  tripped = true;
  if (first) controller.abort(new Error('aborted'));
  return first;
}
