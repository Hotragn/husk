import { describe, expect, it } from 'vitest';
import { compactAxTree } from './page.js';
import type { AxNodeLike, SnapshotNode } from './page.js';

/**
 * The compact snapshot, against the acceptance fixture of the snapshot spec
 * credited in THIRD_PARTY_NOTICES.md: nested containers, blank text, two sibling
 * groups, an iframe, an image, an SVG, a canvas and an empty table cell.
 */

let next = 0;
function n(role: string, opts: { name?: string; id?: number; ignored?: boolean } = {}, ...children: AxNodeLike[]): AxNodeLike {
  const nodeId = String(++next);
  for (const c of children) c.parentId = nodeId;
  return {
    nodeId,
    role: { value: role },
    ...(opts.name !== undefined ? { name: { value: opts.name } } : {}),
    ...(opts.id !== undefined ? { backendDOMNodeId: opts.id } : {}),
    ...(opts.ignored ? { ignored: true } : {}),
    childIds: children.map((c) => c.nodeId!),
  };
}

/** The fixture as the flat list Chromium sends, root first. */
function fixture(): AxNodeLike[] {
  const made: AxNodeLike[] = [];
  const m = (role: string, opts: { name?: string; id?: number; ignored?: boolean } = {}, ...kids: AxNodeLike[]) => {
    const x = n(role, opts, ...kids);
    made.push(x);
    return x;
  };
  m(
    'RootWebArea',
    { name: 'Fixture', id: 1 },
    m('generic', { id: 2 }, m('generic', { id: 3 }, m('generic', { id: 4 }, m('heading', { name: 'Title', id: 5 }, m('StaticText', { name: 'Title', id: 6 }))))),
    m('StaticText', { name: '   ', id: 7 }),
    m('StaticText', { name: ' ​', id: 8 }),
    m('generic', { id: 9 }, m('button', { name: 'One', id: 10 }), m('button', { name: 'Two', id: 11 })),
    m('generic', { id: 12 }, m('button', { name: 'Three', id: 13 }), m('StaticText', { name: 'after three', id: 14 })),
    m('generic', { id: 15 }),
    m('Iframe', { id: 16 }),
    m('image', { id: 17 }),
    m('SvgRoot', { id: 18 }),
    m('canvas', { id: 19 }),
    m('table', { id: 20 }, m('row', { id: 21 }, m('cell', { id: 22 }), m('cell', { name: 'x', id: 23 }))),
    m('generic', { ignored: true }, m('link', { name: 'Hidden parent', id: 24 }, m('InlineTextBox', { name: 'Hidden parent' }))),
  );
  // Chromium sends the root first; order otherwise does not matter to the builder.
  return [made.at(-1)!, ...made.slice(0, -1)];
}

const lines = (nodes: SnapshotNode[]) => nodes.map((x) => `${'  '.repeat(x.depth ?? 0)}${x.ref} ${x.role}${x.name ? ` "${x.name}"` : ''}`);

describe('compactAxTree', () => {
  it('drops blank text and empty containers, collapses single-child ones, keeps groups and semantic nodes', () => {
    expect(lines(compactAxTree(fixture()))).toEqual([
      // Three nested single-child containers become their child; the heading's
      // own text is its name, so it is one line.
      'e5 heading "Title"',
      // Two groups of siblings stay two groups.
      'e9 generic',
      '  e10 button "One"',
      '  e11 button "Two"',
      'e12 generic',
      '  e13 button "Three"',
      '  e14 StaticText "after three"',
      // The frame boundary, the image, the svg and the canvas stay, unnamed or not.
      'e16 Iframe',
      'e17 image',
      'e18 SvgRoot',
      'e19 canvas',
      // The table collapses to its row of cells, empty cell included.
      'e21 row',
      '  e22 cell',
      '  e23 cell "x"',
      // An ignored node is not there; its child is.
      'e24 link "Hidden parent"',
    ]);
  });

  it('gives the same output on a second pass over its own output', () => {
    const once = compactAxTree(fixture());
    // Rebuild an AX tree from the compact one, parents from depth.
    const stack: AxNodeLike[] = [];
    const again: AxNodeLike[] = once.map((x, i) => {
      const node: AxNodeLike = {
        nodeId: `r${i}`,
        role: { value: x.role },
        name: { value: x.name },
        backendDOMNodeId: Number(x.ref.slice(1)),
        childIds: [],
      };
      stack.length = x.depth ?? 0;
      const parent = stack.at(-1);
      if (parent) {
        node.parentId = parent.nodeId!;
        parent.childIds!.push(node.nodeId!);
      }
      stack.push(node);
      return node;
    });
    expect(compactAxTree(again)).toEqual(once);
  });

  it('never drops page text for being non-interactive', () => {
    const out = compactAxTree(fixture());
    expect(out.some((x) => x.name === 'after three')).toBe(true);
  });

  it('keeps document order and stops at the limit', () => {
    const out = compactAxTree(fixture(), { limit: 3 });
    expect(out.map((x) => x.ref)).toEqual(['e5', 'e9', 'e10']);
  });

  it('treats a flat list with no child ids as leaves in order, as old fixtures are', () => {
    const out = compactAxTree([
      { nodeId: '1', role: { value: 'link' }, name: { value: 'A' }, backendDOMNodeId: 1 },
      { nodeId: '2', role: { value: 'StaticText' }, name: { value: '' }, backendDOMNodeId: 2 },
      { nodeId: '3', role: { value: 'button' }, name: { value: 'B' }, backendDOMNodeId: 3 },
    ]);
    expect(out).toEqual([
      { ref: 'e1', role: 'link', name: 'A', depth: 0 },
      { ref: 'e3', role: 'button', name: 'B', depth: 0 },
    ]);
  });
});
