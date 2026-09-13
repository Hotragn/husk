/**
 * The destroy hook exists because a browser outlived its computer.
 *
 * Measured before the fix: 23 `headless_shell` processes still running the day
 * after their computers were destroyed, each holding its workspace open, so
 * `husk rm` reported "its files are still on disk" -- correctly -- and ~325 MB
 * per machine stayed put. `closeBrowserFor` existed and worked; nothing on the
 * destroy path called it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDestroyHooks, notifyComputerDestroyed, onComputerDestroyed } from './lifecycle.js';

afterEach(() => clearDestroyHooks());

describe('computer destroy hooks', () => {
  it('tells every subscriber which computer went', async () => {
    const seen: string[] = [];
    onComputerDestroyed((id) => void seen.push(`a:${id}`));
    onComputerDestroyed((id) => void seen.push(`b:${id}`));

    await notifyComputerDestroyed('cmp_1');
    expect(seen.sort()).toEqual(['a:cmp_1', 'b:cmp_1']);
  });

  it('waits for async subscribers before returning', async () => {
    // The ordering is the whole point: a browser's close runs a `pkill` inside
    // the computer, so it has to finish while the computer still exists.
    let done = false;
    onComputerDestroyed(async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });

    await notifyComputerDestroyed('cmp_1');
    expect(done).toBe(true);
  });

  it('does not let one failing subscriber stop the others', async () => {
    // Teardown is best-effort: a browser that cannot be closed is a smaller
    // problem than a computer that then cannot be destroyed.
    const ok = vi.fn();
    onComputerDestroyed(() => {
      throw new Error('pkill failed');
    });
    onComputerDestroyed(ok);

    await expect(notifyComputerDestroyed('cmp_1')).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledWith('cmp_1');
  });

  it('swallows a rejected promise the same way', async () => {
    onComputerDestroyed(async () => {
      throw new Error('async pkill failed');
    });
    await expect(notifyComputerDestroyed('cmp_1')).resolves.toBeUndefined();
  });

  it('stops calling a subscriber after it unsubscribes', async () => {
    const fn = vi.fn();
    const off = onComputerDestroyed(fn);
    await notifyComputerDestroyed('cmp_1');
    off();
    await notifyComputerDestroyed('cmp_2');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('is fine with nobody listening', async () => {
    await expect(notifyComputerDestroyed('cmp_1')).resolves.toBeUndefined();
  });
});
