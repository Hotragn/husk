// @vitest-environment jsdom
/**
 * The page-side expression, run against a real DOM.
 *
 * `select` (the driver's CHOOSE_OPTION, called on the <select>) does its actual
 * work *inside the page*, as script text handed to Chromium. The CDP plumbing
 * around it is shared with `type`, which is covered; what is not covered by
 * anything else is the JavaScript itself -- and a typo in a template literal is
 * invisible until a real page is in front of it.
 *
 * So it is evaluated here. This is not a substitute for driving Chromium. What
 * it does prove is the logic -- matching order, the error text a model has to
 * recover from, and which events fire.
 */

import { describe, expect, it } from 'vitest';
import { DRIVER_SOURCE } from './driver.js';

/**
 * The driver's CHOOSE_OPTION, called on a node the way `Runtime.callFunctionOn`
 * calls it: the wanted option is an argument, never part of the script.
 */
const chooseOption = new Function(`return ${/CHOOSE_OPTION = r'''([\s\S]*?)'''/.exec(DRIVER_SOURCE)![1]}`)() as (this: Element, want: string) => string;
function choose(want: string, el: Element = document.querySelector('select')!): string {
  return chooseOption.call(el, want);
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

describe('choosing an option (the driver’s CHOOSE_OPTION)', () => {
  const options: Array<[string, string]> = [
    ['sm', 'Small'],
    ['md', 'Medium'],
    ['lg', 'Large'],
  ];

  it('matches by the label a model can actually see', () => {
    const select = form(options);
    expect(choose('Large')).toBe('Large');
    expect(select.value).toBe('lg');
  });

  it('matches by value too', () => {
    const select = form(options);
    expect(choose('md')).toBe('Medium');
    expect(select.value).toBe('md');
  });

  it('prefers value over label when a string could be either', () => {
    // Order matters: `value` is exact and `text` is what a human reads, so an
    // argument that is a valid value must not be resolved as someone else's label.
    form([
      ['Large', 'Small'],
      ['lg', 'Large'],
    ]);
    expect(choose('Large')).toBe('Small');
  });

  it('tolerates surrounding whitespace in the label', () => {
    // Real markup indents its options, so `o.text` arrives padded.
    document.body.innerHTML = '<select><option value="a">  Spaced  </option></select>';
    document.querySelector('select')!.focus();
    expect(choose('Spaced')).toBe('Spaced');
  });

  it('fires input and change, which is the whole point', () => {
    // Setting `.value` alone updates the DOM and tells no framework anything,
    // so the select would look right and the app would not have heard.
    const select = form(options);
    const seen: string[] = [];
    select.addEventListener('input', () => seen.push('input'));
    select.addEventListener('change', () => seen.push('change'));
    choose('Medium');
    expect(seen).toEqual(['input', 'change']);
  });

  it('names every option when the wanted one is missing', () => {
    // The model cannot see the dropdown. If the error does not list what was
    // available, its only recovery is to guess again.
    form(options);
    let message = '';
    try {
      choose('Enormous');
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
    expect(() => choose('anything', document.querySelector('input')!)).toThrow(/not a <select>/);
  });

  it('escapes a value that would otherwise break out of the expression', () => {
    form([["it's", "it's"]]);
    expect(choose("it's")).toBe("it's");
    // And a quote-and-parenthesis payload is data, not code.
    form([['x', 'x']]);
    expect(() => choose(`'); throw new Error('injected'); ('`)).toThrow(/no option matching/);
  });
});
