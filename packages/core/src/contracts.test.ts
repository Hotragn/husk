import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `@husk-ai/core/contracts` is what the SDK and the console import. One Node
 * built-in or one `process` read anywhere in its import graph and the console
 * throws in the browser before it renders, which is how dev mode broke before.
 */
describe('@husk-ai/core/contracts stays browser-safe', () => {
  const seen = new Map<string, string>();
  const walk = (url: URL): void => {
    if (seen.has(url.href)) return;
    const src = readFileSync(fileURLToPath(url), 'utf8');
    seen.set(url.href, src);
    // `import type` is erased at build time, so it never reaches a browser.
    for (const m of src.matchAll(/^(?!import type)[^\n]*from '(\.{1,2}\/[^']+)\.js'/gm))
      walk(new URL(`${m[1]}.ts`, url));
  };
  walk(new URL('./contracts.ts', import.meta.url));

  it('imports no Node built-in', () => {
    const offenders = [...seen].filter(([, src]) => /from 'node:/.test(src)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('never reads process', () => {
    const offenders = [...seen].filter(([, src]) => /\bprocess\./.test(src)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('is re-exported whole by the main entry', () => {
    expect(readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')).toContain(
      "export * from './contracts.js';",
    );
  });
});
