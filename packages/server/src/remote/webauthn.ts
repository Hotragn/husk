import { createHash, createPublicKey, verify } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

/**
 * Passkeys for the owner of a remote Husk: just enough of WebAuthn Level 2 to
 * register one credential and check its signatures, on node:crypto alone.
 *
 * Attestation is not checked: Husk asks for none, and trusts the key it was
 * given at the claim, not the maker of the device holding it.
 * https://www.w3.org/TR/webauthn-2/#sctn-registering-a-new-credential
 * https://www.w3.org/TR/webauthn-2/#sctn-verifying-assertion
 */

/** The COSE algorithms Husk accepts: ES256, EdDSA, RS256. */
export const ALGORITHMS = [-7, -8, -257] as const;

export interface Credential {
  /** base64url, as the browser gives it. */
  id: string;
  publicKey: JsonWebKey;
  alg: number;
  signCount: number;
}

export interface Expected {
  /** base64url of the challenge this server issued. */
  challenge: string;
  /** The public URL's origin, e.g. https://box.tail1234.ts.net */
  origin: string;
  /** Its host. */
  rpId: string;
}

class WebAuthnError extends Error {}
const fail = (why: string): never => {
  throw new WebAuthnError(why);
};

/**
 * CBOR, the subset a WebAuthn attestation object and a COSE key use: integers,
 * byte and text strings, arrays, maps and the three simple values, all of
 * definite length. Anything else (tags, floats, indefinite lengths) is refused.
 */
export function decodeCbor(bytes: Uint8Array): { value: unknown; end: number } {
  let at = 0;
  const need = (n: number) => {
    if (at + n > bytes.length) fail('the authenticator sent truncated data');
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : fail('unsupported CBOR length');
    need(size);
    let n = 0;
    for (let i = 0; i < size; i++) n = n * 256 + bytes[at++]!;
    if (!Number.isSafeInteger(n)) fail('CBOR length out of range');
    return n;
  };
  const item = (depth: number): unknown => {
    if (depth > 16) fail('CBOR nested too deep');
    need(1);
    const head = bytes[at++]!;
    const major = head >> 5;
    const info = head & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      return fail('unsupported CBOR simple value');
    }
    const n = length(info);
    switch (major) {
      case 0:
        return n;
      case 1:
        return -1 - n;
      case 2: {
        need(n);
        const out = bytes.slice(at, at + n);
        at += n;
        return out;
      }
      case 3: {
        need(n);
        const out = Buffer.from(bytes.slice(at, at + n)).toString('utf8');
        at += n;
        return out;
      }
      case 4: {
        if (n > 1024) fail('CBOR array too long');
        return Array.from({ length: n }, () => item(depth + 1));
      }
      case 5: {
        if (n > 1024) fail('CBOR map too long');
        const map = new Map<unknown, unknown>();
        for (let i = 0; i < n; i++) map.set(item(depth + 1), item(depth + 1));
        return map;
      }
      default:
        return fail('unsupported CBOR type');
    }
  };
  const value = item(0);
  return { value, end: at };
}

interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  credentialId?: Buffer;
  cose?: Map<unknown, unknown>;
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

function parseAuthData(data: Uint8Array): AuthData {
  if (data.length < 37) fail('authenticator data is too short');
  const buf = Buffer.from(data);
  const out: AuthData = { rpIdHash: buf.subarray(0, 32), flags: buf[32]!, signCount: buf.readUInt32BE(33) };
  if (out.flags & AT) {
    if (buf.length < 55) fail('authenticator data is too short for a credential');
    const idLength = buf.readUInt16BE(53);
    if (buf.length < 55 + idLength + 1) fail('authenticator data is too short for its credential id');
    out.credentialId = buf.subarray(55, 55 + idLength);
    const key = decodeCbor(buf.subarray(55 + idLength)).value;
    if (!(key instanceof Map)) fail('the credential public key is not a COSE key');
    out.cose = key as Map<unknown, unknown>;
  }
  return out;
}

/** A COSE key as a JWK node:crypto reads, refusing any algorithm Husk does not accept. */
function jwkOf(cose: Map<unknown, unknown>): { jwk: JsonWebKey; alg: number } {
  const alg = cose.get(3);
  const kty = cose.get(1);
  const bytes = (label: number) => {
    const v = cose.get(label);
    return v instanceof Uint8Array ? Buffer.from(v).toString('base64url') : fail('the COSE key is missing a part');
  };
  if (alg === -7 && kty === 2 && cose.get(-1) === 1) return { jwk: { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) }, alg };
  if (alg === -8 && kty === 1 && cose.get(-1) === 6) return { jwk: { kty: 'OKP', crv: 'Ed25519', x: bytes(-2) }, alg };
  if (alg === -257 && kty === 3) return { jwk: { kty: 'RSA', n: bytes(-1), e: bytes(-2) }, alg };
  return fail('the passkey uses an algorithm Husk does not accept');
}

function checkClientData(clientDataJSON: Buffer, type: string, expected: Expected): void {
  let client: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    client = JSON.parse(clientDataJSON.toString('utf8')) as typeof client;
  } catch {
    return fail('client data is not JSON');
  }
  if (client.type !== type) fail(`client data is not ${type}`);
  if (client.challenge !== expected.challenge) fail('the challenge does not match');
  if (client.origin !== expected.origin) fail('the passkey was used from another origin');
  if (client.crossOrigin === true) fail('the passkey was used from inside another site');
}

function checkAuthData(auth: AuthData, expected: Expected): void {
  if (!auth.rpIdHash.equals(createHash('sha256').update(expected.rpId).digest())) fail('the passkey is for another site');
  if (!(auth.flags & UP)) fail('the person was not present');
  if (!(auth.flags & UV)) fail('the person was not verified');
}

/** The new credential from a registration (`navigator.credentials.create`). */
export function verifyRegistration(input: { clientDataJSON: string; attestationObject: string }, expected: Expected): Credential {
  try {
    checkClientData(Buffer.from(input.clientDataJSON, 'base64url'), 'webauthn.create', expected);
    const decoded = decodeCbor(Buffer.from(input.attestationObject, 'base64url')).value;
    const authData = decoded instanceof Map ? decoded.get('authData') : undefined;
    if (!(authData instanceof Uint8Array)) fail('the attestation has no authenticator data');
    const auth = parseAuthData(authData as Uint8Array);
    checkAuthData(auth, expected);
    if (!auth.credentialId || !auth.cose) fail('the authenticator returned no credential');
    const { jwk, alg } = jwkOf(auth.cose!);
    createPublicKey({ key: jwk, format: 'jwk' });
    return { id: auth.credentialId!.toString('base64url'), publicKey: jwk, alg, signCount: auth.signCount };
  } catch (err) {
    throw err instanceof WebAuthnError ? err : new WebAuthnError(`the registration could not be read: ${(err as Error).message}`);
  }
}

/**
 * Check a sign-in (`navigator.credentials.get`) against the stored credential.
 * Returns the authenticator's new signature counter.
 */
export function verifyAssertion(
  input: { id: string; clientDataJSON: string; authenticatorData: string; signature: string },
  credential: Credential,
  expected: Expected,
): number {
  try {
    if (input.id !== credential.id) fail('this is not the owner’s passkey');
    const clientData = Buffer.from(input.clientDataJSON, 'base64url');
    checkClientData(clientData, 'webauthn.get', expected);
    const authData = Buffer.from(input.authenticatorData, 'base64url');
    const auth = parseAuthData(authData);
    checkAuthData(auth, expected);
    const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
    const key = createPublicKey({ key: credential.publicKey, format: 'jwk' });
    const signature = Buffer.from(input.signature, 'base64url');
    const ok = credential.alg === -8 ? verify(null, signed, key, signature) : verify('sha256', signed, key, signature);
    if (!ok) fail('the signature does not match the owner’s passkey');
    // A counter that does not go up means a cloned authenticator. Zero both times means it keeps
    // none (synced passkeys); zero after a count is a copy trying to start again (WebAuthn §7.2).
    if ((auth.signCount !== 0 || credential.signCount !== 0) && auth.signCount <= credential.signCount) fail('the passkey’s counter went backwards');
    return auth.signCount;
  } catch (err) {
    throw err instanceof WebAuthnError ? err : new WebAuthnError(`the sign-in could not be read: ${(err as Error).message}`);
  }
}

export { WebAuthnError };
