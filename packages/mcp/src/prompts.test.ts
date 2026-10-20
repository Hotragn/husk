import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { HuskMcpServer } from './server.js';

describe('MCP prompts', () => {
  it('lists the three starters and renders one as a plain user message', async () => {
    const server = new HuskMcpServer({ ephemeral: false });
    const client = new Client({ name: 'probe', version: '0' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.server.connect(s), client.connect(c)]);

    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.title)).toEqual(['Set up a project', 'Research a topic with sources', 'Fill out a web form with me']);

    const got = await client.getPrompt({ name: 'fill_web_form', arguments: { url: 'https://example.com/form' } });
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0]?.role).toBe('user');
    const text = (got.messages[0]?.content as { text: string }).text;
    expect(text).toContain('https://example.com/form');
    expect(text).toContain('hand_off');

    await expect(client.getPrompt({ name: 'fill_web_form', arguments: {} })).rejects.toThrow();
    await expect(client.getPrompt({ name: 'nope' })).rejects.toThrow();
    await server.close();
  });
});
