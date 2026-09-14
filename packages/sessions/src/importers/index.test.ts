import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptImporter } from '@husk-ai/core';
import { builtinImporters, detectAll, detectAndParse, discover } from './index.js';
import { readHeadTail, wholeLines } from './fsutil.js';

const SESSION = 'b3a1b66c-da72-4ba3-af79-882df990fc62';
const base = { isSidechain: false, userType: 'external', cwd: '/w', sessionId: SESSION, version: '2.1.246' };

const CLAUDE_FIXTURE = [
  { type: 'ai-title', aiTitle: 'Audit the build pipeline', sessionId: SESSION },
  { ...base, type: 'user', parentUuid: null, uuid: 'u1', timestamp: '2026-08-22T06:00:00.000Z', promptSource: 'typed', message: { role: 'user', content: 'Always run the tests first.' } },
  { ...base, type: 'assistant', parentUuid: 'u1', uuid: 'a1', timestamp: '2026-08-22T06:01:00.000Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Running them now.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] } },
  { ...base, type: 'user', parentUuid: 'a1', uuid: 'r1', timestamp: '2026-08-22T06:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '42 passing' }] } },
  { ...base, type: 'assistant', parentUuid: 'r1', uuid: 'a2', timestamp: '2026-08-22T06:03:00.000Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Green. Ready to tag.' }] } },
  { ...base, type: 'user', parentUuid: 'a2', uuid: 'u2', timestamp: '2026-08-22T06:04:00.000Z', promptSource: 'typed', message: { role: 'user', content: 'Tag it.' } },
  { ...base, type: 'assistant', parentUuid: 'u2', uuid: 'a3', timestamp: '2026-08-22T06:05:00.000Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Tagged v1.2.4.' }] } },
]
  .map((l) => JSON.stringify(l))
  .join('\n');

const CHATGPT_FIXTURE = JSON.stringify([
  {
    title: 'Hello',
    current_node: 'n2',
    mapping: {
      n1: { id: 'n1', parent: null, children: ['n2'], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['hi'] }, metadata: {} } },
      n2: { id: 'n2', parent: 'n1', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['hello'] }, metadata: {} } },
    },
  },
]);

const MARKDOWN_FIXTURE = ['## User', 'plan the sprint', '', '## Assistant', 'here is a plan'].join('\n');

describe('detectAll', () => {
  it('scores every importer and sorts best first', async () => {
    const scored = await detectAll({ content: CLAUDE_FIXTURE });
    expect(scored[0]?.importer.id).toBe('claude-code');
    expect(scored.map((s) => s.confidence)).toEqual([...scored.map((s) => s.confidence)].sort((a, b) => b - a));
  });

  it('scores a thrown detect as zero instead of failing the race', async () => {
    const exploding: TranscriptImporter = {
      id: 'unknown',
      displayName: 'Boom',
      async detect() {
        throw new Error('boom');
      },
      async parse() {
        return [];
      },
    };
    const scored = await detectAll({ content: MARKDOWN_FIXTURE }, [...builtinImporters(), exploding]);
    expect(scored.find((s) => s.importer.id === 'unknown')?.confidence).toBe(0);
    expect(scored[0]?.importer.id).toBe('markdown');
  });
});

describe('detectAndParse', () => {
  it('picks Claude Code for a Claude JSONL', async () => {
    const res = await detectAndParse({ content: CLAUDE_FIXTURE });
    expect(res.source).toBe('claude-code');
    expect(res.confidence).toBeGreaterThan(0.9);
    expect(res.transcripts[0]?.messages.length).toBeGreaterThan(4);
  });

  it('picks ChatGPT for an export', async () => {
    const res = await detectAndParse({ content: CHATGPT_FIXTURE });
    expect(res.source).toBe('chatgpt');
    expect(res.transcripts[0]?.messages).toHaveLength(2);
  });

  it('picks markdown for a pasted chat', async () => {
    const res = await detectAndParse({ content: MARKDOWN_FIXTURE });
    expect(res.source).toBe('markdown');
  });

  it('honours an explicit source hint without detecting', async () => {
    const res = await detectAndParse({ content: CLAUDE_FIXTURE, source: 'claude-code' });
    expect(res.confidence).toBe(1);
    expect(res.source).toBe('claude-code');
  });

  it('lists the runners-up so a caller can offer a choice', async () => {
    const res = await detectAndParse({ content: CLAUDE_FIXTURE });
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.candidates[0]).toEqual({ source: 'claude-code', confidence: res.confidence });
  });

  it('falls through to the next importer when the best guess finds nothing', async () => {
    // A .jsonl that is not a Claude transcript: claude-code detects on the
    // extension, finds no messages, and markdown is never going to claim it.
    const res = await detectAndParse({ path: 'server.jsonl', content: '{"level":"info","msg":"started"}' });
    expect(res.transcripts).toEqual([]);
    expect(res.source).toBe('unknown');
  });

  it('reads a file from disk and sniffs only a window of it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'husk-detect-'));
    const file = join(dir, 'session.jsonl');
    await writeFile(file, CLAUDE_FIXTURE, 'utf8');
    const res = await detectAndParse({ path: file });
    expect(res.source).toBe('claude-code');
    expect(res.transcripts[0]?.origin).toBe(file);
  });
});

describe('readHeadTail', () => {
  it('reads a small file whole and reports it complete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'husk-ht-'));
    const file = join(dir, 'small.jsonl');
    await writeFile(file, 'a\nb\nc\n', 'utf8');
    const ht = await readHeadTail(file, 1024);
    expect(ht.complete).toBe(true);
    expect(ht.head).toBe('a\nb\nc\n');
  });

  it('reads only the ends of a large file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'husk-ht-'));
    const file = join(dir, 'big.jsonl');
    const body = Array.from({ length: 5000 }, (_, i) => `line-${i}`).join('\n');
    await writeFile(file, body, 'utf8');
    const ht = await readHeadTail(file, 1024);
    expect(ht.complete).toBe(false);
    expect(ht.head.length).toBeLessThanOrEqual(1024);
    expect(ht.tail).toContain('line-4999');
    expect(ht.head.length + ht.tail.length).toBeLessThan(ht.size);
  });

  it('drops the partial line at a window edge', () => {
    expect(wholeLines('abc\ndef\ngh', false, true)).toEqual(['abc', 'def']);
    expect(wholeLines('bc\ndef\nghi', true, false)).toEqual(['def', 'ghi']);
  });
});

describe('discover', () => {
  it('finds transcripts under a Claude projects directory and counts them exactly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'husk-discover-'));
    const projects = join(root, '.claude', 'projects');
    await mkdir(join(projects, 'proj-a'), { recursive: true });
    await writeFile(join(projects, 'proj-a', 'session-1.jsonl'), CLAUDE_FIXTURE, 'utf8');

    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');
    try {
      const found = await discover({ sources: ['claude-code'] });
      expect(found).toHaveLength(1);
      const entry = found[0]!;
      expect(entry.source).toBe('claude-code');
      expect(entry.title).toBe('Audit the build pipeline');
      expect(entry.messageCount).toBeGreaterThan(4);
      expect(entry.approximate).toBeUndefined();
      expect(entry.origin.endsWith('session-1.jsonl')).toBe(true);
      expect(entry.id).toBe('b3a1b66c-da72-4ba3-af79-882df990fc62');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it('marks a big file approximate rather than reading all of it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'husk-discover-big-'));
    const projects = join(root, '.claude', 'projects', 'p');
    await mkdir(projects, { recursive: true });
    // Repeat the fixture until it is comfortably past the head+tail window.
    const big = Array.from({ length: 400 }, () => CLAUDE_FIXTURE).join('\n');
    await writeFile(join(projects, 'huge.jsonl'), big, 'utf8');

    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');
    try {
      const [entry] = await discover({ sources: ['claude-code'] });
      expect(entry?.approximate).toBe(true);
      expect(entry?.messageCount).toBeGreaterThan(100);
      expect(entry?.title).toBe('Audit the build pipeline');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it('skips transcripts below the message floor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'husk-discover-tiny-'));
    const projects = join(root, '.claude', 'projects', 'p');
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, 'tiny.jsonl'), '{"type":"mode","mode":"default"}', 'utf8');

    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');
    try {
      expect(await discover({ sources: ['claude-code'] })).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it('returns nothing, and does not throw, when no location exists', async () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'husk-nope-4a1f');
    try {
      await expect(discover({ sources: ['claude-code'] })).resolves.toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});
