/**
 * Connection state, as a first-class thing.
 *
 * The server is a local daemon someone has to start. "Not running" is the
 * normal first state of this app, not an exception, so it gets a real screen
 * with the exact command — never a skeleton that looks like data arriving.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { HuskApi, isAbort, toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import { backoffMs, openManagedSocket } from '../api/sockets';
import type { ManagedSocket } from '../api/sockets';
import { EVENT_TOPICS, isWireEvent } from '../api/wire';
import type { HealthReport, HuskWireEvent } from '../api/wire';

const BASE_URL_KEY = 'husk.console.baseUrl';
const TOKEN_KEY = 'husk.console.token';
const MAX_EVENTS = 200;

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface ConnectionValue {
  api: HuskApi;
  status: ConnectionStatus;
  health: HealthReport | null;
  error: DisplayError | null;
  /** ms until the next automatic probe, or null when one is in flight. */
  retryInMs: number | null;
  retryNow(): void;
  baseUrl: string;
  token: string;
  configure(next: { baseUrl?: string; token?: string }): void;
  /** Live feed from `WS /v1/events`, newest first. */
  events: HuskWireEvent[];
  clearEvents(): void;
  /** Bumped whenever the server reports a state change worth refetching for. */
  revision: number;
  invalidate(): void;
}

const ConnectionContext = createContext<ConnectionValue | null>(null);

function readStored(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    /* private mode; the session still works, it just will not be remembered */
  }
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  // Same origin by default: in production `@husk-ai/server` serves this bundle
  // itself, and in development `vite.config.ts` proxies `/v1` and `/health`
  // through to it. Either way there is no cross-origin request to arrange.
  const [baseUrl, setBaseUrl] = useState(() => readStored(BASE_URL_KEY, window.location.origin));
  const [token, setToken] = useState(() => readStored(TOKEN_KEY, ''));

  const api = useMemo(() => new HuskApi({ baseUrl, token }), [baseUrl, token]);

  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [retryInMs, setRetryInMs] = useState<number | null>(null);
  const [events, setEvents] = useState<HuskWireEvent[]>([]);
  const [revision, setRevision] = useState(0);

  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tickRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const probeRef = useRef<(() => void) | null>(null);
  /**
   * Set the moment the daemon is seen to be down, cleared when it comes back.
   * Only that round trip — away and back — can have changed the state behind
   * our resources, so only that round trip is worth an `invalidate()`.
   */
  const staleRef = useRef(false);

  const invalidate = useCallback(() => setRevision((r) => r + 1), []);

  const stopTimers = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    timerRef.current = undefined;
    tickRef.current = undefined;
  }, []);

  // -- liveness probe -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const scheduleRetry = () => {
      if (cancelled) return;
      const delay = backoffMs(attemptRef.current);
      attemptRef.current += 1;
      setRetryInMs(delay);

      const deadline = Date.now() + delay;
      tickRef.current = setInterval(() => {
        const left = deadline - Date.now();
        setRetryInMs(left > 0 ? left : 0);
      }, 250);
      timerRef.current = setTimeout(() => {
        if (tickRef.current) clearInterval(tickRef.current);
        void probe();
      }, delay);
    };

    const probe = async () => {
      if (cancelled) return;
      stopTimers();
      setRetryInMs(null);
      setStatus((prev) => (prev === 'connected' ? prev : 'connecting'));
      try {
        const report = await api.health(controller.signal);
        if (cancelled) return;
        attemptRef.current = 0;
        setHealth(report);
        setError(null);
        // Only a *reconnect* invalidates. A liveness probe that finds the
        // daemon still up has learned nothing, and bumping `revision` for it
        // aborts whatever request is in flight — which is how the shared
        // computer list used to starve and leave the panels claiming there was
        // no machine. The first probe is not a reconnect either: resources
        // fetch on mount, so there is nothing yet to invalidate.
        if (staleRef.current) invalidate();
        staleRef.current = false;
        setStatus('connected');
      } catch (err) {
        if (cancelled || isAbort(err)) return;
        setHealth(null);
        setError(toDisplayError(err));
        staleRef.current = true;
        setStatus('disconnected');
        scheduleRetry();
      }
    };

    probeRef.current = () => {
      attemptRef.current = 0;
      void probe();
    };
    void probe();

    return () => {
      cancelled = true;
      controller.abort();
      stopTimers();
      probeRef.current = null;
    };
  }, [api, invalidate, stopTimers]);

  // -- event firehose -------------------------------------------------------

  useEffect(() => {
    let socket: ManagedSocket | null = null;

    socket = openManagedSocket(api.socketUrl('/v1/events'), {
      onOpen(ws) {
        ws.send(JSON.stringify({ type: 'subscribe', topics: [...EVENT_TOPICS] }));
      },
      onMessage(raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          return;
        }
        if (!isWireEvent(parsed)) return;
        setEvents((prev) => [parsed, ...prev].slice(0, MAX_EVENTS));
        // The bookkeeping frames are not state changes; everything else is.
        if (parsed.type !== 'hello' && parsed.type !== 'subscribed' && parsed.type !== 'pong') {
          invalidate();
        }
      },
      onStateChange(next) {
        // A socket that dropped is the earliest signal the daemon went away.
        // Re-probe rather than waiting out the HTTP backoff.
        if (next === 'closed') probeRef.current?.();
      },
    });

    return () => socket?.close();
  }, [api, invalidate]);

  const configure = useCallback((next: { baseUrl?: string; token?: string }) => {
    if (next.baseUrl !== undefined) {
      const trimmed = next.baseUrl.trim() || window.location.origin;
      writeStored(BASE_URL_KEY, trimmed);
      setBaseUrl(trimmed);
    }
    if (next.token !== undefined) {
      writeStored(TOKEN_KEY, next.token.trim());
      setToken(next.token.trim());
    }
  }, []);

  const value = useMemo<ConnectionValue>(
    () => ({
      api,
      status,
      health,
      error,
      retryInMs,
      retryNow: () => probeRef.current?.(),
      baseUrl,
      token,
      configure,
      events,
      clearEvents: () => setEvents([]),
      revision,
      invalidate,
    }),
    [api, status, health, error, retryInMs, baseUrl, token, configure, events, revision, invalidate],
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection must be used inside <ConnectionProvider>');
  return ctx;
}
