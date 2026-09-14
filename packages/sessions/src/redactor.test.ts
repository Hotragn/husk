import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { redactText, redactTranscript, redactDistilled } from './redactor.js';
import type { Transcript } from '@husk-ai/core';

describe('redactText', () => {
  it('masks an Anthropic key via core redact()', () => {
    const { text, report } = redactText('key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA done');
    expect(text).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(text).toContain('[redacted]');
    expect(report.counts.secret).toBeGreaterThan(0);
  });

  it('rewrites a Windows home path to ~', () => {
    const { text, report } = redactText('open C:\\Users\\hotra\\Documents\\notes.md');
    expect(text).toBe('open ~\\Documents\\notes.md');
    expect(report.counts['home-path']).toBe(1);
  });

  it('rewrites forward-slash and escaped Windows home paths', () => {
    expect(redactText('C:/Users/alice/dev').text).toBe('~/dev');
    expect(redactText('C:\\\\Users\\\\alice\\\\dev').text).toBe('~\\\\dev');
  });

  it('rewrites POSIX home paths', () => {
    expect(redactText('cd /home/alice/src').text).toBe('cd ~/src');
    expect(redactText('cd /Users/alice/src').text).toBe('cd ~/src');
  });

  it('rewrites the running user home directory', () => {
    const { text } = redactText(`${homedir()}/thing`);
    expect(text.startsWith('~')).toBe(true);
  });

  it('drops email addresses', () => {
    const { text, report } = redactText('mail me at dev.person+tag@example.co.uk please');
    expect(text).toBe('mail me at [email] please');
    expect(report.counts.email).toBe(1);
  });

  it('leaves ordinary text alone and says so', () => {
    const { text, report } = redactText('nothing sensitive here');
    expect(text).toBe('nothing sensitive here');
    expect(report.total).toBe(0);
    expect(report.summary).toBe('nothing to redact');
  });

  it('reports what it scrubbed without echoing the value', () => {
    const { report } = redactText('C:\\Users\\bob\\x and bob@example.com');
    expect(report.total).toBe(2);
    expect(report.summary).toContain('1 home path');
    expect(report.summary).toContain('1 email');
    expect(JSON.stringify(report)).not.toContain('bob@example.com');
  });

  it('honours opt-outs', () => {
    const { text } = redactText('bob@example.com', { emails: false });
    expect(text).toBe('bob@example.com');
  });
});

describe('redactTranscript', () => {
  const transcript: Transcript = {
    id: 't',
    source: 'claude-code',
    title: 'work in C:\\Users\\bob\\proj',
    origin: 'C:\\Users\\bob\\proj\\s.jsonl',
    messages: [
      { role: 'user', content: 'ping bob@example.com' },
      { role: 'assistant', content: 'ok', toolName: 'Bash', toolInput: { command: 'cat /home/bob/.env' } },
    ],
  };

  it('scrubs title, origin, content and tool input', () => {
    const { transcript: out, report } = redactTranscript(transcript);
    expect(out.title).toBe('work in ~\\proj');
    expect(out.origin).toBe('~\\proj\\s.jsonl');
    expect(out.messages[0]?.content).toBe('ping [email]');
    expect(out.messages[1]?.toolInput).toEqual({ command: 'cat ~/.env' });
    expect(report.total).toBeGreaterThanOrEqual(4);
  });

  it('does not mutate the input', () => {
    redactTranscript(transcript);
    expect(transcript.messages[0]?.content).toBe('ping bob@example.com');
  });
});

describe('redactDistilled', () => {
  it('scrubs every string field of a distilled agent', () => {
    const { agent, report } = redactDistilled({
      name: 'bot',
      description: 'runs in C:\\Users\\bob',
      persona: 'You are bob@example.com',
      knowledge: [{ title: '/home/bob/notes', content: 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBB' }],
      examples: [{ user: '/home/bob/x', assistant: 'ok' }],
      suggestedTools: [],
      needsComputer: false,
      confidence: 0.5,
      notes: ['found in C:\\Users\\bob'],
    });
    expect(agent.description).toBe('runs in ~');
    expect(agent.persona).toBe('You are [email]');
    expect(agent.knowledge[0]?.title).toBe('~/notes');
    expect(agent.knowledge[0]?.content).toContain('[redacted]');
    expect(agent.examples[0]?.user).toBe('~/x');
    expect(agent.notes[0]).toBe('found in ~');
    expect(report.total).toBeGreaterThan(4);
  });
});
