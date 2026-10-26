/**
 * One chat's computer: its browser live and large, who has it, and what it did.
 *
 * The screen is a websocket that the server feeds only while it is open, so it
 * is closed whenever this tab is hidden: a screen nobody is looking at costs a
 * frame a quarter-second inside the computer for nothing. Clicking the screen
 * offers Take over; once the person holds the computer, the screen is their
 * mouse and keyboard on the page (components/Screen.tsx), and Give back sits
 * beside it. The activity list is the shared Husk's record of tool calls, which
 * never holds typed text. The conversation itself is not here: chat apps do
 * not send it to Husk.
 */

import { useCallback, useState } from 'react';
import { toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import type { ActivityEntry, BotDraft, ComputerInfo, HandoffInput, HandoffKey, Overview, PendingHandoff } from '../api/wire';
import { Button, ErrorBlock, Icon, StatusDot, formatWhen } from '../components/primitives';
import { Screen, useInputQueue } from '../components/Screen';
import { ON_DEMAND_NOTE, PUSHED_SCREEN, useLook, useScreenFeed } from '../components/useScreenFeed';
import { AppBadge } from '../desktop/AppGlyph';
import { takingText } from '../desktop/bridge';
import { useConnection } from '../state/connection';
import { useResource } from '../state/useResource';
import { stateTone } from './ComputersPanel';
import type { OverviewTarget } from './OverviewPanel';

export function ChatPanel({ computerId, onOpen }: { computerId: string | null; onOpen: (target: OverviewTarget, id: string) => void }) {
  const { api, revision } = useConnection();
  const overview = useResource<Overview>((signal) => api.overview(signal), [api, revision], true, { refreshMs: 3000 });
  const computer = overview.data?.computers.find((c) => c.id === computerId);
  const handoff = overview.data?.handoffs.find((h) => h.computerId === computerId);
  const hold = useHold(computerId ?? '', handoff, overview.reload);

  if (!computerId) {
    return (
      <section className="panel">
        <h1>Chat</h1>
        <p className="lede">Open a computer from Home.</p>
      </section>
    );
  }
  if (overview.error) return <ErrorBlock error={overview.error} retry={overview.reload} />;
  if (!computer) return <p role="status">Opening {computerId}…</p>;

  const name = computer.chatLabel ?? computer.name ?? computer.id;
  return (
    <section className="panel" aria-label={name}>
      <header className="chat-head">
        <div className="chat-title">
          <h1>{name}</h1>
          <div className="btn-row">
            <StatusDot pill tone={stateTone(computer.state)} label={computer.state} />
            {computer.platform ? <AppBadge platform={computer.platform} /> : null}
            <span className="field-note mono">{computer.id}</span>
          </div>
        </div>
        <div className="btn-row">
          <Button size="sm" variant="ghost" onClick={() => onOpen('terminal', computer.id)}>
            <Icon name="terminal" /> Terminal
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onOpen('files', computer.id)}>
            <Icon name="files" /> Files
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onOpen('browser', computer.id)}>
            <Icon name="browser" /> Browser
          </Button>
        </div>
      </header>

      <div className="chat-grid">
        <LiveScreen
          id={computer.id}
          control={handoff ? hold.send : undefined}
          onTakeOver={computer.state === 'running' ? () => void hold.take() : undefined}
          taking={hold.busy}
          onDemand={!PUSHED_SCREEN.has(computer.provider)}
        />
        <div className="chat-side">
          <Control
            key={handoff?.handoffId ?? 'free'}
            handoff={handoff}
            hold={hold}
            running={computer.state === 'running'}
            inChat={overview.data?.inChat?.includes(computer.id) === true}
            calling={overview.data?.running?.[computer.id]?.tool}
          />
          <Activity id={computer.id} />
        </div>
      </div>

      <MakeBot computer={computer} />
    </section>
  );
}

export type Hold = ReturnType<typeof useHold>;

/**
 * The person's hold on a computer: take it, use it, give it back. Taking
 * pauses its chat at any moment; only Give back, or Done for a chat that asked,
 * lets the chat carry on.
 */
export function useHold(computerId: string, handoff: PendingHandoff | undefined, onChange: () => void) {
  const { api } = useConnection();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
      return true;
    } catch (err) {
      setError(toDisplayError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const handoffId = handoff?.handoffId;
  const input = useCallback(
    async (next: HandoffInput) => {
      if (!handoffId) return;
      try {
        await api.handoffInput(handoffId, next);
        setError(null);
      } catch (err) {
        setError(toDisplayError(err));
      }
    },
    [api, handoffId],
  );
  const send = useInputQueue(input);
  return {
    busy,
    error,
    send,
    take: () => act(() => api.takeOver(computerId)),
    giveBack: () => (handoffId ? act(() => api.handoffDone(handoffId)) : Promise.resolve(false)),
  };
}

export const SIDE_KEYS: Array<[HandoffKey, string]> = [
  ['Tab', 'Tab'],
  ['Enter', 'Enter'],
  ['Escape', 'Esc'],
];

/** Where a take-over cannot work: the chat runs this computer in its own process. */
export function InChatNote() {
  return <p className="field-note">It runs in its chat’s own process. Ask the chat for its link to watch it or take it over.</p>;
}

/** Who has the computer, and the one action that changes it. */
function Control({
  handoff,
  hold,
  running,
  inChat,
  calling,
}: {
  handoff: PendingHandoff | undefined;
  hold: Hold;
  running: boolean;
  inChat: boolean;
  calling: string | undefined;
}) {
  const [confirming, setConfirming] = useState(false);
  const failed = hold.error ? <ErrorBlock error={hold.error} /> : null;

  if (!handoff && inChat) {
    return (
      <div className="card control-card">
        <div role="status">
          <StatusDot tone="muted" label="The chat runs this computer itself" />
        </div>
        <InChatNote />
      </div>
    );
  }
  if (!handoff) {
    return (
      <div className="card control-card">
        <div role="status">
          <StatusDot tone="muted" label="The chat is in control" />
        </div>
        <Button variant="accent" loading={hold.busy} disabled={!running} onClick={() => void hold.take()}>
          Take over
        </Button>
        <p className="field-note" aria-live="polite">
          {hold.busy && calling ? takingText(calling) : 'Pauses the chat until you give it back.'}
        </p>
        {failed}
      </div>
    );
  }
  const mine = handoff.runId === 'person';
  return (
    <div className={`card control-card ${mine ? 'overview-held' : 'overview-card-waiting'}`}>
      <div className="row-gap-2" role="status">
        <StatusDot tone={mine ? 'info' : 'warn'} label={mine ? 'You’re in control' : 'Waiting for you'} />
        {mine ? null : <p className="handoff-reason">{handoff.reason}</p>}
      </div>
      {confirming ? (
        <>
          <Button variant="primary" loading={hold.busy} onClick={() => void hold.giveBack()}>
            Yes, hand back to the agent
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)} disabled={hold.busy}>
            Not yet
          </Button>
        </>
      ) : (
        <Button variant="primary" loading={hold.busy} onClick={() => (mine ? void hold.giveBack() : setConfirming(true))}>
          {mine ? 'Give back' : 'Done'}
        </Button>
      )}
      <div className="control-keys" role="group" aria-label="Keys">
        {SIDE_KEYS.map(([key, label]) => (
          <Button key={key} size="sm" aria-label={`Press ${key}`} onClick={() => hold.send({ type: 'key', key })}>
            {label}
          </Button>
        ))}
      </div>
      <p className="field-note">Click and type on the screen. Nothing you type is kept.</p>
      {failed}
    </div>
  );
}

/**
 * A computer's hold, compact, for its card on Home. Taking it, or using it,
 * opens its chat page, where the screen is.
 */
export function TakeOver({
  computerId,
  handoff,
  onOpen,
  onChange,
  inChat = false,
  calling,
}: {
  computerId: string;
  handoff: PendingHandoff | undefined;
  onOpen: (target: OverviewTarget, id: string) => void;
  onChange: () => void;
  inChat?: boolean;
  /** The AI's call running on it now, which a take-over waits for. */
  calling?: string | undefined;
}) {
  const hold = useHold(computerId, handoff, onChange);
  const failed = hold.error ? <ErrorBlock error={hold.error} /> : null;

  if (!handoff && inChat) return <InChatNote />;

  if (!handoff) {
    return (
      <>
        <Button
          size="sm"
          loading={hold.busy}
          onClick={() =>
            void hold.take().then((ok) => {
              if (ok) onOpen('chat', computerId);
            })
          }
        >
          Take over
        </Button>
        {hold.busy && calling ? <p className="field-note">{takingText(calling)}</p> : null}
        {failed}
      </>
    );
  }
  const mine = handoff.runId === 'person';
  return (
    <div className={`overview-waiting${mine ? ' overview-held' : ''}`}>
      <div className="row-gap-2" role="status">
        <strong>{mine ? 'You have this computer' : 'Waiting for you'}</strong>
        {mine ? null : <p className="handoff-reason">{handoff.reason}</p>}
      </div>
      <div className="btn-row">
        <Button variant="primary" size="sm" onClick={() => onOpen('chat', computerId)}>
          {mine ? 'Use it' : 'Take over'}
        </Button>
        {mine ? (
          <Button size="sm" loading={hold.busy} onClick={() => void hold.giveBack()}>
            Give back
          </Button>
        ) : null}
      </div>
      {failed}
    </div>
  );
}

/**
 * The browser, live, while this tab is visible. `fps` below the server's 4 for
 * a small screen among many. With `control` it is the person's to use; with
 * `onTakeOver`, clicking it offers Take over. `onDemand` (ssh and fly, where
 * every picture is a command on the computer) shows it only for a Look, unless
 * the person has it.
 */
export function LiveScreen({
  id,
  fps,
  control,
  onTakeOver,
  taking,
  className,
  onDemand = false,
}: {
  id: string;
  fps?: number;
  control?: ((input: HandoffInput) => void) | undefined;
  onTakeOver?: (() => void) | undefined;
  taking?: boolean;
  className?: string;
  onDemand?: boolean;
}) {
  const { looking, look } = useLook(onDemand && !control);
  const { frame, note } = useScreenFeed(id, { ...(fps ? { fps } : {}), enabled: looking });

  return (
    <Screen
      frame={looking ? frame : null}
      alt={`The browser on ${id}, live`}
      note={looking ? note : ON_DEMAND_NOTE}
      control={control}
      onTakeOver={onTakeOver}
      onLook={looking ? undefined : look}
      taking={taking ?? false}
      {...(className ? { className } : {})}
    />
  );
}

/** What the chat did on this computer, newest first. */
export function Activity({ id }: { id: string }) {
  const { api } = useConnection();
  const activity = useResource<ActivityEntry[]>((signal) => api.computerActivity(id, signal), [api, id], true, { refreshMs: 2000 });
  const entries = [...(activity.data ?? [])].reverse();
  return (
    <div className="card chat-activity">
      <h2 className="h-sub">Activity</h2>
      {activity.error ? <ErrorBlock error={activity.error} /> : null}
      {activity.data && entries.length === 0 ? <p className="field-note">No tool calls yet.</p> : null}
      <ol className="activity-list" aria-live="polite">
        {entries.map((e, i) => (
          <li key={`${e.at}-${i}`} className={e.ok ? undefined : 'activity-failed'}>
            <strong title={e.tool}>{e.tool}</strong>
            <span className="field-note tnum activity-meta" title={formatWhen(e.at)}>
              {e.ok ? `${e.ms} ms` : 'failed'} · {timeOf(e.at)}
            </span>
            {e.summary ? <code className="mono">{e.summary}</code> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

/**
 * Turn the chat into a bot: a husk.yaml distilled from the conversation, shown
 * before anything is saved, because a draft with a 16% confidence is a draft.
 */
function MakeBot({ computer }: { computer: ComputerInfo }) {
  const { api } = useConnection();
  const [draft, setDraft] = useState<BotDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /** A bot by this name already exists: saving would replace it, so the person decides. */
  const [clash, setClash] = useState(false);

  const make = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    setClash(false);
    try {
      setDraft(await api.makeBot(computer.id));
    } catch (err) {
      setError(toDisplayError(err));
    } finally {
      setBusy(false);
    }
  };
  const save = async (replace: boolean) => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      if (!replace) {
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

  const confidence = draft?.distilled.confidence;
  return (
    <div className="card chat-bot">
      <div className="chat-head">
        <div>
          <h2 className="h-sub">Make this chat a bot</h2>
          <p className="field-note">A husk.yaml from this chat, to run on a schedule, a webhook or in Discord, Slack and Telegram.</p>
        </div>
        <div className="btn-row">
          <Button size="sm" loading={busy && !draft} onClick={() => void make()}>
            {draft ? 'Distill again' : 'Make this a bot'}
          </Button>
          {draft && !saved ? (
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save(clash)}>
              {clash ? `Replace ${draft.spec.name}` : 'Save as a bot'}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <ErrorBlock error={error} /> : null}
      {draft ? (
        <div className="chat-bot-body">
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
    </div>
  );
}
