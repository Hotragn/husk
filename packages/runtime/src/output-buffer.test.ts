/**
 * The streaming truncator has the same seam problem `clampText` had.
 *
 * `OutputBuffer` keeps a head and a tail and drops the middle, and the boundary
 * between them is a byte count, not a character count. Decoding each side
 * independently turned whatever character straddled the cut into U+FFFD -- and
 * in a build log full of non-ASCII, a couple of replacement characters look
 * like the toolchain's output is corrupt rather than like husk's scissors.
 */

import { describe, expect, it } from 'vitest';
import { OutputBuffer } from './policy.js';

/** Feed a string through in small chunks, as a real stream arrives. */
function stream(text: string, maxBytes: number, chunkBytes = 7): OutputBuffer {
  const buf = new OutputBuffer(maxBytes);
  const bytes = Buffer.from(text, 'utf8');
  for (let i = 0; i < bytes.byteLength; i += chunkBytes) {
    buf.push(bytes.subarray(i, i + chunkBytes));
  }
  return buf;
}

describe('OutputBuffer', () => {
  it('passes short output through byte for byte', () => {
    const buf = stream('héllo €', 4096);
    expect(buf.truncated).toBe(false);
    expect(buf.toString()).toBe('héllo €');
  });

  it('does not split a character at the seam', () => {
    for (const alphabet of ['€', '😀', 'é']) {
      for (let cap = 40; cap < 200; cap++) {
        expect(stream(alphabet.repeat(200), cap).toString()).not.toMatch(/�/);
      }
    }
  });

  it('keeps the start and the end of a long stream', () => {
    const buf = stream('START' + 'x'.repeat(5000) + 'END', 400);
    expect(buf.truncated).toBe(true);
    expect(buf.toString().startsWith('START')).toBe(true);
    expect(buf.toString().endsWith('END')).toBe(true);
  });

  it('counts the bytes it dropped, including any it dropped at the seam', () => {
    const text = '€'.repeat(500);
    const buf = stream(text, 101);
    const out = buf.toString();
    const omitted = Number(/\[(\d+) bytes elided/.exec(out)![1]);
    const kept = Buffer.byteLength(out.replace(/\n\.\.\. \[\d+ bytes elided by husk\] \.\.\.\n/, ''), 'utf8');
    expect(kept + omitted).toBe(Buffer.byteLength(text, 'utf8'));
  });
});
