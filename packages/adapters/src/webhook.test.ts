import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from './webhook.js';

function sign(secret: string, payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

describe('verifyWebhookSignature', () => {
  const secret = 'test-secret';

  it('accepts a valid signature for the raw body', () => {
    const rawBody = '{"event":"deploy"}';

    expect(
      verifyWebhookSignature({
        secret,
        rawBody,
        signature: sign(secret, rawBody),
      }),
    ).toEqual({ ok: true });
  });

  it('rejects an invalid signature', () => {
    expect(
      verifyWebhookSignature({
        secret,
        rawBody: 'payload',
        signature: sign(secret, 'different-payload'),
      }),
    ).toEqual({ ok: false, reason: 'signature does not match' });
  });

  it('rejects a timestamp outside the replay window', () => {
    const timestamp = '1700000000';
    const rawBody = 'payload';

    expect(
      verifyWebhookSignature({
        secret,
        rawBody,
        timestamp,
        toleranceSec: 30,
        now: () => 1_700_000_031_000,
        signature: sign(secret, `${timestamp}.${rawBody}`),
      }),
    ).toEqual({ ok: false, reason: 'timestamp outside the replay window' });
  });

  it('accepts a timestamped signature inside the replay window', () => {
    const timestamp = '1700000000';
    const rawBody = 'payload';

    expect(
      verifyWebhookSignature({
        secret,
        rawBody,
        timestamp,
        toleranceSec: 30,
        now: () => 1_700_000_030_000,
        signature: sign(secret, `${timestamp}.${rawBody}`),
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a missing signature header without throwing', () => {
    expect(
      verifyWebhookSignature({
        secret,
        rawBody: 'payload',
        signature: undefined,
      }),
    ).toEqual({ ok: false, reason: 'missing signature header' });
  });

  it('rejects a missing timestamp when replay protection is enabled', () => {
    expect(
      verifyWebhookSignature({
        secret,
        rawBody: 'payload',
        toleranceSec: 30,
        signature: sign(secret, 'payload'),
      }),
    ).toEqual({ ok: false, reason: 'missing timestamp header' });
  });

  it('handles an empty raw body as a normal signed payload', () => {
    expect(
      verifyWebhookSignature({
        secret,
        rawBody: '',
        signature: sign(secret, ''),
      }),
    ).toEqual({ ok: true });
  });

  describe('a signature that parses but is the wrong shape', () => {
    const rawBody = '{"event":"deploy"}';
    const hex = createHmac('sha256', secret).update(rawBody).digest('hex');
    const check = (signature: string) => verifyWebhookSignature({ secret, rawBody, signature });

    it('accepts the bare hex some senders send, with no sha256= in front', () => {
      expect(check(hex)).toEqual({ ok: true });
    });

    it('rejects a hex too short or too long, and never throws', () => {
      // timingSafeEqual throws on buffers of unequal length; the length guard before it is what keeps this a 403 and not a 500.
      for (const signature of [`sha256=${hex.slice(0, 32)}`, `sha256=${hex}${hex}${hex}`, hex.slice(0, 1)]) {
        expect(() => check(signature)).not.toThrow();
        expect(check(signature)).toEqual({ ok: false, reason: 'signature does not match' });
      }
    });

    it('rejects a value of the right length that is not hex', () => {
      expect(check(`sha256=${'z'.repeat(hex.length)}`)).toEqual({ ok: false, reason: 'signature does not match' });
    });

    it('refuses a signature named for another algorithm, even one whose hex would match', () => {
      expect(check(`sha1=${hex}`)).toEqual({ ok: false, reason: 'signature is not sha256' });
      // The name is read without regard to case, as the hex is.
      expect(check(`SHA256=${hex.toUpperCase()}`)).toEqual({ ok: true });
    });
  });
});
