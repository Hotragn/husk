/**
 * A progress listener has to be attachable after the session exists.
 *
 * `browserFor` caches by computer id and returns the existing session on every
 * call after the first, options and all ignored. The server creates sessions
 * from an HTTP handler, so "pass onProgress when you construct it" means the
 * one request that happened to be first owns the only listener — and the
 * console, which wants these messages on the event bus, gets nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import { BrowserSession, browserFor } from './session.js';
import type { Computer } from '@husk-ai/core';

/** Enough of a Computer to construct a session. Nothing here launches one. */
function fakeComputer(id: string): Computer {
  return { id, info: { provider: 'docker', spec: {} } } as unknown as Computer;
}

/** `say` is private; this is what every internal caller goes through. */
function say(session: BrowserSession, message: string): void {
  (session as unknown as { say(m: string): void }).say(message);
}

describe('BrowserSession progress listeners', () => {
  it('delivers to a listener attached after construction', () => {
    const session = new BrowserSession(fakeComputer('c1'));
    const seen: string[] = [];
    session.onProgress((m) => seen.push(m));
    say(session, 'unpacking 111 MB');
    expect(seen).toEqual(['unpacking 111 MB']);
  });

  it('still calls the constructor option, and both together', () => {
    const opt = vi.fn();
    const session = new BrowserSession(fakeComputer('c1'), { onProgress: opt });
    const seen: string[] = [];
    session.onProgress((m) => seen.push(m));
    say(session, 'Chromium ready');
    expect(opt).toHaveBeenCalledWith('Chromium ready');
    expect(seen).toEqual(['Chromium ready']);
  });

  it('stops delivering after unsubscribe', () => {
    const session = new BrowserSession(fakeComputer('c1'));
    const seen: string[] = [];
    const off = session.onProgress((m) => seen.push(m));
    say(session, 'one');
    off();
    say(session, 'two');
    expect(seen).toEqual(['one']);
  });

  it('one listener throwing does not stop the others', () => {
    // These are network sockets on the far end. A dead one must not swallow the
    // rest of the fan-out, same rule as the event bus itself.
    const session = new BrowserSession(fakeComputer('c1'));
    const seen: string[] = [];
    session.onProgress(() => {
      throw new Error('socket closed');
    });
    session.onProgress((m) => seen.push(m));
    expect(() => say(session, 'downloading')).not.toThrow();
    expect(seen).toEqual(['downloading']);
  });

  it('a listener attached via the cached session is the same session', () => {
    // The bug in one line: the second caller must be able to observe too.
    const computer = fakeComputer('cached-1');
    const first = browserFor(computer);
    const second = browserFor(computer);
    expect(second).toBe(first);

    const seen: string[] = [];
    second.onProgress((m) => seen.push(m));
    say(first, 'starting Chromium');
    expect(seen).toEqual(['starting Chromium']);
  });
});
