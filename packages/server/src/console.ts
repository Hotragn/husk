import { existsSync } from 'node:fs';
import { setNotFoundFallback } from './errors.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUSK_VERSION } from '@husk-ai/core';
import type { FastifyInstance } from 'fastify';

/**
 * Where a built console might be, relative to this file inside `dist/`.
 *
 * Checked in order and the first hit wins, so a monorepo checkout and an installed
 * `node_modules/@husk-ai/server` both find it without configuration.
 */
function candidateDirs(here: string): string[] {
  return [
    resolve(here, '../../console/dist'),
    resolve(here, '../../../apps/console/dist'),
    resolve(here, '../../../../apps/console/dist'),
    resolve(process.cwd(), 'apps/console/dist'),
  ];
}

export function findConsoleDir(explicit?: string): string | undefined {
  if (explicit) return existsSync(join(explicit, 'index.html')) ? explicit : undefined;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of candidateDirs(here)) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return undefined;
}

const PLACEHOLDER = (authed: boolean) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Husk ${HUSK_VERSION}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0b0c0e; color:#e6e6e6;
         font:15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width:34rem; padding:2rem; }
  h1 { font-size:1.1rem; letter-spacing:.08em; text-transform:uppercase; color:#8b8f96; margin:0 0 1.5rem; }
  pre { background:#141619; border:1px solid #23262b; border-radius:6px; padding:.85rem 1rem; overflow-x:auto; }
  a { color:#7fd1b9; }
  ul { padding-left:1.1rem; } li { margin:.35rem 0; }
  .dim { color:#71757c; }
</style>
</head>
<body>
<main>
  <h1>Husk ${HUSK_VERSION} &middot; control plane</h1>
  <p>The API is up. The dashboard bundle has not been built yet.</p>
  <pre>npm run build --workspace=@husk-ai/console</pre>
  <p>Then reload this page. In the meantime:</p>
  <ul>
    <li><a href="/health">/health</a> <span class="dim">liveness</span></li>
    <li><a href="/v1/doctor">/v1/doctor</a> <span class="dim">what this machine can actually do</span></li>
    <li><code>/v1/computers</code> <span class="dim">the machines</span></li>
    <li><code>/v1/husks</code> <span class="dim">the agents</span></li>
    <li><code>/v1/triggers</code> <span class="dim">what is mounted as a bot</span></li>
  </ul>
  <p class="dim">${authed ? 'HUSK_TOKEN is set: send Authorization: Bearer &lt;token&gt;.' : 'No token configured, so this server accepts loopback connections only.'}</p>
</main>
</body>
</html>
`;

/**
 * Serve the console when it exists, explain how to build it when it does not.
 *
 * A missing `apps/console/dist` is the normal state of a fresh clone. `husk serve`
 * failing to boot because of it would be absurd, so this never throws.
 */
export async function installConsole(app: FastifyInstance, explicitDir?: string): Promise<string | undefined> {
  const dir = findConsoleDir(explicitDir);

  if (!dir) {
    const page = PLACEHOLDER(app.huskAuthEnabled === true);
    app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(page));
    return undefined;
  }

  const staticPlugin = (await import('@fastify/static')).default;
  // `wildcard: true` resolves each request against the directory when it
  // arrives. With `false`, the plugin enumerates the directory once at boot and
  // registers a route per file -- so rebuilding the console under a running
  // server 404s every new content-hashed asset and the page renders blank, with
  // nothing in the UI to say why. A silent white screen is not an acceptable
  // outcome for `npm run build` in another terminal.
  await app.register(staticPlugin, { root: dir, prefix: '/', index: ['index.html'], wildcard: true });

  // A single-page app owns its own routing: anything that is not an API path and
  // not a real file has to fall through to index.html or a deep link 404s.
  //
  // Registered as a fallback rather than a second `setNotFoundHandler`, because
  // Fastify permits only one per scope and `installErrorHandling` already owns it.
  setNotFoundFallback((req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    const isApi = path.startsWith('/v1') || path === '/health';
    const looksLikeFile = /\.[a-z0-9]{2,5}$/i.test(path);
    if (req.method !== 'GET' || isApi || looksLikeFile) return false;
    void reply.type('text/html; charset=utf-8').sendFile('index.html');
    return true;
  });

  return dir;
}
