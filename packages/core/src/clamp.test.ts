/**
 * Truncation, and the two promises it was quietly breaking.
 *
 * `clampText` is what stands between a command that printed 40 MB and a model's
 * context window, so both of these mattered:
 *
 * 1. It cut at a byte offset chosen by the size limit, which lands inside a
 *    multi-byte character roughly as often as not. The seams came back as
 *    U+FFFD -- which reads like the *command* emitted garbage, sending anyone
 *    debugging in exactly the wrong direction.
 * 2. It added the "[N bytes elided]" marker on top of the budget instead of
 *    inside it, so `clampText(s, 10)` returned 38 bytes. A cap chosen for a
 *    token budget was being exceeded by the code enforcing it.
 */

import { describe, expect, it } from 'vitest';
import { clampText } from './util.js';

const FFFD = /�/;

describe('clampText', () => {
  it('leaves text that fits completely alone', () => {
    expect(clampText('hello', 1000)).toEqual({ text: 'hello', truncated: false });
  });

  it('keeps both ends and says how much went', () => {
    const r = clampText('A'.repeat(200) + 'Z'.repeat(200), 200);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('A')).toBe(true);
    expect(r.text.endsWith('Z')).toBe(true);
    expect(r.text).toMatch(/\[\d+ bytes elided by husk\]/);
  });

  it('never splits a character, whatever the cap', () => {
    // Sweeping the cap is the point: any single value can miss the boundary
    // that breaks, and the old implementation passed for 2-byte text at even
    // caps while failing everywhere else.
    for (const alphabet of ['€', '😀', 'é', '日本']) {
      for (let cap = 8; cap < 400; cap++) {
        expect(clampText(alphabet.repeat(300), cap).text).not.toMatch(FFFD);
      }
    }
  });

  it('honours the cap it was given', () => {
    for (const alphabet of ['€', '😀', 'x']) {
      for (let cap = 8; cap < 400; cap++) {
        const bytes = Buffer.byteLength(clampText(alphabet.repeat(300), cap).text, 'utf8');
        expect(bytes).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('returns nothing rather than overflow when even the marker will not fit', () => {
    // Keeping nothing is the honest answer at a cap this small, and `truncated`
    // still tells the caller the output was not what the command produced.
    expect(clampText('x'.repeat(500), 10)).toEqual({ text: '', truncated: true });
  });

  it('accounts for every byte it dropped', () => {
    const input = 'x'.repeat(1000);
    const r = clampText(input, 200);
    const omitted = Number(/\[(\d+) bytes elided/.exec(r.text)![1]);
    const kept = Buffer.byteLength(r.text.replace(/\n\.\.\. \[\d+ bytes elided by husk\] \.\.\.\n/, ''), 'utf8');
    expect(kept + omitted).toBe(1000);
  });
});
