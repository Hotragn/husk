// @vitest-environment jsdom
/**
 * Polling, and the ways it is easy to get wrong.
 *
 * The bug this covers: a Files panel left open reports "/work is empty" forever
 * while the agent fills the directory. There is no change event to subscribe to
 * -- `exec` cannot know which files a command touched -- so the listing has to
 * be re-fetched on a timer.
 *
 * The failure modes on the other side are a timer that keeps hammering a machine
 * nobody is looking at, and a tab that returns to the foreground and then sits on
 * stale data until the next tick. Both are asserted here, because I got the
 * second one wrong by observation: a hidden browser pane made a working
 * implementation look broken.
 *
 * Fake timers are installed *before* mounting in every test. Installing them
 * afterwards leaves the hook's `setInterval` on the real clock, where
 * `advanceTimersByTime` cannot reach it -- which makes a broken implementation
 * and a working one produce identical, passing output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useResource } from './useResource';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  Object.defineProperty(document, 'hidden', { value: state === 'hidden', configurable: true });
}

/** Advance the frozen clock and let React flush what that caused. */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Let the mount effect's fetch settle while the clock is frozen. */
const settle = () => tick(0);

describe('useResource polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('does not poll at all when no interval is asked for', async () => {
    setVisibility('visible');
    const fetcher = vi.fn(async () => 'one');
    renderHook(() => useResource(fetcher, [], true));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await tick(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('re-fetches on the interval while the tab is visible', async () => {
    setVisibility('visible');
    const fetcher = vi.fn(async () => 'one');
    renderHook(() => useResource(fetcher, [], true, { refreshMs: 4000 }));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await tick(4000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await tick(4000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('stops polling while the tab is hidden', async () => {
    // A console left open in a background tab should not keep a machine busy.
    setVisibility('hidden');
    const fetcher = vi.fn(async () => 'one');
    renderHook(() => useResource(fetcher, [], true, { refreshMs: 4000 }));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await tick(20_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('catches up immediately when the tab becomes visible again', async () => {
    // Waiting out a full interval after someone looks back at the screen is
    // exactly when stale data is most obvious.
    setVisibility('hidden');
    const fetcher = vi.fn(async () => 'one');
    renderHook(() => useResource(fetcher, [], true, { refreshMs: 4000 }));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // ...and the interval runs again from that point.
    await tick(4000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('stops again when the tab is hidden once more', async () => {
    setVisibility('visible');
    const fetcher = vi.fn(async () => 'one');
    renderHook(() => useResource(fetcher, [], true, { refreshMs: 4000 }));
    await settle();
    await tick(4000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    setVisibility('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    await tick(20_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not poll a disabled resource', async () => {
    // `enabled` is false before a computer has been chosen; polling then would
    // fetch against an empty id.
    setVisibility('visible');
    const fetcher = vi.fn(async () => 'one');
    renderHook(() => useResource(fetcher, [], false, { refreshMs: 4000 }));
    await settle();
    await tick(20_000);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('clears its timer on unmount', async () => {
    setVisibility('visible');
    const fetcher = vi.fn(async () => 'one');
    const { unmount } = renderHook(() => useResource(fetcher, [], true, { refreshMs: 4000 }));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    unmount();
    await tick(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
