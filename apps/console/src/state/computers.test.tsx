// @vitest-environment jsdom
/**
 * The shared computer list, and the distinction the panels got wrong.
 *
 * The bug this file exists for: Files, Terminal and Browser decided "there is
 * no computer" from `computers.length === 0`, which is also true for the whole
 * window before the list has arrived — and that window could be reopened at
 * will, because every `invalidate()` aborts the in-flight `GET /v1/computers`
 * and drops it back to `null`. The Computers panel, which asked its own
 * question and checked `data !== null`, looked right the whole time.
 *
 * These tests drive the real `<App />` over a fake `HuskApi` and a fake
 * WebSocket, so the ordering that produced the bug — health resolves, a wire
 * event lands mid-flight, the list restarts — is reproduced rather than
 * described.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ComputerInfo } from '../api/wire';

// -- the fakes ---------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const COMPUTER: ComputerInfo = {
  id: 'cmp_test0000',
  name: 'demo',
  provider: 'local',
  state: 'running',
  image: 'local:wsl',
  workdir: '/work',
  createdAt: '2026-09-11T00:00:00.000Z',
  lastUsedAt: '2026-09-11T00:00:00.000Z',
  spec: { name: 'demo', provider: 'local' },
} as ComputerInfo;

/** Every `listComputers()` call, in order, so a test can settle them one by one. */
const listCalls: Deferred<ComputerInfo[]>[] = [];

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  class FakeApi {
    readonly baseUrl = 'http://127.0.0.1:7377';
    health() {
      return Promise.resolve({ status: 'ok', version: 'test' });
    }
    listComputers(signal?: AbortSignal) {
      const d = deferred<ComputerInfo[]>();
      listCalls.push(d);
      signal?.addEventListener('abort', () => d.reject(new DOMException('aborted', 'AbortError')));
      return d.promise;
    }
    listDir() {
      return Promise.resolve([{ name: 'notes', path: '/work/notes', type: 'dir' }]);
    }
    doctor() {
      return Promise.resolve({ providers: [] });
    }
    socketUrl(path: string) {
      return `ws://127.0.0.1:7377${path}`;
    }
  }
  return { ...actual, HuskApi: FakeApi };
});

/** The event firehose, under the test's control. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readyState = 1;
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  emit(type: string, ev: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

/**
 * Let React and the promise chains behind `useResource` finish.
 *
 * A fixed number of microtask turns is not enough: `HuskApi.health()` and the
 * effect that depends on it settle a variable number of ticks apart, and a
 * test that guesses wrong is a flaky test, not a strict one.
 */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Settle until at least `n` `listComputers()` calls have been made. */
async function waitForCalls(n: number) {
  for (let i = 0; i < 40 && listCalls.length < n; i += 1) await settle();
  expect(listCalls.length).toBeGreaterThanOrEqual(n);
}

// -- the tests ---------------------------------------------------------------

describe('the shared computer list', () => {
  beforeEach(() => {
    listCalls.length = 0;
    FakeSocket.last = null;
    vi.stubGlobal('WebSocket', FakeSocket);
    window.localStorage.clear();
    window.location.hash = '#/files';
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function mount() {
    const { default: App } = await import('../App');
    await act(async () => {
      render(<App />);
    });
    await waitForCalls(1);
    return App;
  }

  it('never claims there is no computer while the list is still in flight', async () => {
    await mount();

    // The request is open and unanswered: the panel must not have concluded
    // anything about whether a machine exists.
    expect(screen.queryByText('No computer to browse.')).toBeNull();

    await act(async () => {
      listCalls[listCalls.length - 1]?.resolve([COMPUTER]);
    });
    await settle();

    expect(screen.queryByText('No computer to browse.')).toBeNull();
    // The panel proper: the machine is offered in the computer picker.
    expect(screen.getByText(`${COMPUTER.id} · local · running`)).toBeTruthy();
  });

  it('survives an invalidate that aborts the list mid-flight — the regression', async () => {
    await mount();
    const first = listCalls.length;

    // A wire event lands while `GET /v1/computers` is still open. This is what
    // the event socket does on connect (`triggers_synced`), and it bumps
    // `revision`, whose effect cleanup aborts the request in flight.
    await act(async () => {
      FakeSocket.last?.emit('message', {
        data: JSON.stringify({ type: 'triggers_synced', at: new Date().toISOString(), topic: 'triggers' }),
      });
    });
    await waitForCalls(first + 1);
    // The aborted attempt must not have been mistaken for "no computers".
    expect(screen.queryByText('No computer to browse.')).toBeNull();

    await act(async () => {
      listCalls[listCalls.length - 1]?.resolve([COMPUTER]);
    });
    await settle();

    expect(screen.queryByText('No computer to browse.')).toBeNull();
    expect(screen.getByText(`${COMPUTER.id} · local · running`)).toBeTruthy();
  });

  it('does show the empty state once the server has actually said there are none', async () => {
    await mount();
    await act(async () => {
      listCalls[listCalls.length - 1]?.resolve([]);
    });
    await settle();

    expect(screen.getByText('No computer to browse.')).toBeTruthy();
  });

  it('asks for the list exactly once, however many panels want it', async () => {
    window.location.hash = '#/computers';
    await mount();

    // The Computers panel used to run its own identical `GET /v1/computers`
    // beside the shell's. Two sources of one fact is how this list could be
    // populated in one panel and empty in another at the same moment.
    expect(listCalls.length).toBe(1);

    await act(async () => {
      listCalls[listCalls.length - 1]?.resolve([COMPUTER]);
    });
    await settle();

    // One request per revision, not one per panel: the Computers panel and the
    // Files panel read the same resource.
    const before = listCalls.length;
    await act(async () => {
      window.location.hash = '#/files';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await settle();

    expect(listCalls.length).toBe(before);
    expect(screen.queryByText('No computer to browse.')).toBeNull();
  });
});
