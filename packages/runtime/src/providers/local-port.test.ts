/**
 * `exposePort` used to assert reachability rather than check it.
 *
 * The old comment -- "a local process binds the host's own network stack, so a
 * port the agent opened is already reachable" -- explains why there is nothing
 * to *forward*. It does not establish that anything is listening. An agent that
 * got back a URL for a server that had crashed on startup would be told the port
 * was published, which is the one thing it most needs to know is false.
 */

import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { portAnswers } from './local.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A listener on an OS-chosen free port, so the test never fights for one. */
async function listen(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no port');
  return addr.port;
}

describe('portAnswers', () => {
  it('is true when something is listening', async () => {
    expect(await portAnswers(await listen())).toBe(true);
  });

  it('is false when nothing is', async () => {
    // Bind then close: a port we know was free a moment ago, without guessing.
    const port = await listen();
    await new Promise<void>((r) => servers.pop()!.close(() => r()));
    // One attempt -- the retries exist for a server that is still starting, and
    // waiting them out here would only make the suite slower.
    expect(await portAnswers(port, 1)).toBe(false);
  });

  it('waits for a listener that is still coming up', async () => {
    // The ordinary sequence: the agent exposes the port, then the server binds.
    const server = createServer();
    servers.push(server);
    const port = await listen();
    await new Promise<void>((r) => servers.shift()!.close(() => r()));

    setTimeout(() => server.listen(port, '127.0.0.1'), 200);
    expect(await portAnswers(port)).toBe(true);
  });
});
