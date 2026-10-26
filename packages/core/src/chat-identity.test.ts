import { describe, expect, it } from 'vitest';
import { chatClient, chatIdentityOf, chatLabel, platformName } from './chat-identity.js';

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

  it('names each app by the name it gives itself', () => {
    expect(platformName('codex-mcp-client')).toBe('Codex');
    expect(platformName('gemini-cli-mcp-client')).toBe('Gemini CLI');
    expect(platformName('local-agent-mode-husk')).toBe('Claude Desktop');
    expect(platformName('Visual Studio Code')).toBe('VS Code');
    expect(platformName('Zed')).toBe('Zed');
  });
});

describe('what each app allows', () => {
  it('answers each app inside its own limit on a call, and none where it waits', () => {
    expect(chatClient('claude-ai').waitSec).toBe(220);
    expect(chatClient('gemini-cli-mcp-client').waitSec).toBe(540);
    expect(chatClient('Zed').waitSec).toBe(50);
    expect(chatClient('Visual Studio Code').waitSec).toBeUndefined();
  });

  it('takes the MCP SDK’s 60 s, less a margin, for an app it does not know', () => {
    expect(chatClient('perplexity-mac')).toEqual({ name: 'perplexity-mac', waitSec: 50, asksInChat: false });
  });

  it('asks "Done?" in the chat only where the app shows it', () => {
    const asks = ['claude-code', 'cursor-vscode', 'Visual Studio Code', 'claude-ai', 'local-agent-mode-husk', 'codex-mcp-client', 'Zed'].map((n) => chatClient(n).asksInChat);
    expect(asks).toEqual([true, true, true, false, false, false, false]);
  });
});
