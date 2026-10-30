import { assertUrlAllowed } from '@husk-ai/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchChecked } from './fetching.js';

/** A web of canned answers: URL -> [status, location?]. Records every request made. */
function web(answers: Record<string, [number, string?]>) {
  const asked: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = String(input);
      asked.push({ url, method: init.method ?? 'GET', body: init.body, headers: Object.fromEntries(new Headers(init.headers)) });
      const [status, location] = answers[url] ?? [200];
      return new Response(status === 200 ? `page at ${url}` : null, { status, headers: location ? { location } : {} });
    }),
  );
  return asked;
}

const policy = undefined; // the default: anywhere but internal addresses
const check = (u: string) => assertUrlAllowed(u, policy);

describe('following a redirect from the host', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses a hop to an internal address before asking it', async () => {
    const asked = web({ 'https://example.com/': [302, 'http://169.254.169.254/latest/meta-data/'] });
    await expect(fetchChecked(new URL('https://example.com/'), {}, check)).rejects.toMatchObject({ code: 'E_EXEC_DENIED' });
    expect(asked.map((a) => a.url)).toEqual(['https://example.com/']);
  });

  it('stops a public, internal, public chain at the internal hop', async () => {
    const asked = web({
      'https://a.example/': [302, 'http://10.0.0.5/admin'],
      'http://10.0.0.5/admin': [302, 'https://b.example/'],
    });
    await expect(fetchChecked(new URL('https://a.example/'), {}, check)).rejects.toMatchObject({ code: 'E_EXEC_DENIED' });
    expect(asked).toHaveLength(1);
  });

  it('follows allowed hops, and says where it ended', async () => {
    web({ 'https://a.example/x': [301, '/y'], 'https://a.example/y': [307, 'https://b.example/z'] });
    const { res, url } = await fetchChecked(new URL('https://a.example/x'), {}, check);
    expect(url.toString()).toBe('https://b.example/z');
    expect(await res.text()).toBe('page at https://b.example/z');
  });

  it('goes on as a GET after a 303, and keeps no credentials across origins', async () => {
    const asked = web({ 'https://api.example/form': [303, 'https://other.example/done'] });
    await fetchChecked(new URL('https://api.example/form'), { method: 'POST', body: 'a=1', headers: { authorization: 'Bearer secret', 'content-type': 'text/plain' } }, check);
    expect(asked[1]).toMatchObject({ url: 'https://other.example/done', method: 'GET', body: undefined });
    expect(asked[1]!.headers.authorization).toBeUndefined();
    expect(asked[1]!.headers['content-type']).toBeUndefined();
    expect(asked[0]!.headers.authorization).toBe('Bearer secret');
  });

  it('gives up on a loop', async () => {
    web({ 'https://loop.example/': [302, 'https://loop.example/'] });
    await expect(fetchChecked(new URL('https://loop.example/'), {}, check)).rejects.toThrow(/more than 10 redirects/);
  });
});
