/**
 * The computer list, fetched once for the whole console.
 *
 * Four panels need to know which machines exist. They must not each ask: the
 * duplicate-source bugs in this repo all look the same from the outside — two
 * copies of one fact disagreeing — so there is exactly one `GET /v1/computers`
 * in the app and it lives here.
 *
 * The value handed out is the whole `Resource`, not a bare array, because
 * "there is no computer" and "we have not been told yet" are different states
 * and a panel that cannot tell them apart will show an empty state over a
 * machine that exists. `loaded` is the honest form of that question.
 */

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useConnection } from './connection';
import { useResource } from './useResource';
import type { Resource } from './useResource';
import type { ComputerInfo } from '../api/wire';

export interface ComputersValue extends Resource<ComputerInfo[]> {
  /** The machines, or `[]` while the list is still unknown. */
  list: ComputerInfo[];
  /** True once a response has landed — so `list.length === 0` means "none". */
  loaded: boolean;
}

const EMPTY: ComputerInfo[] = [];

const ComputersContext = createContext<ComputersValue | null>(null);

export function ComputersProvider({ children }: { children: ReactNode }) {
  const { api, revision } = useConnection();

  // Deliberately not gated on `status === 'connected'`. The gate used to be
  // here and it was the bug: `status` comes from a separate `/health` probe
  // that calls `invalidate()` the moment it succeeds, so a gated list could
  // only start its first request in the very tick that `revision` began to
  // churn — and the next bump aborted it before it could resolve. This request
  // is its own liveness signal: it either returns machines or returns an error
  // this context reports, and a daemon that is really down is already handled
  // one level up by `DisconnectedScreen`.
  const resource = useResource<ComputerInfo[]>((signal) => api.listComputers(signal), [api, revision]);

  // Memoised on `data` alone so the empty array keeps its identity across the
  // renders where the list is still unknown; consumers use it in dep arrays.
  const list = useMemo(() => resource.data ?? EMPTY, [resource.data]);

  const value = useMemo<ComputersValue>(
    () => ({ ...resource, list, loaded: resource.data !== null }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resource.data, resource.error, resource.loading, resource.showSkeleton, resource.slow, resource.reload, list],
  );

  return <ComputersContext.Provider value={value}>{children}</ComputersContext.Provider>;
}

export function useComputers(): ComputersValue {
  const ctx = useContext(ComputersContext);
  if (!ctx) throw new Error('useComputers must be used inside <ComputersProvider>');
  return ctx;
}
