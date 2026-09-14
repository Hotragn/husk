import { HuskError } from '@husk/core';
import { extractTitle, htmlToText, looksLikeHtml } from '../html.js';
import { assertUrlAllowed } from '../net.js';
import { defineTool } from '../types.js';
import type { AgentTool } from '../types.js';
import { deadline, readCapped } from './fetching.js';
import { int, object, str } from './util.js';

const DEFAULT_FETCH_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export interface FetchUrlResult {
  url: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
  truncated: boolean;
}

export const fetch_url = defineTool<{ url: string; maxBytes?: number }, FetchUrlResult>({
  name: 'fetch_url',
  description:
    'Fetch a web page or API response and return it as readable text. HTML is stripped down to its prose. ' +
    'Subject to this husk network policy: hosts outside the allow-list are refused.',
  parameters: object(
    {
      url: str('Absolute http or https URL.'),
      maxBytes: int('Cap on the body read. Defaults to 256 KiB.', { minimum: 1024 }),
    },
    ['url'],
  ),
  async handler(input, ctx) {
    const parsed = assertUrlAllowed(input.url, ctx.spec.computer.network);
    const cap = Math.min(input.maxBytes ?? DEFAULT_FETCH_BYTES, Math.max(4096, ctx.maxOutputBytes));
    const d = deadline(ctx.signal, FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(parsed, {
        redirect: 'follow',
        signal: d.signal,
        headers: { accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5' },
      });
      // A redirect chain can land somewhere the policy would have refused.
      assertUrlAllowed(res.url || parsed.toString(), ctx.spec.computer.network);

      const contentType = res.headers.get('content-type') ?? '';
      const body = await readCapped(res, cap);
      const isHtml = looksLikeHtml(contentType || null, body.text);
      return {
        url: res.url || parsed.toString(),
        status: res.status,
        contentType,
        title: isHtml ? extractTitle(body.text) : undefined,
        text: isHtml ? htmlToText(body.text) : body.text,
        truncated: body.truncated,
      };
    } catch (err) {
      if (err instanceof HuskError) throw err;
      throw new HuskError('E_TOOL_ERROR', `could not fetch ${parsed.host}: ${(err as Error).message}`, {
        hint: 'check the URL, or whether this husk is allowed to reach that host',
      });
    } finally {
      d.done();
    }
  },
  render(out) {
    const head = [`${out.status} ${out.url}`, out.title ? `title: ${out.title}` : ''].filter(Boolean).join('\n');
    return `${head}${out.truncated ? '\n[body truncated]' : ''}\n\n${out.text}`;
  },
});

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchBackend = 'tavily' | 'brave';

export function searchBackend(env: NodeJS.ProcessEnv): { backend: SearchBackend; key: string } | undefined {
  const tavily = env.TAVILY_API_KEY;
  if (tavily) return { backend: 'tavily', key: tavily };
  const brave = env.BRAVE_API_KEY ?? env.BRAVE_SEARCH_API_KEY;
  if (brave) return { backend: 'brave', key: brave };
  return undefined;
}

async function tavily(key: string, query: string, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: limit, search_depth: 'basic' }),
  });
  if (!res.ok) throw new Error(`tavily returned ${res.status}`);
  const json = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (json.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? r.url ?? '',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 600),
  }));
}

async function brave(key: string, query: string, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(limit));
  const res = await fetch(url, {
    signal,
    headers: { accept: 'application/json', 'x-subscription-token': key },
  });
  if (!res.ok) throw new Error(`brave returned ${res.status}`);
  const json = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (json.web?.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? r.url ?? '',
    url: r.url ?? '',
    snippet: (r.description ?? '').slice(0, 600),
  }));
}

/**
 * Built against whichever search key the operator actually has.
 *
 * `resolveTools` does not register this tool at all when there is no key, rather
 * than registering one that always fails: a tool the model can see is a promise
 * that it works.
 */
export function makeWebSearch(creds: { backend: SearchBackend; key: string }): AgentTool {
  return defineTool<{ query: string; limit?: number }, { query: string; results: SearchResult[] }>({
    name: 'web_search',
    description: `Search the web (via ${creds.backend}) and return titles, URLs and snippets. Follow up with fetch_url to read a result.`,
    parameters: object(
      {
        query: str('What to search for.'),
        limit: int('How many results to return. Defaults to 5.', { minimum: 1, maximum: 20 }),
      },
      ['query'],
    ),
    async handler(input, ctx) {
      const limit = input.limit ?? 5;
      const d = deadline(ctx.signal, FETCH_TIMEOUT_MS);
      try {
        const results =
          creds.backend === 'tavily'
            ? await tavily(creds.key, input.query, limit, d.signal)
            : await brave(creds.key, input.query, limit, d.signal);
        return { query: input.query, results };
      } catch (err) {
        throw new HuskError('E_TOOL_ERROR', `web search failed: ${(err as Error).message}`, {
          hint: `check that the ${creds.backend} API key is still valid`,
        });
      } finally {
        d.done();
      }
    },
    render(out) {
      if (!out.results.length) return `no results for "${out.query}"`;
      return out.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
    },
  });
}

export const webTools: AgentTool[] = [fetch_url];
