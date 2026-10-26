import { describe, expect, it } from 'vitest';
import { parseJsonc, setMember } from './jsonc.js';

// As Zed writes a new settings file: a comment header, then the object.
const ZED = `// Zed settings
//
// For information on how to configure Zed, see the Zed
// documentation: https://zed.dev/docs/configuring-zed
{
  "ui_font_size": 16, // big enough
  /* the theme */
  "theme": "One Dark",
}
`;
const HUSK = { command: 'npx', args: ['-y', '@husk-ai/mcp'] };

describe('JSON with comments', () => {
  it('reads comments and trailing commas, and a "//" inside a string', () => {
    expect(parseJsonc(ZED)).toEqual({ ui_font_size: 16, theme: 'One Dark' });
    expect(parseJsonc('{ "url": "https://x.dev/a//b", "list": [1, 2,], }')).toEqual({ url: 'https://x.dev/a//b', list: [1, 2] });
  });

  it('refuses what is not JSON', () => {
    expect(() => parseJsonc('{ "a": 1 /* open')).toThrow(/comment/);
    expect(() => parseJsonc('{ "a": "open }')).toThrow(/string/);
    expect(() => parseJsonc('{ "a": 1 } /')).toThrow();
    expect(() => parseJsonc('{ "a": 1,, }')).toThrow();
  });
});

describe('changing one member in place', () => {
  it('adds the servers object to a file of comments, and keeps every one', () => {
    const out = setMember(ZED, 'context_servers', 'husk', HUSK);
    expect(parseJsonc(out)).toEqual({ ui_font_size: 16, theme: 'One Dark', context_servers: { husk: HUSK } });
    expect(out.startsWith('// Zed settings\n//\n')).toBe(true);
    expect(out).toContain('"ui_font_size": 16, // big enough\n  /* the theme */\n  "theme": "One Dark",\n}');
  });

  it('replaces the entry, leaving the rest of the file byte for byte', () => {
    const text = '{\n  "mcpServers": {\n    // mine\n    "other": { "command": "x" },\n    "husk": { "command": "old" }\n  },\n  "theme": "dark"\n}\n';
    const out = setMember(text, 'mcpServers', 'husk', { command: 'new' });
    expect(out).toBe('{\n  "mcpServers": {\n    // mine\n    "other": { "command": "x" },\n    "husk": {\n      "command": "new"\n    }\n  },\n  "theme": "dark"\n}\n');
  });

  it('adds to servers that are empty, or that are not, in the file’s own indent', () => {
    expect(parseJsonc(setMember('{ "mcpServers": {} }', 'mcpServers', 'husk', HUSK))).toEqual({ mcpServers: { husk: HUSK } });
    const tabs = setMember('{\n\t"servers": {\n\t\t"other": {}\n\t}\n}', 'servers', 'husk', { type: 'stdio' });
    expect(tabs).toBe('{\n\t"servers": {\n\t\t"husk": {\n\t\t\t"type": "stdio"\n\t\t},\n\t\t"other": {}\n\t}\n}');
    expect(setMember('', 'mcpServers', 'husk', HUSK)).toBe(`${JSON.stringify({ mcpServers: { husk: HUSK } }, null, 2)}\n`);
  });

  it('removes the entry wherever it stands, and leaves valid JSON', () => {
    const cases: Array<[string, unknown]> = [
      ['{ "s": { "husk": 1, "a": 2 } }', { s: { a: 2 } }],
      ['{ "s": { "a": 1, "husk": 2, "b": 3 } }', { s: { a: 1, b: 3 } }],
      ['{ "s": { "a": 1, "husk": 2 } }', { s: { a: 1 } }],
      ['{ "s": { "husk": 2 } }', { s: {} }],
      ['{ "s": { "a": 1, "husk": 2, } }', { s: { a: 1 } }],
    ];
    for (const [text, want] of cases) {
      const out = setMember(text, 's', 'husk', undefined);
      expect(JSON.parse(out.replace(/,(\s*})/g, '$1'))).toEqual(want);
    }
    expect(setMember('{ "s": { "a": 1 } }', 's', 'husk', undefined)).toBe('{ "s": { "a": 1 } }');
    expect(setMember('{}', 's', 'husk', undefined)).toBe('{}');
  });

  it('changes the last of two same-named members, the one JSON.parse reads', () => {
    const out = setMember('{ "s": { "husk": 1 }, "s": { "husk": 2 } }', 's', 'husk', 3);
    expect(out.startsWith('{ "s": { "husk": 1 }, "s": { "husk": 3')).toBe(true);
  });

  it('keeps Windows line endings', () => {
    const out = setMember('{\r\n  "mcpServers": {}\r\n}\r\n', 'mcpServers', 'husk', HUSK);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('refuses a file that is not an object, or servers that are not', () => {
    expect(() => setMember('[1]', 's', 'husk', 1)).toThrow(/not an object/);
    expect(() => setMember('{ "s": null }', 's', 'husk', 1)).toThrow(/not an object/);
  });
});
