import { describe, expect, it } from 'vitest';
import { backendNodeIdOf, flattenAxTree, keyDescriptor } from './page.js';
import type { AxNodeLike } from './page.js';

const node = (over: AxNodeLike): AxNodeLike => ({ nodeId: '1', ...over });

describe('flattenAxTree', () => {
  it('keeps named and interactive nodes and drops the scaffolding', () => {
    const flat = flattenAxTree([
      node({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Shop' }, backendDOMNodeId: 1 }),
      node({ nodeId: '2', role: { value: 'generic' }, name: { value: '' }, backendDOMNodeId: 2 }),
      node({ nodeId: '3', role: { value: 'link' }, name: { value: '  Sign   in ' }, backendDOMNodeId: 3 }),
      node({ nodeId: '4', role: { value: 'button' }, name: { value: '' }, backendDOMNodeId: 4 }),
      node({ nodeId: '5', role: { value: 'StaticText' }, name: { value: 'Total: $12' }, backendDOMNodeId: 5 }),
    ]);

    expect(flat).toEqual([
      { ref: 'e3', role: 'link', name: 'Sign in' },
      { ref: 'e4', role: 'button', name: '' },
      { ref: 'e5', role: 'StaticText', name: 'Total: $12' },
    ]);
  });

  it('drops ignored nodes, which are most of a real tree', () => {
    const flat = flattenAxTree([
      node({ ignored: true, role: { value: 'button' }, name: { value: 'Hidden' }, backendDOMNodeId: 7 }),
    ]);
    expect(flat).toEqual([]);
  });

  it('carries the value of a field, so a model can see what it typed', () => {
    const flat = flattenAxTree([
      node({ role: { value: 'textbox' }, name: { value: 'Search' }, value: { value: 'husk' }, backendDOMNodeId: 8 }),
    ]);
    expect(flat[0]).toEqual({ ref: 'e8', role: 'textbox', name: 'Search', value: 'husk' });
  });

  it('derives the ref from the DOM node, so it survives a re-snapshot', () => {
    const before = flattenAxTree([
      node({ nodeId: '10', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 42 }),
    ]);
    // Same element, different AX node id after the tree was rebuilt.
    const after = flattenAxTree([
      node({ nodeId: '99', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 42 }),
    ]);
    expect(after[0]?.ref).toBe(before[0]?.ref);
  });

  it('marks a node with no DOM element as unclickable rather than guessing', () => {
    const flat = flattenAxTree([node({ nodeId: '11', role: { value: 'button' }, name: { value: 'Ghost' } })]);
    expect(flat[0]?.ref).toBe('a11');
    expect(backendNodeIdOf(flat[0]!.ref)).toBeNull();
  });

  it('deduplicates two AX nodes backed by the same element', () => {
    const flat = flattenAxTree([
      node({ nodeId: '1', role: { value: 'link' }, name: { value: 'Docs' }, backendDOMNodeId: 5 }),
      node({ nodeId: '2', role: { value: 'StaticText' }, name: { value: 'Docs' }, backendDOMNodeId: 5 }),
    ]);
    expect(flat).toHaveLength(1);
  });

  it('caps the list, because a news homepage yields thousands', () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      node({ nodeId: String(i), role: { value: 'link' }, name: { value: `L${i}` }, backendDOMNodeId: i + 1 }),
    );
    expect(flattenAxTree(many)).toHaveLength(1000);
    expect(flattenAxTree(many, { limit: 5 })).toHaveLength(5);
  });

  it('tolerates a tree with no roles or names at all', () => {
    expect(flattenAxTree([node({}), node({ role: { value: 42 } })])).toEqual([]);
    expect(flattenAxTree([])).toEqual([]);
  });
});

describe('backendNodeIdOf', () => {
  it('parses the clickable form and refuses everything else', () => {
    expect(backendNodeIdOf('e42')).toBe(42);
    expect(backendNodeIdOf('a42')).toBeNull();
    expect(backendNodeIdOf('e')).toBeNull();
    expect(backendNodeIdOf('e4x')).toBeNull();
  });
});

describe('keyDescriptor', () => {
  it('gives named keys their virtual key code', () => {
    expect(keyDescriptor('Enter')).toMatchObject({ key: 'Enter', keyCode: 13 });
    expect(keyDescriptor('Tab')).toMatchObject({ keyCode: 9 });
    expect(keyDescriptor('ArrowDown')).toMatchObject({ keyCode: 40 });
  });

  it('accepts a lowercase name, which is how a model will write it', () => {
    expect(keyDescriptor('enter')).toMatchObject({ key: 'Enter' });
  });

  it('handles a single character', () => {
    expect(keyDescriptor('a')).toMatchObject({ key: 'a', code: 'KeyA', text: 'a' });
  });

  it('refuses a key it cannot dispatch, rather than silently doing nothing', () => {
    expect(() => keyDescriptor('Ctrl+Shift+K')).toThrow(/unknown key/);
  });
});
