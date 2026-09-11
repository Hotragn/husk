/**
 * One fetch, three honest states.
 *
 * UI-PRINCIPLES §6: under 400ms show nothing, 400ms–2s skeletons, over ~2s a
 * real status line. `showSkeleton` and `slow` implement exactly that, so a
 * panel never flashes a loading state for a request that took 80ms.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbort, toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';

const SKELETON_AFTER_MS = 400;
const STATUS_LINE_AFTER_MS = 2000;

export interface Resource<T> {
  data: T | null;
  error: DisplayError | null;
  loading: boolean;
  /** True once loading has lasted long enough to be worth drawing. */
  showSkeleton: boolean;
  /** True once it has lasted long enough that a skeleton is no longer honest. */
  slow: boolean;
  reload(): void;
}

export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  enabled = true,
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [slow, setSlow] = useState(false);
  const [nonce, setNonce] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setShowSkeleton(false);
      setSlow(false);
      return;
    }

    const controller = new AbortController();
    let done = false;
    setLoading(true);
    setSlow(false);

    const skeletonTimer = setTimeout(() => {
      if (!done) setShowSkeleton(true);
    }, SKELETON_AFTER_MS);
    const slowTimer = setTimeout(() => {
      if (!done) setSlow(true);
    }, STATUS_LINE_AFTER_MS);

    void (async () => {
      try {
        const value = await fetcherRef.current(controller.signal);
        if (controller.signal.aborted) return;
        setData(value);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return;
        // Drop the previous value. Keeping it would leave the last successful
        // response on screen under a caption describing the request that just
        // failed — a directory listing labelled with a path it did not come
        // from. Error and data are mutually exclusive here on purpose.
        setData(null);
        setError(toDisplayError(err));
      } finally {
        done = true;
        clearTimeout(skeletonTimer);
        clearTimeout(slowTimer);
        if (!controller.signal.aborted) {
          setLoading(false);
          setShowSkeleton(false);
          setSlow(false);
        }
      }
    })();

    return () => {
      done = true;
      clearTimeout(skeletonTimer);
      clearTimeout(slowTimer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, showSkeleton, slow, reload };
}
