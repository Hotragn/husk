/**
 * Credentials the redactor used to hand straight through.
 *
 * Both found by feeding it real-shaped keys rather than by reading the pattern
 * list:
 *
 *  - `sk-proj-...` (OpenAI project keys). The rule was
 *    `/\b(sk-[A-Za-z0-9]{20,})/` -- a character class with no hyphen, so the
 *    match stopped at the second dash after 7 characters and never reached the
 *    20-character minimum. A full project key came back untouched.
 *  - `Authorization: Bearer ...`. A bearer token has no prefix of its own, so
 *    nothing in a prefix-based list could ever match one, whatever the
 *    provider. The header is the only thing that marks it.
 *
 * `redact` is the chokepoint every tool result, audit entry and error message
 * passes through, so a gap here is a key in a log file rather than a key on a
 * screen.
 */

import { describe, expect, it } from 'vitest';
import { redact } from './util.js';

/** A key of the right shape, with no real entropy in it. */
const body = (n: number, ch = 'A') => ch.repeat(n);

describe('redact', () => {
  it.each([
    ['OpenAI project key', `sk-proj-${body(40)}`],
    ['OpenAI classic key', `sk-${body(40)}`],
    ['Anthropic key', `sk-ant-api03-${body(40)}`],
    ['Google API key', `AIza${body(35, 'B')}`],
    ['GitHub token', `ghp_${body(36, 'C')}`],
    ['GitHub fine-grained', `github_pat_${body(40, 'D')}`],
    ['Slack token', `xoxb-${body(24, 'E')}`],
    ['AWS access key', `AKIA${body(16, 'F')}`],
    ['npm token', `npm_${body(36, 'G')}`],
    ['Fly token', `fo1_${body(30, 'H')}`],
    ['Groq key', `gsk_${body(30, 'I')}`],
  ])('hides a %s', (_label, secret) => {
    const out = redact(`the value is ${secret} and then some text`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
    // The surrounding text is not collateral damage.
    expect(out).toContain('and then some text');
  });

  it('hides a bearer token and keeps the header name', () => {
    // "[redacted]" alone leaves a reader guessing which header leaked, and the
    // header name is not the secret.
    const out = redact(`Authorization: Bearer ${body(40, 'Z')}`);
    expect(out).not.toContain(body(40, 'Z'));
    expect(out).toBe('Authorization: Bearer [redacted]');
  });

  it.each(['Proxy-Authorization: Bearer', 'authorization: bearer', 'Authorization: Token', 'Authorization:  Basic'])(
    'handles the %s spelling',
    (prefix) => {
      const out = redact(`${prefix} ${body(32, 'Y')}`);
      expect(out).not.toContain(body(32, 'Y'));
    },
  );

  it('leaves a private key body out entirely rather than masking it', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body(64, 'K')}\n-----END RSA PRIVATE KEY-----`;
    const out = redact(`key:\n${pem}\ndone`);
    expect(out).not.toContain(body(64, 'K'));
    expect(out).toContain('[redacted private key]');
    expect(out).toContain('done');
  });

  it('keeps enough of a key to tell two of them apart', () => {
    // An operator debugging "which key did it use" needs the prefix; the point
    // is to make the secret unusable, not to make the log useless.
    expect(redact(`sk-ant-api03-${body(40)}`)).toMatch(/^sk-ant\.\.\.\[redacted\]$/);
  });

  it('does not mangle ordinary text', () => {
    for (const plain of ['a normal sentence', 'sk-', 'npm install --save-exact', 'AKIA', 'Authorization: Bearer']) {
      expect(redact(plain)).toBe(plain);
    }
  });

  it('redacts every occurrence, not just the first', () => {
    const out = redact(`${`sk-ant-${body(30)}`} then ${`ghp_${body(36, 'C')}`}`);
    expect(out).not.toContain(body(30));
    expect(out).not.toContain(body(36, 'C'));
  });
});
