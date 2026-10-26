/**
 * A bot draft from a chat, shown before anything is saved, because a draft
 * with a 16% confidence is a draft: what it runs on, what was distilled, its
 * husk.yaml, and saving it, which asks before replacing a bot of that name.
 * The chat page's "Make this a bot" and Husks' "Make a bot from a chat" share it.
 */

import { useState } from 'react';
import { toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import type { BotDraft, BotEngine } from '../api/wire';
import { ErrorBlock, Field } from '../components/primitives';
import { useConnection } from '../state/connection';

export function useBotDraft() {
  const { api } = useConnection();
  const [draft, setDraft] = useState<BotDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /** A bot by this name already exists: saving would replace it, so the person decides. */
  const [clash, setClash] = useState(false);

  const make = async (load: () => Promise<BotDraft>) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    setClash(false);
    try {
      setDraft(await load());
    } catch (err) {
      setError(toDisplayError(err));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      if (!clash) {
        const exists = await api.getHusk(draft.spec.name).then(
          () => true,
          () => false,
        );
        if (exists) {
          setClash(true);
          return;
        }
      }
      const summary = await api.createHusk(draft.yaml);
      setClash(false);
      setSaved(summary.name);
    } catch (err) {
      setError(toDisplayError(err));
    } finally {
      setBusy(false);
    }
  };
  const clear = () => {
    setDraft(null);
    setError(null);
    setSaved(null);
    setClash(false);
  };
  const engine: BotEngine = draft?.spec.engine?.type ?? 'builtin';
  return { draft, busy, error, saved, clash, engine, make, save, clear };
}

export type BotDraftState = ReturnType<typeof useBotDraft>;

/** What runs a bot, in the words the person reads. */
function engineLabel(engine: BotEngine, resumes: boolean): string {
  if (engine === 'claude-code') return resumes ? 'Your Claude Code, continuing this chat' : 'Your Claude Code';
  if (engine === 'codex') return 'Your Codex';
  return "Husk's own engine, on any model";
}

function engineNote(engine: BotEngine, resumes: boolean): string {
  if (engine === 'builtin') return "Husk's own engine, on any model you have set up, a local Ollama included.";
  const cli = engine === 'claude-code' ? 'Claude Code' : 'Codex';
  return resumes
    ? `Your own ${cli}, on your own login, goes on with this chat on its computer, with Husk's tools only.`
    : `Your own ${cli}, on your own login, with Husk's tools only. It starts from what was distilled.`;
}

/** The draft under its header: what it runs on (asking `onEngine` for another), what was distilled, the YAML. */
export function DraftReview({ state, onEngine }: { state: BotDraftState; onEngine: (engine: BotEngine) => void }) {
  const { draft, busy, error, saved, clash, engine } = state;
  const engines = draft?.engines ?? [];
  const continues = draft?.continues === true;
  const confidence = draft?.distilled.confidence;
  return (
    <>
      {error ? <ErrorBlock error={error} /> : null}
      {draft ? (
        <div className="chat-bot-body">
          {engines.length > 1 ? (
            <Field label="Runs on" htmlFor="bot-engine" note={engineNote(engine, engine === 'claude-code' && continues)}>
              <select id="bot-engine" className="select" value={engine} disabled={busy} onChange={(e) => onEngine(e.target.value as BotEngine)}>
                {engines.map((e) => (
                  <option key={e} value={e}>
                    {engineLabel(e, e === 'claude-code' && continues)}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p className="field-note">Runs on Husk's own engine. With Claude Code or Codex installed where Husk can find it, the bot could run on your own login.</p>
          )}
          <p className="field-note">
            Draft for <strong>{draft.spec.name}</strong>
            {confidence !== undefined ? ` · confidence ${Math.round(confidence * 100)}%` : ''}. Read it before saving.
          </p>
          {draft.distilled.notes?.length ? (
            <ul className="field-note">
              {draft.distilled.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          <pre className="mono chat-yaml">{draft.yaml}</pre>
        </div>
      ) : null}
      {saved ? <p role="status">Saved as {saved}. Run it from Husks.</p> : null}
      {clash && draft ? (
        <p role="alert">
          A bot called <strong>{draft.spec.name}</strong> already exists. Saving replaces it.
        </p>
      ) : null}
    </>
  );
}
