import { HuskError } from '@husk-ai/core';
import { assertUrlAllowed } from '../net.js';
import { defineTool } from '../types.js';
import type { AgentTool } from '../types.js';
import { deadline, headerRecord, readCapped } from './fetching.js';
import { int, object, str } from './util.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const HTTP_TIMEOUT_MS = 60_000;
const DEFAULT_HTTP_BYTES = 256 * 1024;

/** Headers we refuse to forward, because forging them is how SSRF becomes RCE. */
const BLOCKED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade']);

export interface HttpResult {
  url: string;
  method: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export const http_request = defineTool<
  { url: string; method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number },
  HttpResult
>({
  name: 'http_request',
  description:
    'Make an arbitrary HTTP request and return status, headers and body. Use this for APIs that need a method, ' +
    'headers or a request body; use fetch_url when you just want to read a page.',
  dangerous: true,
  optIn: true,
  parameters: object(
    {
      url: str('Absolute http or https URL.'),
      method: str('HTTP method. Defaults to GET.', { enum: [...METHODS] }),
      headers: {
        type: 'object',
        description: 'Request headers.',
        additionalProperties: { type: 'string' },
      },
      body: str('Request body, already serialised.'),
      maxBytes: int('Cap on the response body read. Defaults to 256 KiB.', { minimum: 1024 }),
    },
    ['url'],
  ),
  async handler(input, ctx) {
    const method = (input.method ?? 'GET').toUpperCase();
    if (!(METHODS as readonly string[]).includes(method)) {
      throw new HuskError('E_TOOL_ERROR', `unsupported HTTP method: ${method}`, {
        hint: `use one of ${METHODS.join(', ')}`,
      });
    }
    const parsed = assertUrlAllowed(input.url, ctx.spec.computer.network);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers ?? {})) {
      if (BLOCKED_HEADERS.has(k.toLowerCase())) continue;
      headers[k] = String(v);
    }

    const cap = Math.min(input.maxBytes ?? DEFAULT_HTTP_BYTES, Math.max(4096, ctx.maxOutputBytes));
    const d = deadline(ctx.signal, HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(parsed, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : input.body,
        redirect: 'follow',
        signal: d.signal,
      });
      assertUrlAllowed(res.url || parsed.toString(), ctx.spec.computer.network);
      const body = await readCapped(res, cap);
      return {
        url: res.url || parsed.toString(),
        method,
        status: res.status,
        statusText: res.statusText,
        headers: headerRecord(res.headers),
        body: body.text,
        truncated: body.truncated,
      };
    } catch (err) {
      if (err instanceof HuskError) throw err;
      throw new HuskError('E_TOOL_ERROR', `${method} ${parsed.host} failed: ${(err as Error).message}`, {
        hint: 'check the URL and whether this husk is allowed to reach that host',
      });
    } finally {
      d.done();
    }
  },
  render(out) {
    const ct = out.headers['content-type'] ?? '';
    return `${out.status} ${out.statusText} (${ct})${out.truncated ? ' [body truncated]' : ''}\n\n${out.body}`;
  },
});

export const httpTools: AgentTool[] = [http_request];
