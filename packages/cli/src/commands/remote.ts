import { HuskError, readDaemonRecord } from '@husk-ai/core';
import { parse } from '../args.js';
import { EXIT_OK } from '../exit.js';
import * as ui from '../ui.js';

/**
 * `husk remote` -- remote access's owner controls, asked of the Husk on this
 * machine (`husk serve --remote`) with its own token. The claim code is shown
 * here and nowhere else: whoever types it first becomes the owner.
 */
export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { json: { type: 'boolean' } }, 'remote');
  ui.configure(values);
  const action = positionals[0] ?? 'status';
  if (!['status', 'claim', 'reset'].includes(action)) {
    throw new HuskError('E_CONFIG', `unknown remote action "${action}"`, { hint: 'husk remote, husk remote claim, or husk remote reset' });
  }
  const rec = readDaemonRecord();
  if (!rec) throw new HuskError('E_CONFIG', 'no Husk is running on this machine', { hint: 'start it with `husk serve --remote --public-url https://<host>`' });
  const ask = async (method: string, path: string) => {
    const res = await fetch(`${rec.url}${path}`, {
      method,
      headers: rec.token ? { authorization: `Bearer ${rec.token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 404) throw new HuskError('E_CONFIG', 'remote access is off', { hint: 'start it with `husk serve --remote --public-url https://<host>`' });
    if (!res.ok) {
      const err = body.error as { message?: string; hint?: string } | undefined;
      throw new HuskError('E_CONFIG', err?.message ?? `the Husk answered ${res.status}`, err?.hint ? { hint: err.hint } : {});
    }
    return body;
  };

  if (action === 'status') {
    const s = (await ask('GET', '/v1/remote')) as { endpoint: string; owner: boolean; apps: Array<{ name: string; createdAt: string }> };
    if (values.json) {
      ui.json(s);
      return EXIT_OK;
    }
    ui.print(`${ui.green('✓')} remote access on ${ui.bold(s.endpoint)}`);
    ui.print(`  owner    ${s.owner ? 'claimed, signs in with a passkey' : ui.yellow('none yet: `husk remote claim` prints a claim code')}`);
    ui.print(`  apps     ${s.apps.length ? s.apps.map((a) => a.name).join(', ') : ui.dim('none has signed in')}`);
    return EXIT_OK;
  }
  if (action === 'reset' && !values.json) ui.warn('removing the owner, every app that signed in and every token');
  const { code } = (await ask('POST', action === 'claim' ? '/v1/remote/claim' : '/v1/remote/reset')) as { code: string };
  if (values.json) {
    ui.json({ code });
    return EXIT_OK;
  }
  ui.print(`claim code ${ui.bold(code)}  ${ui.dim('good for 15 minutes, and for 5 tries')}`);
  ui.print(ui.dim('  type it on the sign-in page your chat app opens, then make a passkey'));
  return EXIT_OK;
}
