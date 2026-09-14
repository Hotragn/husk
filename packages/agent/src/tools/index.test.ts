import { describe, expect, it } from 'vitest';
import { specFor } from '../test-support.js';
import { BUNDLES, listBuiltinTools, resolveTools } from './index.js';
import type { BundleName } from './index.js';

const spec = specFor();
const noKeys: NodeJS.ProcessEnv = {};

function names(tools: { name: string }[]): string[] {
  return tools.map((t) => t.name).sort();
}

describe('resolveTools', () => {
  it('expands the computer bundle', () => {
    const tools = resolveTools(['computer'], { spec, env: noKeys });
    expect(names(tools)).toEqual(['computer_info', 'expose_port', 'shell']);
  });

  it('expands the files bundle', () => {
    expect(names(resolveTools(['files'], { spec, env: noKeys }))).toEqual([
      'delete',
      'edit_file',
      'list_dir',
      'move',
      'read_file',
      'search_files',
      'write_file',
    ]);
  });

  it('skips every machine-bound tool when the husk has no computer', () => {
    const tools = resolveTools(['computer', 'files', 'web'], { spec, env: noKeys, hasComputer: false });
    expect(names(tools)).toEqual(['fetch_url']);
  });

  it('registers web_search only when a key is present', () => {
    expect(names(resolveTools(['web'], { spec, env: noKeys }))).toEqual(['fetch_url']);
    expect(names(resolveTools(['web'], { spec, env: { TAVILY_API_KEY: 'tvly-x' } }))).toEqual([
      'fetch_url',
      'web_search',
    ]);
    expect(names(resolveTools(['web'], { spec, env: { BRAVE_API_KEY: 'b' } }))).toEqual(['fetch_url', 'web_search']);
  });

  it('describes which backend web_search is using', () => {
    const [, search] = resolveTools(['web'], { spec, env: { TAVILY_API_KEY: 'tvly-x' } });
    expect(search?.description).toContain('tavily');
  });

  it('accepts individual tool names', () => {
    expect(names(resolveTools(['read_file', 'shell'], { spec, env: noKeys }))).toEqual(['read_file', 'shell']);
  });

  it('ignores a tool that does not exist rather than throwing', () => {
    expect(names(resolveTools(['read_file', 'teleport'], { spec, env: noKeys }))).toEqual(['read_file']);
  });

  it('deduplicates across overlapping requests, keeping first-seen order', () => {
    const tools = resolveTools(['files', 'read_file', 'files'], { spec, env: noKeys });
    expect(tools.filter((t) => t.name === 'read_file')).toHaveLength(1);
    expect(tools[0]?.name).toBe('read_file');
  });

  it('marks the http bundle dangerous and opt-in', () => {
    const [http] = resolveTools(['http'], { spec, env: noKeys });
    expect(http?.name).toBe('http_request');
    expect(http?.dangerous).toBe(true);
    expect(http?.optIn).toBe(true);
  });

  it('does not smuggle the opt-in http tool in with another bundle', () => {
    expect(names(resolveTools(['computer', 'files', 'web'], { spec, env: noKeys }))).not.toContain('http_request');
  });

  it('marks the state-changing tools dangerous and the read-only ones not', () => {
    const tools = resolveTools(['computer', 'files', 'web'], { spec, env: noKeys });
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const n of ['shell', 'write_file', 'edit_file', 'move', 'delete', 'expose_port']) {
      expect(byName.get(n)?.dangerous, n).toBe(true);
    }
    for (const n of ['read_file', 'list_dir', 'search_files', 'computer_info', 'fetch_url']) {
      expect(byName.get(n)?.dangerous, n).toBeFalsy();
    }
  });

  it('gives every tool a JSON Schema object with declared properties', () => {
    for (const tool of resolveTools(['computer', 'files', 'web', 'http'], { spec, env: { TAVILY_API_KEY: 'x' } })) {
      expect(tool.parameters.type, tool.name).toBe('object');
      expect(tool.parameters.properties, tool.name).toBeTypeOf('object');
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }
  });
});

describe('listBuiltinTools agrees with the bundles', () => {
  it('lists every tool any bundle can hand out', () => {
    // The bug: `browser` was registered by `resolveTools` and missing from
    // `listBuiltinTools`, so those tools worked and were invisible to
    // `husk doctor` and the docs. Two lists that must agree, one of which is
    // easy to forget, is exactly what a test is for.
    const listed = new Set(listBuiltinTools().map((t) => t.name));
    const everyBundle = Object.keys(BUNDLES) as BundleName[];
    const fromBundles = new Set(
      everyBundle.flatMap((name) =>
        resolveTools([name], {
          spec,
          hasComputer: true,
          env: { TAVILY_API_KEY: 'x', BRAVE_API_KEY: 'x' },
        }).map((t) => t.name),
      ),
    );
    const missing = [...fromBundles].filter((n) => !listed.has(n));
    expect(missing, `listBuiltinTools is missing: ${missing.join(', ')}`).toEqual([]);
  });
});
