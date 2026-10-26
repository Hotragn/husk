import { createMcpHandler } from '@modelcontextprotocol/server';
import { platformName } from '@husk-ai/core';
import type { Logger } from '@husk-ai/core';
import type { RemoteApp, RemoteMcp } from '@husk-ai/server';
import { HuskMcpServer } from './server.js';
import type { HuskMcpOptions } from './server.js';

/**
 * `/mcp` for remote access (J6-c), served inside the shared Husk. Each
 * signed-in app gets a Husk of its own, as a chat app gets its own stdio
 * process on this machine: its chats carry their computer ids, the explicit
 * handles of MCP 2026-07-28, and its computers are bound under the owner,
 * apart from this machine's chats. Both protocol eras, request by request.
 *
 * `provider` is one with a real boundary, which `serve` has checked: remotely,
 * a chat never reaches the files of the machine Husk runs on.
 */
export function createRemoteMcp(opts: { provider: string; logger?: Logger; /** For tests. */ husk?: HuskMcpOptions }): RemoteMcp {
  const husks = new Map<string, HuskMcpServer>();
  const handler = createMcpHandler((ctx) => {
    const who = ctx.authInfo?.extra as RemoteApp | undefined;
    if (!who) throw new Error('a remote MCP request without a signed-in app');
    const key = `${who.owner}\n${who.client}`;
    let husk = husks.get(key);
    if (!husk) {
      husk = new HuskMcpServer({
        ...opts.husk,
        spec: { provider: opts.provider },
        ephemeral: false,
        remote: { owner: who.owner, platform: platformName(who.name), approve: who.approve, origin: who.origin, client: who.client },
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
      husks.set(key, husk);
    }
    return husk.newServer();
  });
  return (request, who) => handler.fetch(request, { authInfo: { token: '', clientId: who.client, scopes: ['husk'], extra: who as unknown as Record<string, unknown> } });
}
