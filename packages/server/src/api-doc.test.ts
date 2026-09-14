import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defaultProviders as defaultModelProviders } from '@husk/models';
import { defaultProviders as defaultComputerProviders } from '@husk/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statusForCode } from './errors.js';
import type { ServerErrorCode } from './errors.js';
import { buildTestApp } from './testing.js';
import type { TestApp } from './testing.js';

/**
 * docs/API.md against the routes that actually exist.
 *
 * "This document is the contract. The server implements it; the SDK mirrors it."
 * That only holds if something checks. It did not, and the doc drifted: it
 * described `fs/upload` and `fs/download`, which were never registered and
 * which the no-native-modules rule makes expensive to add, while omitting
 * `GET /v1/approvals` and `GET /v1/triggers`, which were.
 *
 * A doc test is unusual. This one earns its place because the SDK is written
 * from this file rather than from the source, so a lie here becomes twelve
 * methods pointed at nothing.
 */
const DOC = fileURLToPath(new URL('../../../docs/API.md', import.meta.url));

const VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'WS', 'ALL'] as const;
type Verb = (typeof VERBS)[number];

interface DocRoute {
  verb: Verb;
  path: string;
}

/**
 * Only fenced blocks are scanned. Prose and the "Not implemented yet" table
 * mention routes deliberately, and must not be read as promises.
 */
function documentedRoutes(markdown: string): DocRoute[] {
  const blocks = markdown.split(/^```.*$/m).filter((_, i) => i % 2 === 1);
  const line = new RegExp(`^(${VERBS.join('|')})\\s+(/\\S+)`);
  const out = new Map<string, DocRoute>();
  for (const block of blocks) {
    for (const raw of block.split('\n')) {
      const m = line.exec(raw.trim());
      if (!m) continue;
      const verb = m[1] as Verb;
      const path = m[2]!.split('?')[0]!.replace(/[.,]$/, '');
      out.set(`${verb} ${path}`, { verb, path });
    }
  }
  return [...out.values()];
}

/** `E_X` -> 404 pairs stated in the Conventions section. */
function documentedStatuses(markdown: string): Array<[ServerErrorCode, number]> {
  const pairs: Array<[ServerErrorCode, number]> = [];
  const re = /`(E_[A-Z_]+)`\s*(?:\/\s*`E_[A-Z_]+`\s*)*→\s*(\d{3})/g;
  const scoped = /`(E_[A-Z_]+)`/g;
  for (const m of markdown.matchAll(re)) {
    const status = Number(m[2]);
    // Pick up every code on the left of a shared arrow, not just the last.
    const head = markdown.slice(m.index!, m.index! + m[0].length);
    for (const c of head.matchAll(scoped)) {
      const code = c[1] as ServerErrorCode;
      if (code.includes('*')) continue;
      pairs.push([code, status]);
    }
  }
  return pairs;
}

describe('docs/API.md', () => {
  let harness: TestApp;
  let markdown: string;

  beforeAll(async () => {
    markdown = await readFile(DOC, 'utf8');
    // `triggers: true` so `/v1/triggers` and the wildcard mounts are registered.
    harness = await buildTestApp({ triggers: true });
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it('finds routes to check, so a broken parser cannot pass silently', () => {
    expect(documentedRoutes(markdown).length).toBeGreaterThan(25);
  });

  it('documents no route the server does not register', () => {
    const missing = documentedRoutes(markdown).filter(
      // A websocket route is registered as a GET.
      (r) => !harness.app.hasRoute({ method: r.verb === 'WS' ? 'GET' : r.verb === 'ALL' ? 'POST' : r.verb, url: r.path }),
    );
    expect(missing.map((r) => `${r.verb} ${r.path}`)).toEqual([]);
  });

  it('serves the archive routes it documents', () => {
    // These were the "Not implemented yet" table for months. The test that
    // guarded that claim now guards the opposite one, which is the point: the
    // doc and the router have to agree whichever way the answer goes.
    expect(harness.app.hasRoute({ method: 'GET', url: '/v1/computers/:id/fs/download' })).toBe(true);
    expect(harness.app.hasRoute({ method: 'POST', url: '/v1/computers/:id/fs/upload' })).toBe(true);
    expect(markdown).toContain('/v1/computers/:id/fs/download');
    expect(markdown).toContain('/v1/computers/:id/fs/upload');
  });

  it('still has a place to record what is missing', () => {
    // Empty today. The section stays, because the next gap needs somewhere to
    // be written down where a client author will see it.
    expect(markdown).toContain('## Not implemented yet');
  });

  it('documents the endpoints that exist but were missing from the doc', () => {
    for (const route of ['GET /v1/approvals', 'GET /v1/triggers']) {
      expect(documentedRoutes(markdown).some((r) => `${r.verb} ${r.path}` === route)).toBe(true);
    }
  });

  it('agrees with statusForCode on every status it states', () => {
    const stated = documentedStatuses(markdown);
    expect(stated.length).toBeGreaterThan(6);
    for (const [code, status] of stated) {
      expect([code, statusForCode(code)]).toEqual([code, status]);
    }
  });

  it('states the two statuses the map has and the doc used to omit', () => {
    expect(documentedStatuses(markdown)).toEqual(
      expect.arrayContaining([
        ['E_EXEC_TIMEOUT', 504],
        ['E_NOT_IMPLEMENTED', 501],
      ]),
    );
  });

  it('shows a DoctorReport example whose priorities are the real ones', () => {
    const start = markdown.indexOf('{\n  "version": "0.1.0"');
    expect(start).toBeGreaterThan(-1);
    const example = JSON.parse(markdown.slice(start, markdown.indexOf('\n}\n', start) + 2)) as {
      providers: Array<{ name: string; priority: number; description: string; isolationKind?: string }>;
      models: Array<{ id: string; priority: number }>;
    };

    const real = new Map(defaultComputerProviders().map((p) => [String(p.name), p]));
    for (const shown of example.providers) {
      const actual = real.get(shown.name);
      expect(actual, `unknown provider in the example: ${shown.name}`).toBeTruthy();
      expect([shown.name, shown.priority]).toEqual([shown.name, actual!.priority]);
      expect([shown.name, shown.description]).toEqual([shown.name, actual!.description]);
    }

    const realModels = new Map(defaultModelProviders().map((p) => [p.id, p.priority]));
    for (const shown of example.models) {
      expect([shown.id, shown.priority]).toEqual([shown.id, realModels.get(shown.id)]);
    }
  });

  it('shows isolationKind, which the server returns and the example used to omit', () => {
    const start = markdown.indexOf('{\n  "version": "0.1.0"');
    const example = JSON.parse(markdown.slice(start, markdown.indexOf('\n}\n', start) + 2)) as {
      providers: Array<{ name: string; isolationKind?: string }>;
    };
    for (const shown of example.providers) {
      expect(['kernel', 'machine', 'guardrails']).toContain(shown.isolationKind);
    }
  });

  it('describes approval_required as carrying `request`, not `call`', () => {
    const section = markdown.slice(markdown.indexOf('### Approvals'), markdown.indexOf('### Runs'));
    expect(section).toContain('"type":"approval_required"');
    expect(section).toContain('"request"');
    expect(section).not.toMatch(/"type":"approval_required","approvalId":"[^"]*","call"/);
  });
});
