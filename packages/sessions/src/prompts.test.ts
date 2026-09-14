import { describe, expect, it } from 'vitest';
import type { TranscriptMessage } from '@husk/core';
import {
  CandidateSchema,
  MergedSchema,
  extractSystemPrompt,
  extractUserPrompt,
  mergeSystemPrompt,
  mergeUserPrompt,
  renderWindow,
} from './prompts.js';

describe('prompt templates', () => {
  it('tell the model to report only what the transcript shows', () => {
    const s = extractSystemPrompt();
    expect(s).toMatch(/Do not generalise/);
    expect(s).toMatch(/Reply with one JSON object/);
  });

  it('label the slice so the model knows it is not seeing everything', () => {
    const p = extractUserPrompt('USER: hi', { index: 2, total: 7, source: 'claude-code', title: 'Runbook' });
    expect(p).toContain('Slice 3 of 7.');
    expect(p).toContain('Runbook');
    expect(p).toContain('USER: hi');
  });

  it('cope with an untitled transcript', () => {
    expect(extractUserPrompt('x', { index: 0, total: 1, source: 'markdown' })).toContain('(untitled)');
  });

  it('give the reduce pass the candidates verbatim', () => {
    const candidate = CandidateSchema.parse({ name: 'bot', personaRules: ['Always test.'] });
    const p = mergeUserPrompt([candidate], { source: 'claude-code' });
    expect(p).toContain('1 slice report(s)');
    expect(p).toContain('Always test.');
    expect(mergeSystemPrompt()).toMatch(/Deduplicate aggressively/);
  });
});

describe('renderWindow', () => {
  const messages: TranscriptMessage[] = [
    { role: 'user', content: 'run the tests' },
    { role: 'assistant', content: '[tool: Bash]', toolName: 'Bash', toolInput: { command: 'npm test' } },
    { role: 'tool', content: 'x'.repeat(5000), toolName: 'Bash' },
    { role: 'assistant', content: 'all green' },
  ];

  it('names the tool on both the call and the result', () => {
    const out = renderWindow(messages);
    expect(out).toContain('ASSISTANT CALLS Bash: {"command":"npm test"}');
    expect(out).toContain('TOOL RESULT (Bash):');
  });

  it('clamps a huge tool result and says how much it dropped', () => {
    const out = renderWindow(messages, 100);
    expect(out).toContain('[4900 chars elided]');
    expect(out.length).toBeLessThan(1000);
  });

  it('passes ordinary turns through unchanged', () => {
    expect(renderWindow([{ role: 'user', content: 'hello' }])).toBe('USER: hello');
  });
});

describe('schemas', () => {
  it('fill in every optional field so a partial model reply still validates', () => {
    const c = CandidateSchema.parse({});
    expect(c).toEqual({
      name: '',
      description: '',
      personaRules: [],
      knowledge: [],
      examples: [],
      tools: [],
      needsComputer: false,
      notes: [],
    });
  });

  it('reject a confidence outside 0..1', () => {
    expect(MergedSchema.safeParse({ confidence: 4 }).success).toBe(false);
  });

  it('reject a knowledge item that is missing its content', () => {
    expect(CandidateSchema.safeParse({ knowledge: [{ title: 'x' }] }).success).toBe(false);
  });
});
