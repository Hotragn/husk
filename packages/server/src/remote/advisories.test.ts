import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADVISORY_ENDPOINT, blocking, checkAdvisories, huskPackages, installedPackages } from './advisories.js';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A package at `dir` with these runtime and dev dependencies. */
function pkg(dir: string, name: string, version: string, dependencies: Record<string, string> = {}, devDependencies: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, dependencies, devDependencies }));
  return join(dir, 'package.json');
}

describe('what remote access checks for advisories', () => {
  it('walks runtime dependencies as Node resolves them, nested copies included, and no dev ones', () => {
    root = mkdtempSync(join(tmpdir(), 'husk-advisories-'));
    const top = pkg(join(root, 'app'), '@husk-ai/server', '0.2.0', { fastify: '^5', zod: '^3' }, { vitest: '^5' });
    pkg(join(root, 'app', 'node_modules', 'fastify'), 'fastify', '5.12.5', { 'light-my-request': '^6' });
    pkg(join(root, 'node_modules', 'light-my-request'), 'light-my-request', '6.6.0');
    pkg(join(root, 'app', 'node_modules', 'zod'), 'zod', '3.25.76');
    pkg(join(root, 'app', 'node_modules', 'vitest'), 'vitest', '5.0.2');
    const found = installedPackages([top]);
    expect([...found.keys()].sort()).toEqual(['@husk-ai/server', 'fastify', 'light-my-request', 'zod']);
    expect([...found.get('fastify')!]).toEqual(['5.12.5']);
  });

  it('finds this install’s own tree, the MCP server and its SDK beside the server', () => {
    const found = installedPackages(huskPackages());
    for (const name of ['@husk-ai/server', '@husk-ai/mcp', '@modelcontextprotocol/server', 'fastify']) expect(found.has(name)).toBe(true);
  });

  it('asks the registry by name and version only, and keeps high and critical apart', async () => {
    let sent: unknown;
    const fake = (async (url: string, init: RequestInit) => {
      expect(url).toBe(ADVISORY_ENDPOINT);
      sent = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          minimist: [{ title: 'Prototype Pollution in minimist', severity: 'critical', url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h' }],
          fastify: [{ title: 'header validation bypass', severity: 'low', url: 'https://github.com/advisories/GHSA-389g-gv7q-r4x8' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const list = await checkAdvisories(new Map([['minimist', new Set(['1.2.5'])], ['fastify', new Set(['5.12.5'])]]), fake);
    expect(sent).toEqual({ minimist: ['1.2.5'], fastify: ['5.12.5'] });
    expect(blocking(list).map((a) => a.name)).toEqual(['minimist']);
    await expect(checkAdvisories(new Map(), (async () => new Response('', { status: 503 })) as unknown as typeof fetch)).rejects.toThrow(/503/);
  });
});
