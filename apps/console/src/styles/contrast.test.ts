// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Every token in one block of tokens.css, `--name: #hex`. */
function themes(): Record<'dark' | 'light', Record<string, string>> {
  const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    const body = css.slice(start, css.indexOf('\n}', start));
    return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
  };
  const dark = block(':root');
  return { dark, light: { ...dark, ...block(':root[data-theme="light"]') } };
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const surfaces = ['bg', 'surface', 'raised'];
// [foreground, backgrounds, minimum]: 4.5 for text, 3 for control edges.
const pairs: Array<[string, string[], number]> = [
  ['text', [...surfaces, 'sunken'], 4.5],
  ['text-muted', [...surfaces, 'sunken'], 4.5],
  ['text-subtle', [...surfaces, 'sunken'], 4.5],
  ['text-accent', surfaces, 4.5],
  ['primary-on-fill', ['primary-fill', 'primary-hover', 'primary-active'], 4.5],
  ['accent-on-fill', ['accent-fill'], 4.5],
  ['success', ['surface', 'success-subtle'], 4.5],
  ['warn', ['surface', 'warn-subtle'], 4.5],
  ['danger', ['surface', 'danger-subtle'], 4.5],
  ['info', ['surface', 'info-subtle'], 4.5],
  ['text', ['accent-subtle', 'selection-bg'], 4.5],
  ['border-strong', surfaces, 3],
  ['border-focus', surfaces, 3],
  ['primary-fill', ['bg', 'surface'], 3],
];

describe('console tokens', () => {
  for (const [name, colors] of Object.entries(themes())) {
    it(`meet WCAG AA in the ${name} theme`, () => {
      const failures: string[] = [];
      for (const [fg, bgs, min] of pairs) {
        for (const bg of bgs) {
          const r = ratio(colors[`color-${fg}`]!, colors[`color-${bg}`]!);
          if (!(r >= min)) failures.push(`${fg} on ${bg}: ${r.toFixed(2)} < ${min}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
