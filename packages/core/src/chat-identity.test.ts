import { describe, expect, it } from 'vitest';
import { chatIdentityOf, chatLabel, platformName } from './chat-identity.js';

describe('chat identity', () => {
  it('names known clients and cleans unknown ones', () => {
    expect(platformName('claude-ai')).toBe('Claude Desktop');
    expect(platformName('claude-code')).toBe('Claude Code');
    expect(platformName('cursor-vscode')).toBe('Cursor');
    expect(platformName('<img src=x onerror=alert(1)>')).toBe('img srcx onerroralert(1)');
    expect(platformName('x'.repeat(100))).toHaveLength(40);
    expect(platformName(undefined)).toBe('MCP client');
  });

  it('labels by app and start time, never by chat content', () => {
    expect(chatLabel('Cursor', 'first-call', new Date(2026, 9, 18, 9, 5))).toBe('Cursor · chat started 09:05');
    expect(chatLabel('Claude Code', 'session', new Date(2026, 9, 18, 22, 41))).toBe('Claude Code · session started 22:41');
  });

  it('reads the labels back, and ignores an identity source it does not know', () => {
    expect(chatIdentityOf({ 'husk.platform': 'Cursor', 'husk.chat': 'Cursor · chat started 09:05', 'husk.identity': 'first-call' })).toEqual({
      platform: 'Cursor',
      chatLabel: 'Cursor · chat started 09:05',
      identitySource: 'first-call',
    });
    expect(chatIdentityOf({ 'husk.identity': 'guessed' })).toEqual({});
    expect(chatIdentityOf(undefined)).toEqual({});
  });
});

describe('platformName matching', () => {
  it('matches a known client only at the start of its name', () => {
    expect(platformName('optimized-agent')).toBe('optimized-agent');
    expect(platformName('authorized-cli')).toBe('authorized-cli');
    expect(platformName('zed-editor')).toBe('Zed');
  });
});
