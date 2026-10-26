// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { brightness } from './dock3d';

const REDUCED = '@media (prefers-reduced-motion: reduce) {';
const css = readFileSync(new URL('./desktop.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every innermost rule in `text`: its selectors, and what it sets. */
function rules(text: string): Array<{ selectors: string[]; body: string }> {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1]!.split(',').map((s) => s.trim()), body: m[2]! }));
}

const start = css.indexOf(REDUCED);
const end = css.indexOf('\n}', start);
const calm = rules(css.slice(start + REDUCED.length, end));
const rest = rules(css.slice(0, start) + css.slice(end + 2));
const body = (selector: string) => rest.find((r) => r.selectors.includes(selector))?.body ?? '';
const shadow = (b: string) => /box-shadow:\s*([^;]+)/.exec(b)?.[1]?.trim();

describe('the desktop windows, for everyone', () => {
  it('stop every animation and transition for a person who asked for less motion', () => {
    expect(start).toBeGreaterThan(0);
    const stilled = (prop: string) => new Set(calm.filter((r) => new RegExp(`${prop}:\\s*none`).test(r.body)).flatMap((r) => r.selectors));
    for (const prop of ['animation', 'transition']) {
      const moving = rest.filter((r) => new RegExp(`(^|;|\\s)${prop}:\\s*(?!none)`).test(r.body)).flatMap((r) => r.selectors);
      expect(moving.length).toBeGreaterThan(0);
      expect(moving.filter((s) => !stilled(prop).has(s))).toEqual([]);
    }
  });

  it('draw a second ring on a held screen while the keyboard is on it', () => {
    const focused = shadow(body('.cw-held .cw-screen:focus-within'));
    expect(focused).toContain('var(--color-border-focus)');
    expect(focused).not.toBe(shadow(body('.cw-held .cw-screen')));
  });

  it('hold the corner’s glow steady for a person who asked for less motion', () => {
    const at = [0, 400, 800, 1200];
    expect(new Set(at.map((t) => brightness(true, t, true)))).toEqual(new Set([1]));
    expect(new Set(at.map((t) => brightness(true, t, false))).size).toBeGreaterThan(1);
    expect(brightness(false, 400, false)).toBe(1);
  });
});
