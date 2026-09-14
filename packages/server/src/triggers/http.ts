import type { FastifyRequest } from 'fastify';

export function headerString(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
}

export function wantsStream(req: FastifyRequest): boolean {
  const accept = req.headers.accept;
  if (typeof accept === 'string' && accept.includes('text/event-stream')) return true;
  return (req.query as { stream?: string } | undefined)?.stream === 'true';
}

/**
 * Pull a prompt out of whatever the caller sent.
 *
 * A husk mounted at an HTTP trigger is hit by curl, by a form, by GitHub, and by
 * whatever internal tool someone wires up on a Friday. Insisting on one field shape
 * makes the feature useless for most of those, so the common keys are all accepted
 * and an unrecognised JSON body is handed over whole rather than dropped.
 */
export function extractInput(req: FastifyRequest): string | undefined {
  const q = (req.query ?? {}) as { input?: unknown; text?: unknown; q?: unknown };
  for (const v of [q.input, q.text, q.q]) if (typeof v === 'string' && v.trim()) return v;

  const body = req.body;
  if (typeof body === 'string' && body.trim()) return body;
  if (Buffer.isBuffer(body) && body.length > 0) return body.toString('utf8');
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const key of ['input', 'text', 'message', 'prompt', 'content', 'query']) {
      const v = b[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    const json = JSON.stringify(body);
    if (json && json !== '{}' && json !== 'null') return json;
  }
  return undefined;
}

export interface HttpMount {
  husk: string;
  auth: 'none' | 'token';
}

/** `/<husk>` plus the trigger's own path, normalised so lookups are exact. */
export function mountKey(husk: string, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  const joined = `/${husk}${clean === '/' ? '' : clean}`;
  return joined.replace(/\/+$/, '') || `/${husk}`;
}
