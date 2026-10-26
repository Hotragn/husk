/**
 * Make a bot from a chat in any app (J5-d): one Husk found where the app keeps
 * its chats (Claude Code, Codex, Cursor, Gemini CLI), an export (ChatGPT,
 * Claude, Gemini), or pasted text. A file that holds many chats asks which
 * one. The draft is reviewed and saved as the chat page's "Make this a bot" is.
 */

import { useState } from 'react';
import { toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import type { BotEngine, FoundChat } from '../api/wire';
import { Button, ErrorBlock, Field, formatWhen } from '../components/primitives';
import { useConnection } from '../state/connection';
import { useResource } from '../state/useResource';
import { DraftReview, useBotDraft } from './BotDraft';

const APP: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  chatgpt: 'ChatGPT',
};

type Input = { path?: string; content?: string };

function textOf(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
type Choice = { id: string; title: string; messages: number; updatedAt?: string };

export function MakeBotFromChat() {
  const { api } = useConnection();
  const [looking, setLooking] = useState(false);
  const found = useResource<FoundChat[]>((signal) => api.findChats(signal), [api, looking], looking);
  const [text, setText] = useState('');
  const [path, setPath] = useState('');
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);
  const [choices, setChoices] = useState<{ input: Input; items: Choice[] } | null>(null);
  const [chat, setChat] = useState<{ id: string; title: string } | null>(null);
  const bot = useBotDraft();

  const draft = (id: string, engine?: BotEngine) => bot.make(() => api.draftBot(id, engine ? { engine } : {}));
  const read = async (input: Input & { pick?: string }) => {
    setReading(true);
    setError(null);
    bot.clear();
    try {
      const res = await api.importChat(input);
      if ('choices' in res) {
        setChoices({ input, items: res.choices });
        setChat(null);
        return;
      }
      setChoices(null);
      setChat({ id: res.transcript.id, title: res.transcript.title ?? res.transcript.id });
      await draft(res.transcript.id);
    } catch (err) {
      setError(toDisplayError(err));
    } finally {
      setReading(false);
    }
  };
  const upload = async (file: File | undefined) => {
    if (file) await read({ content: await textOf(file) });
  };

  return (
    <div className="card chat-bot">
      <div className="chat-head">
        <div>
          <h2 className="h-sub">Make a bot from a chat</h2>
          <p className="field-note">From a chat on this computer, or one you export from ChatGPT, Claude or Gemini, or paste.</p>
        </div>
        <div className="btn-row">
          <Button size="sm" loading={found.loading && looking} onClick={() => (looking ? found.reload() : setLooking(true))}>
            Find chats on this computer
          </Button>
        </div>
      </div>

      {found.error ? <ErrorBlock error={found.error} retry={found.reload} /> : null}
      {looking && found.data ? (
        found.data.length ? (
          <ul className="found-chats" aria-label="Chats found on this computer">
            {found.data.slice(0, 20).map((c) => (
              <li key={`${c.source}:${c.origin}`}>
                <span>
                  <strong>{APP[c.source] ?? c.source}</strong> · {c.title}
                </span>
                <span className="field-note tnum">{formatWhen(c.updatedAt)}</span>
                <Button size="sm" disabled={reading} onClick={() => void read({ path: c.origin })}>
                  Use this chat
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="field-note">No chats found where Claude Code, Codex, Cursor or Gemini CLI keep them. Paste one, or upload an export.</p>
        )
      ) : null}

      <Field label="Paste a chat, or an export" htmlFor="chat-text">
        <textarea id="chat-text" className="textarea mono" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Field label="Or its path on this computer" htmlFor="chat-path" note="A big export, over 32 MB, goes by its path.">
        <input id="chat-path" className="input mono" value={path} onChange={(e) => setPath(e.target.value)} />
      </Field>
      <div className="btn-row">
        <Button size="sm" loading={reading} disabled={!text.trim() && !path.trim()} onClick={() => void read(text.trim() ? { content: text } : { path: path.trim() })}>
          Read it
        </Button>
        <label className="btn btn-secondary btn-sm">
          Upload an export
          <input type="file" className="visually-hidden" accept=".json,.jsonl,.md,.txt" disabled={reading} onChange={(e) => void upload(e.target.files?.[0])} />
        </label>
      </div>
      {error ? <ErrorBlock error={error} /> : null}

      {choices ? (
        <fieldset className="found-chats">
          <legend>This file holds {choices.items.length} chats. Which one?</legend>
          <ul>
            {choices.items.map((c) => (
              <li key={c.id}>
                <span>
                  {c.title} <span className="field-note tnum">· {c.messages} messages{c.updatedAt ? ` · ${formatWhen(c.updatedAt)}` : ''}</span>
                </span>
                <Button size="sm" disabled={reading} onClick={() => void read({ ...choices.input, pick: c.id })}>
                  Use this one
                </Button>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}

      {chat ? (
        <>
          <div className="chat-head">
            <p className="field-note">
              From <strong>{chat.title}</strong>
            </p>
            <div className="btn-row">
              <Button size="sm" loading={bot.busy && !bot.draft} onClick={() => void draft(chat.id, bot.draft ? bot.engine : undefined)}>
                Distill again
              </Button>
              {bot.draft && !bot.saved ? (
                <Button size="sm" variant="primary" loading={bot.busy} onClick={() => void bot.save()}>
                  {bot.clash ? `Replace ${bot.draft.spec.name}` : 'Save as a bot'}
                </Button>
              ) : null}
            </div>
          </div>
          <DraftReview state={bot} onEngine={(engine) => void draft(chat.id, engine)} />
        </>
      ) : null}
    </div>
  );
}
