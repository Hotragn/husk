/**
 * Things that must be torn down when a computer goes away.
 *
 * The leak this exists to close: a browser session outlives its computer.
 * `@husk-ai/browser` keeps a Chromium running inside the machine and a `pkill` in
 * `close()` to stop it -- but nothing called `close()` when the computer was
 * destroyed. Only `DELETE /v1/computers/:id/browser` did, which is a route
 * almost nobody calls. So every machine that ever opened a page left a browser
 * running: measured, 23 `headless_shell` processes still alive the next day,
 * each holding its workspace directory open so `husk rm` could not delete it
 * and ~325 MB per machine stayed on disk.
 *
 * A registry rather than a direct call because of layering. `@husk-ai/runtime`
 * owns the lifecycle and must not import `@husk-ai/browser` -- the browser is an
 * optional thing built *on* computers, and a runtime that depended on it would
 * drag Chromium provisioning into every install. So the runtime announces, and
 * whoever cares subscribes.
 */

export type DestroyHook = (computerId: string) => void | Promise<void>;

const hooks = new Set<DestroyHook>();

/**
 * Run `fn` when any computer is destroyed. Returns an unsubscribe.
 *
 * Register at module load in the package that owns the resource, so the hook is
 * in place before anything could have created one.
 */
export function onComputerDestroyed(fn: DestroyHook): () => void {
  hooks.add(fn);
  return () => hooks.delete(fn);
}

/**
 * Announce a destroyed computer and wait for every subscriber.
 *
 * Failures are swallowed deliberately: this runs on the teardown path, and a
 * cleanup that throws must not stop the destroy it is cleaning up after, nor
 * stop the other subscribers. A browser that cannot be closed is a smaller
 * problem than a computer that cannot be removed.
 */
export async function notifyComputerDestroyed(computerId: string): Promise<void> {
  await Promise.all(
    [...hooks].map(async (fn) => {
      try {
        await fn(computerId);
      } catch {
        // teardown is best-effort by construction
      }
    }),
  );
}

/** Test seam. Not for production use -- hooks are registered at module load. */
export function clearDestroyHooks(): void {
  hooks.clear();
}
