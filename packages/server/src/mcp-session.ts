import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { ComputerSpec, ProviderName } from '@husk/core';
import { bearerToken, isLoopbackHost } from './auth.js';
import type { ManagerLike } from './deps.js';
import { huskError } from './errors.js';

/**
 * Who a remote MCP request is, and which computer that entitles it to.
 *
 * The stdio server binds one key -- `mcp` -- because one process serves one
 * client. An HTTP endpoint serves many chat sessions from many people over one
 * socket, so the same assumption becomes a privacy bug: every session would
 * land on one `/work` and read each other's files. Nothing here is about
 * naming; it is about deciding what two requests have to have in common before
 * they are allowed to share a filesystem.
 */

/** The header and query parameter a client can use to pin a workspace. */
export const SESSION_HEADER = 'x-husk-session';
export const SESSION_QUERY = 'session';

export interface SessionIdentity {
  /** The full binding key handed to `ComputerManager.ensure`. */
  key: string;
  /** Stable, non-reversible label for the credential used. */
  principal: string;
  /** Where the session half of the key came from, for logs and diagnostics. */
  source: 'explicit' | 'mcp-session' | 'principal';
}

/**
 * Hash the credential rather than storing it.
 *
 * The binding key is written to `~/.husk/computers/bindings.json` and appears
 * in the `husk.key` label on the computer itself. A bearer token in either
 * place is a credential at rest in a file nobody thinks of as a secret store,
 * so only a digest of it travels.
 */
function principalOf(token: string | undefined): string {
  if (!token) return 'anon';
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) return firstString(value[0]);
  return undefined;
}

/**
 * Sanitise the session half of the key.
 *
 * It reaches a filename via the bindings file and a container label via
 * `husk.key`, and it arrives from a header, so it is untrusted input. Anything
 * outside a conservative set is hashed rather than rejected: a client with an
 * exotic session id should still work, just not get to choose bytes that end up
 * in a path.
 */
function safeSessionPart(raw: string): string {
  const trimmed = raw.slice(0, 200);
  return /^[A-Za-z0-9._-]{1,200}$/.test(trimmed)
    ? trimmed
    : createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export interface SessionKeyInput {
  /** `X-Husk-Session` or `?session=`, when the client pinned one. */
  explicitSession?: string | undefined;
  /** The transport's `Mcp-Session-Id`, when the protocol negotiated one. */
  mcpSessionId?: string | undefined;
  /** The bearer token the request authenticated with, if any. */
  token?: string | undefined;
}

/**
 * Derive the binding key for one remote MCP session.
 *
 * The credential is always mixed in, so two tokens never share a `/work`
 * whatever they claim about their session. The session half is resolved in
 * order of how much we trust it to mean "this conversation":
 *
 * 1. `explicit` -- the client asked for a named workspace and can come back to
 *    it. The only option that survives a client restart.
 * 2. `mcp-session` -- the `Mcp-Session-Id` the transport negotiated. Right for
 *    2025-era clients, and gone in the 2026-07-28 revision, which removed
 *    protocol-level sessions entirely. Relying on it alone would have made this
 *    endpoint degrade into shared-workspace behaviour against a new client --
 *    silently, and in the direction of *less* isolation.
 * 3. `principal` -- one workspace per credential. The stateless fallback: still
 *    isolated between callers, just not between two chats by the same caller.
 */
export function sessionBindingKey(input: SessionKeyInput): SessionIdentity {
  const principal = principalOf(input.token);
  const explicit = input.explicitSession?.trim();
  if (explicit) {
    return { key: `mcp:http:${principal}:s-${safeSessionPart(explicit)}`, principal, source: 'explicit' };
  }
  const negotiated = input.mcpSessionId?.trim();
  if (negotiated) {
    return { key: `mcp:http:${principal}:m-${safeSessionPart(negotiated)}`, principal, source: 'mcp-session' };
  }
  return { key: `mcp:http:${principal}:default`, principal, source: 'principal' };
}

/** Pull the session hints out of a request. */
export function sessionKeyForRequest(req: FastifyRequest, mcpSessionId?: string): SessionIdentity {
  const query = (req.query ?? {}) as Record<string, unknown>;
  return sessionBindingKey({
    explicitSession: firstString(req.headers[SESSION_HEADER]) ?? firstString(query[SESSION_QUERY]),
    mcpSessionId: mcpSessionId ?? firstString(req.headers['mcp-session-id']),
    token: bearerToken(req) ?? firstString(query['token']) ?? firstString(query['access_token']),
  });
}

// ---------------------------------------------------------------------------
// what may back a remote endpoint
// ---------------------------------------------------------------------------

/**
 * Providers a remote endpoint may use, and why the list is not a list.
 *
 * The rule is the provider's own isolation claim, not its name. `husk doctor`
 * already reports `local  not isolated`, and the local provider's own comments
 * say a prompt-injected model is closer to an adversary than to an accident --
 * so an HTTP endpoint backed by it means remote input driving unsandboxed shell
 * commands on the user's laptop. §6.5 of docs/SPEC-remote-mcp.md makes it
 * concrete: from inside one `local` computer, `shell` reads every other
 * computer's `/work` and all of `C:` through `/mnt/c`. Per-session binding does
 * not fix that -- two sessions can reach each other's disks regardless of which
 * key they hold -- which is why this gate is separate from the binding and
 * cannot be satisfied by getting the binding right.
 *
 * Testing the claim rather than the name means a provider added later is
 * governed by the same rule without anyone remembering to update a constant.
 */
export const REMOTE_PROVIDER_HINT = 'run `husk serve` with Docker running, or set HUSK_PROVIDER=fly';

export async function assertProviderMayServeRemote(manager: ManagerLike, spec: ComputerSpec = {}): Promise<void> {
  const rows = await manager.status();
  const requested = spec.provider;

  if (requested && requested !== 'auto') {
    const row = rows.find((r) => r.name === requested);
    if (!row) {
      throw huskError('E_PROVIDER_UNAVAILABLE', `unknown provider: ${requested}`, {
        hint: `known providers: ${rows.map((r) => r.name).join(', ')}`,
      });
    }
    assertIsolated(row);
    return;
  }

  // `auto` walks highest-priority-first and stops at the first available
  // provider, so the one that would actually be chosen is the one to judge --
  // not the best one installed.
  const chosen = [...rows].sort((a, b) => b.priority - a.priority).find((r) => r.available);
  if (!chosen) {
    throw huskError('E_PROVIDER_UNAVAILABLE', 'no computer provider is usable', {
      hint: 'run `husk doctor` for the full picture',
    });
  }
  assertIsolated(chosen);
}

function assertIsolated(row: {
  name: ProviderName | string;
  available: boolean;
  isolated?: boolean;
  reason?: string;
  hint?: string;
}): void {
  if (!row.available) {
    throw huskError('E_PROVIDER_UNAVAILABLE', `provider "${row.name}" is not usable: ${row.reason ?? 'unknown'}`, {
      hint: row.hint ?? 'run `husk doctor` to see what is available',
    });
  }
  if (row.isolated === true) return;

  throw huskError(
    'E_EXEC_DENIED',
    `the "${row.name}" provider is not isolated, so it cannot back the remote MCP endpoint`,
    {
      hint: REMOTE_PROVIDER_HINT,
      details: {
        provider: row.name,
        reason: row.reason ?? 'not isolated',
        why:
          'a remote endpoint means input from a chat surface drives shell commands; on an ' +
          'unisolated provider those run against the host filesystem, and one computer can ' +
          'read every other computer through /mnt/c',
      },
    },
  );
}

/**
 * Refuse to serve MCP over a non-loopback bind with no credential.
 *
 * `assertBindIsSafe` already makes this true for the whole control plane, and
 * this is deliberately a second, narrower check rather than a reuse of it: the
 * MCP endpoint is the one route whose entire purpose is to be reached from
 * somewhere else, and `createApp` has an `unsafeAllowAnyBind` escape hatch for
 * tests. An escape hatch for tests should not also be an escape hatch for
 * putting an unauthenticated shell on the network.
 */
export function assertMcpBindIsSafe(host: string, token: string | undefined): void {
  if (token) return;
  if (isLoopbackHost(host)) return;
  throw huskError('E_CONFIG', `refusing to serve MCP on ${host} without an auth token`, {
    hint: `set HUSK_TOKEN=$(openssl rand -hex 32), or bind 127.0.0.1 and use \`husk mcp\` over stdio`,
  });
}
