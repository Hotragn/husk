import { sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * Access tokens for remote access: JWTs signed with Ed25519. One algorithm,
 * pinned. A header that names any other (`none`, `HS256` with the public key
 * as a secret, ...) or another key id is refused before the signature is
 * looked at, and every time claim is required.
 */

export interface AccessClaims {
  /** The public URL. */
  iss: string;
  /** `<public URL>/mcp`: a token minted for another URL is not this server's. */
  aud: string;
  /** The owner. */
  sub: string;
  client_id: string;
  scope: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

const PART = /^[A-Za-z0-9_-]+$/;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function signAccessToken(key: KeyObject, kid: string, claims: AccessClaims): string {
  const head = `${encode({ alg: 'EdDSA', typ: 'at+jwt', kid })}.${encode(claims)}`;
  return `${head}.${sign(null, Buffer.from(head), key).toString('base64url')}`;
}

function decode(part: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The token's claims when this server issued it, for this audience, and it is in date. Times are in seconds. */
export function verifyAccessToken(
  token: string,
  key: KeyObject,
  kid: string,
  expect: { iss: string; aud: string; now: number },
): AccessClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => PART.test(p))) return undefined;
  const [head, body, signature] = parts as [string, string, string];
  const header = decode(head);
  if (header?.alg !== 'EdDSA' || header.kid !== kid) return undefined;
  if (!verify(null, Buffer.from(`${head}.${body}`), key, Buffer.from(signature, 'base64url'))) return undefined;
  const c = decode(body);
  if (!c || c.iss !== expect.iss || c.aud !== expect.aud || typeof c.sub !== 'string' || typeof c.client_id !== 'string') return undefined;
  if (typeof c.exp !== 'number' || typeof c.nbf !== 'number' || typeof c.iat !== 'number') return undefined;
  if (expect.now >= c.exp || expect.now < c.nbf) return undefined;
  return c as unknown as AccessClaims;
}
