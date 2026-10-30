import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The one-time code that makes someone the owner of a remote Husk. Shown only
 * on the machine; 80 random bits in Crockford base32, read without regard to
 * case, dashes or the letters Crockford reads as digits.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CLAIM_TTL_MS = 15 * 60 * 1000;
export const CLAIM_ATTEMPTS = 5;

export interface StoredClaim {
  /** SHA-256 of the normalized code: the code itself is never stored. */
  hash: string;
  expiresAt: number;
  attempts: number;
}

/** A new code, as 16 characters, and what to store for it. */
export function newClaim(now: number): { code: string; stored: StoredClaim } {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let code = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      code += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return { code, stored: { hash: hashOf(code), expiresAt: now + CLAIM_TTL_MS, attempts: 0 } };
}

/** As it is printed: four groups of four. */
export const formatClaim = (code: string): string => code.match(/.{1,4}/g)!.join('-');

function normalize(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

function hashOf(code: string): string {
  return createHash('sha256').update(normalize(code)).digest('hex');
}

export type ClaimCheck = 'ok' | 'wrong' | 'expired' | 'spent';

/**
 * Check a typed code. A wrong one counts against the code, wherever it came
 * from: behind a tunnel every request is from loopback. The fifth wrong one
 * spends it; a new code needs `husk remote claim` on the machine.
 */
export function checkClaim(stored: StoredClaim | undefined, typed: string, now: number): ClaimCheck {
  if (!stored || stored.attempts >= CLAIM_ATTEMPTS) return 'spent';
  if (now >= stored.expiresAt) return 'expired';
  const ok = timingSafeEqual(Buffer.from(hashOf(typed), 'hex'), Buffer.from(stored.hash, 'hex'));
  if (ok) return 'ok';
  stored.attempts++;
  return 'wrong';
}
