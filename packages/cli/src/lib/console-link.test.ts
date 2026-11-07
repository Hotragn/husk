import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleLink } from './console-link.js';

const HUSK = 'http://127.0.0.1:7377';

describe('a console link that signs you in', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the Husk for a code with its token, and never puts the token in the link', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
        return Response.json({ code: 'c0de' });
      }),
    );
    const link = await consoleLink({ url: HUSK, token: 'secret' });
    expect(link).toBe(`${HUSK}/#code=c0de`);
    expect(link).not.toContain('secret');
    expect(seen).toEqual([{ url: `${HUSK}/v1/console/link`, auth: 'Bearer secret' }]);
  });

  it('gives a Husk with no token its plain address, and nothing for one that cannot mint a code', async () => {
    expect(await consoleLink({ url: HUSK, token: null })).toBe(`${HUSK}/`);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    expect(await consoleLink({ url: HUSK, token: 'secret' })).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    expect(await consoleLink({ url: HUSK, token: 'secret' })).toBeUndefined();
  });
});
