import { readDaemonRecord } from '@husk-ai/core';

/**
 * A link that opens the console signed in, once.
 *
 * The Husk mints a sign-in code that works for one use within ten minutes, and
 * the console trades it for the token, so the token itself is never printed: a
 * terminal keeps scrollback and a log gets shared. Undefined when that Husk
 * cannot make one, being older or not answering. A Husk with no token needs no
 * sign-in, and gets its plain address.
 */
export async function consoleLink(rec: { url: string; token: string | null } | undefined = readDaemonRecord()): Promise<string | undefined> {
  if (!rec) return undefined;
  if (!rec.token) return `${rec.url}/`;
  try {
    const res = await fetch(`${rec.url}/v1/console/link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${rec.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const { code } = (await res.json()) as { code?: unknown };
    return typeof code === 'string' && code ? `${rec.url}/#code=${code}` : undefined;
  } catch {
    return undefined;
  }
}
