import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ConnectionProvider, useConnection } from './connection';

function Status() {
  const { status, signInError } = useConnection();
  return <p>{signInError ? `${status} | ${signInError}` : status}</p>;
}

const signedOut = (message: string) => Response.json({ error: { code: 'E_NO_CREDENTIALS', message } }, { status: 401 });

/** A Husk whose token is `tok`, and which takes the sign-in code `good` once. */
function husk(): string[] {
  const calls: string[] = [];
  let spent = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/health') return Response.json({ ok: true, version: '0.2.0' });
      if (path === '/v1/scoped/console') {
        if (auth !== 'Bearer good' || spent) return signedOut('this sign-in link was already used, or has expired');
        spent = true;
        return Response.json({ token: 'tok' });
      }
      if (path === '/v1/handoffs') return auth === 'Bearer tok' ? Response.json({ handoffs: [] }) : signedOut('missing Authorization: Bearer <token>');
      return Response.json({});
    }),
  );
  return calls;
}

describe('signing in with a link from husk console', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('trades the code once, even under StrictMode, and is signed in', async () => {
    const calls = husk();
    window.history.replaceState(null, '', '/#code=good');
    render(
      <StrictMode>
        <ConnectionProvider>
          <Status />
        </ConnectionProvider>
      </StrictMode>,
    );
    await screen.findByText('connected');
    expect(calls.filter((c) => c === 'POST /v1/scoped/console')).toHaveLength(1);
    expect(window.sessionStorage.getItem('husk.console.token')).toBe('tok');
  });

  it('says a spent link is spent, and asks for a sign-in', async () => {
    husk();
    window.history.replaceState(null, '', '/#code=used');
    render(
      <ConnectionProvider>
        <Status />
      </ConnectionProvider>,
    );
    await screen.findByText(/^unauthorized \| That sign-in link was already used/);
  });

  it('asks for a sign-in when Husk answers but this tab has no token', async () => {
    husk();
    render(
      <ConnectionProvider>
        <Status />
      </ConnectionProvider>,
    );
    await screen.findByText('unauthorized');
  });
});
