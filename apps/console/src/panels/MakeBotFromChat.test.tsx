import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HuskApi } from '../api/client';
import { MakeBotFromChat } from './MakeBotFromChat';

const api = new HuskApi({ baseUrl: 'http://localhost:7377', token: 'test-token' });
vi.mock('../state/connection', () => ({ useConnection: () => ({ api, revision: 0, invalidate: () => {} }) }));

const ROLLOUT = '/home/me/.codex/sessions/2026/10/25/rollout-2026-10-25T10-00-00-c0de.jsonl';
let calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ method: init?.method ?? 'GET', path, ...(body ? { body } : {}) });
      if (path === '/v1/sessions/discover')
        return Response.json({ sessions: [{ id: 'codex-1', source: 'codex', title: 'Tidy the release notes every Friday', messageCount: 6, updatedAt: '2026-10-25T10:00:00Z', origin: ROLLOUT }] });
      if (path === '/v1/sessions/import') {
        if (body?.path === ROLLOUT) return Response.json({ transcript: { id: 'codex-1', title: 'Tidy the release notes every Friday', source: 'codex' } });
        if (!body?.pick) return Response.json({ source: 'chatgpt', choices: [{ id: 'conv-new', title: 'Weekly report', messages: 4, updatedAt: '2026-10-20T09:00:00Z' }, { id: 'conv-old', title: 'Old chat', messages: 2 }] });
        return Response.json({ transcript: { id: String(body.pick), title: 'Weekly report', source: 'chatgpt' } });
      }
      if (path === '/v1/sessions/distill') {
        const type = (body?.engine as string | undefined) ?? 'codex';
        return Response.json({ transcriptId: body?.transcriptId, yaml: `name: release-notes\nengine:\n  type: ${type}\n`, spec: { name: 'release-notes', engine: { type } }, distilled: { confidence: 0.4 }, engines: ['codex', 'builtin'], continues: false });
      }
      if (path === '/v1/husks/release-notes') return Response.json({ error: { code: 'E_HUSK_NOT_FOUND', message: 'no' } }, { status: 404 });
      if (path === '/v1/husks' && init?.method === 'POST') return Response.json({ name: 'release-notes', displayName: 'x', description: '', model: 'auto' }, { status: 201 });
      return Response.json({ error: { code: 'E_ROUTE_NOT_FOUND', message: 'no' } }, { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Make a bot from a chat', () => {
  it("finds the chats on this computer when asked, and makes one a bot on the person's Codex", async () => {
    render(<MakeBotFromChat />);
    // Nothing on disk is read until the person asks.
    expect(calls.some((c) => c.path === '/v1/sessions/discover')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Find chats on this computer' }));
    expect(await screen.findByText('Tidy the release notes every Friday', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use this chat' }));

    const runsOn = (await screen.findByLabelText('Runs on')) as HTMLSelectElement;
    expect(runsOn.value).toBe('codex');
    expect(calls.find((c) => c.path === '/v1/sessions/import')?.body).toEqual({ path: ROLLOUT });
    expect(screen.getByRole('option', { name: 'Your Codex' })).toBeTruthy();
    expect(screen.getByText(/It starts from what was distilled/)).toBeTruthy();

    fireEvent.change(runsOn, { target: { value: 'builtin' } });
    await waitFor(() => expect(calls.filter((c) => c.path === '/v1/sessions/distill').at(-1)?.body).toMatchObject({ transcriptId: 'codex-1', engine: 'builtin' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save as a bot' }));
    expect(await screen.findByText('Saved as release-notes. Run it from Husks.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/husks')).toBe(true);
  });

  it('asks which chat when an export holds many, and drafts the one picked', async () => {
    render(<MakeBotFromChat />);
    fireEvent.change(screen.getByLabelText('Paste a chat, or an export'), { target: { value: '[{"mapping":{}}]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read it' }));
    expect(await screen.findByText('This file holds 2 chats. Which one?')).toBeTruthy();
    expect(calls.some((c) => c.path === '/v1/sessions/distill')).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Use this one' })[0]!);
    expect(await screen.findByLabelText('Runs on')).toBeTruthy();
    expect(calls.filter((c) => c.path === '/v1/sessions/import').at(-1)?.body).toEqual({ content: '[{"mapping":{}}]', pick: 'conv-new' });
    expect(screen.queryByText('This file holds 2 chats. Which one?')).toBeNull();
  });

  it('reads an uploaded export as text', async () => {
    render(<MakeBotFromChat />);
    const file = new File(['[{"mapping":{}}]'], 'conversations.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('Upload an export'), { target: { files: [file] } });
    await waitFor(() => expect(calls.find((c) => c.path === '/v1/sessions/import')?.body).toEqual({ content: '[{"mapping":{}}]' }));
  });
});
