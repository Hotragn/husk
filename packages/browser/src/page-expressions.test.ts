// @vitest-environment jsdom
/**
 * The two page-side expressions, run against a real DOM.
 *
 * `select` and the cross-origin iframe report do their actual work *inside the
 * page*, as strings handed to `Runtime.evaluate`. The CDP plumbing around them
 * is shared with `type`, which is covered; what is not covered by anything else
 * is the JavaScript itself -- and a typo in a template literal is invisible
 * until a real page is in front of it.
 *
 * So the expressions are exported and evaluated here. This is not a substitute
 * for driving Chromium: jsdom enforces no same-origin policy, so the iframe
 * tests below simulate an unreadable frame rather than producing one. What it
 * does prove is the logic -- matching order, the error text a model has to
 * recover from, which events fire, and which frames are reported.
 */

import { describe, expect, it } from 'vitest';
import { selectExpression, unreachableFramesExpression } from './page.js';

/** Run a page expression the way `Runtime.evaluate` would. */
function evaluate<T>(expression: string): T {
  return new Function(`return ${expression}`)() as T;
}

function form(options: Array<[value: string, label: string]>): HTMLSelectElement {
  document.body.innerHTML = '';
  const select = document.createElement('select');
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  document.body.appendChild(select);
  select.focus();
  return select;
}

describe('selectExpression', () => {
  const options: Array<[string, string]> = [
    ['sm', 'Small'],
    ['md', 'Medium'],
    ['lg', 'Large'],
  ];

  it('matches by the label a model can actually see', () => {
    const select = form(options);
    expect(evaluate<string>(selectExpression('Large'))).toBe('Large');
    expect(select.value).toBe('lg');
  });

  it('matches by value too', () => {
    const select = form(options);
    expect(evaluate<string>(selectExpression('md'))).toBe('Medium');
    expect(select.value).toBe('md');
  });

  it('prefers value over label when a string could be either', () => {
    // Order matters: `value` is exact and `text` is what a human reads, so an
    // argument that is a valid value must not be resolved as someone else's label.
    form([
      ['Large', 'Small'],
      ['lg', 'Large'],
    ]);
    expect(evaluate<string>(selectExpression('Large'))).toBe('Small');
  });

  it('tolerates surrounding whitespace in the label', () => {
    // Real markup indents its options, so `o.text` arrives padded.
    document.body.innerHTML = '<select><option value="a">  Spaced  </option></select>';
    document.querySelector('select')!.focus();
    expect(evaluate<string>(selectExpression('Spaced'))).toBe('Spaced');
  });

  it('fires input and change, which is the whole point', () => {
    // Setting `.value` alone updates the DOM and tells no framework anything,
    // so the select would look right and the app would not have heard.
    const select = form(options);
    const seen: string[] = [];
    select.addEventListener('input', () => seen.push('input'));
    select.addEventListener('change', () => seen.push('change'));
    evaluate(selectExpression('Medium'));
    expect(seen).toEqual(['input', 'change']);
  });

  it('names every option when the wanted one is missing', () => {
    // The model cannot see the dropdown. If the error does not list what was
    // available, its only recovery is to guess again.
    form(options);
    let message = '';
    try {
      evaluate(selectExpression('Enormous'));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('no option matching "Enormous"');
    expect(message).toContain('Small');
    expect(message).toContain('Medium');
    expect(message).toContain('Large');
  });

  it('refuses a ref that is not a select, rather than silently doing nothing', () => {
    // `click` on a dropdown already fails silently; this must not repeat that.
    document.body.innerHTML = '<input id="t">';
    document.querySelector('input')!.focus();
    expect(() => evaluate(selectExpression('anything'))).toThrow(/not a <select>/);
  });

  it('escapes a value that would otherwise break out of the expression', () => {
    form([["it's", "it's"]]);
    expect(evaluate<string>(selectExpression("it's"))).toBe("it's");
    // And a quote-and-parenthesis payload is data, not code.
    form([['x', 'x']]);
    expect(() => evaluate(selectExpression(`'); throw new Error('injected'); ('`))).toThrow(/no option matching/);
  });
});

describe('unreachableFramesExpression', () => {
  /**
   * jsdom gives every iframe a readable `contentDocument`, so an unreadable one
   * is simulated by replacing the getter -- which is exactly the state the
   * browser puts a cross-origin frame in.
   */
  function frames(specs: Array<{ src: string; readable: boolean }>) {
    document.body.innerHTML = '';
    for (const spec of specs) {
      const el = document.createElement('iframe');
      el.setAttribute('src', spec.src);
      document.body.appendChild(el);
      if (!spec.readable) {
        Object.defineProperty(el, 'contentDocument', { get: () => null, configurable: true });
      }
    }
  }

  it('reports only the frames that cannot be read', () => {
    frames([
      { src: 'https://example.com', readable: false },
      { src: '/same-origin.html', readable: true },
      { src: 'https://www.iana.org', readable: false },
    ]);
    expect(evaluate<string[]>(unreachableFramesExpression())).toEqual([
      'https://example.com/',
      'https://www.iana.org/',
    ]);
  });

  it('says nothing when every frame is readable', () => {
    // A warning that fires on same-origin frames would train the reader to
    // ignore it, which is worse than not warning at all.
    frames([{ src: '/a.html', readable: true }]);
    expect(evaluate<string[]>(unreachableFramesExpression())).toEqual([]);
  });

  it('treats a throwing contentDocument as unreachable', () => {
    // Some engines throw rather than returning null. Either way we cannot see in.
    document.body.innerHTML = '<iframe src="https://x.test"></iframe>';
    const el = document.querySelector('iframe')!;
    Object.defineProperty(el, 'contentDocument', {
      get() {
        throw new Error('blocked a frame with origin');
      },
      configurable: true,
    });
    expect(evaluate<string[]>(unreachableFramesExpression())).toEqual(['https://x.test/']);
  });

  it('has something to say about a frame with no src', () => {
    frames([{ src: '', readable: false }]);
    expect(evaluate<string[]>(unreachableFramesExpression())).toEqual(['(no src)']);
  });

  it('caps the list, so a page of ad frames cannot flood the snapshot', () => {
    frames(Array.from({ length: 25 }, (_, i) => ({ src: `https://ad${i}.test`, readable: false })));
    expect(evaluate<string[]>(unreachableFramesExpression()).length).toBe(10);
    expect(evaluate<string[]>(unreachableFramesExpression(3)).length).toBe(3);
  });

  it('finds no frames on a page that has none', () => {
    document.body.innerHTML = '<p>nothing here</p>';
    expect(evaluate<string[]>(unreachableFramesExpression())).toEqual([]);
  });
});
