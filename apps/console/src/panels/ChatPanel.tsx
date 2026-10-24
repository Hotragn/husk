/**
 * One chat's computer: its browser live, what it has done, and the way out of
 * the chat into a bot.
 *
 * The screen is a websocket that the server feeds only while it is open, so it
 * is closed whenever this tab is hidden: a screen nobody is looking at costs a
 * frame a quarter-second inside the computer for nothing. The activity list is
 * the shared Husk's record of tool calls, which never holds typed text. The
 * conversation itself is not here: chat apps do not send it to Husk.
 */

import { useEffect, useState } from 'react';
import { toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import type { ActivityEntry, BotDraft, ComputerInfo, Overview, PendingHandoff, ScreenMessage } from '../api/wire';
import { Badge, Button, EmptyState, ErrorBlock, PanelHeader, StatusDot, formatWhen } from '../components/primitives';
import { useConnection } from '../state/connection';
import { useResource } from '../state/useResource';
import { stateTone } from './ComputersPanel';
import type { OverviewTarget } from './OverviewPanel';

export function ChatPanel({ computerId, onOpen }: { computerId: string | null; onOpen: (target: OverviewTarget, id: string) => void }) {
  const { api, revision } = useConnection();
  const overview = useResource<Overview>((signal) => api.overview(signal), [api, revision], true, { refreshMs: 3000 });
  const computer = overview.data?.computers.find((c) => c.id === computerId);
  const handoff = overview.data?.handoffs.find((h) => h.computerId === computerId);

  if (!computerId) {
    return (
      <section className="panel">
        <PanelHeader title="Chat" lede="Open a computer from Home to see it here." />
      </section>
    );
  }
  if (overview.error) return <ErrorBlock error={overview.error} retry={overview.reload} />;
  if (!computer) return <p role="status">Opening {computerId}…</p>;

  const name = computer.chatLabel ?? computer.name ?? computer.id;
  return (
    <section className="panel" aria-label={name}>
      <PanelHeader title={name} lede={describe(computer)} />
      <div className="btn-row">
        <StatusDot tone={stateTone(computer.state)} label={computer.state} />
        {computer.platform ? <Badge>{computer.platform}</Badge> : null}
        <span className="field-note mono">{computer.id}</span>
      </div>

      <TakeOver computerId={computer.id} handoff={handoff} onOpen={onOpen} onChange={overview.reload} />

      <div className="chat-grid">
        <LiveScreen id={computer.id} />
        <Activity id={computer.id} />
      </div>

      <div className="btn-row">
        <Button size="sm" onClick={() => onOpen('terminal', computer.id)}>
          Terminal
        </Button>
        <Button size="sm" onClick={() => onOpen('files', computer.id)}>
          Files
        </Button>
        <Button size="sm" onClick={() => onOpen('browser', computer.id)}>
          Browser
        </Button>
      </div>

      <MakeBot computer={computer} />
    </section>
  );
}

function describe(c: ComputerInfo): string {
  if (c.platform) return `The computer ${c.platform} uses for this chat. The conversation stays in ${c.platform}; this is what it did here.`;
  return 'What this computer has done, and its browser, live.';
}

/**
 * The person's hold on a computer. With no hold, Take over pauses its chat at
 * any moment; a chat that asked for them shows why; one they took shows Give
 * back. Only Give back, or Done in Handoffs, lets the chat carry on.
 */
export function TakeOver({
  computerId,
  handoff,
  onOpen,
  onChange,
}: {
  computerId: string;
  handoff: PendingHandoff | undefined;
  onOpen: (target: OverviewTarget, id: string) => void;
  onChange: () => void;
}) {
  const { api } = useConnection();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(toDisplayError(err));
    } finally {
      setBusy(false);
    }
  };
  const failed = error ? <ErrorBlock error={error} /> : null;

  if (!handoff) {
    return (
      <div>
        <Button
          size="sm"
          loading={busy}
          onClick={() =>
            void act(async () => {
              await api.takeOver(computerId);
              onOpen('handoffs', computerId);
            })
          }
        >
          Take over
        </Button>
        {failed}
      </div>
    );
  }
  const mine = handoff.runId === 'person';
  return (
    <div className="overview-waiting" role="status">
      <strong>{mine ? 'You have this computer' : 'Waiting for you'}</strong>
      <p className="handoff-reason">{mine ? 'Its chat is paused until you give it back.' : handoff.reason}</p>
      <div className="btn-row">
        <Button variant="primary" size="sm" onClick={() => onOpen('handoffs', computerId)}>
          {mine ? 'Use it' : 'Take over'}
        </Button>
        {mine ? (
          <Button size="sm" loading={busy} onClick={() => void act(() => api.handoffDone(handoff.handoffId))}>
            Give back
          </Button>
        ) : null}
      </div>
      {failed}
    </div>
  );
}

/** The browser, live, while this tab is visible. `fps` below the server's 4 for a small screen among many. */
export function LiveScreen({ id, fps }: { id: string; fps?: number }) {
  const { api } = useConnection();
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [frame, setFrame] = useState<{ src: string; width: number; height: number } | null>(null);
  const [note, setNote] = useState<string>('Connecting to the screen…');

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    if (!visible) {
      setNote('Paused while this tab is hidden.');
      return;
    }
    const ws = new WebSocket(api.socketUrl(`/v1/computers/${encodeURIComponent(id)}/screen${fps ? `?fps=${fps}` : ''}`));
    ws.onmessage = (ev) => {
      let msg: ScreenMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ScreenMessage;
      } catch {
        return;
      }
      if (msg.type === 'frame') {
        setFrame({ src: `data:image/jpeg;base64,${msg.data}`, width: msg.width, height: msg.height });
        setNote('');
      } else if (msg.type === 'idle') {
        setFrame(null);
        setNote('No browser is open on this computer yet. It appears here when the chat opens a page.');
      } else {
        setNote(msg.message);
      }
    };
    ws.onclose = () => setNote((n) => n || 'The screen disconnected. It reconnects when you come back to this tab.');
    return () => ws.close();
  }, [api, id, visible, fps]);

  return (
    <figure className="chat-screen" aria-label="Live browser">
      {frame ? <img src={frame.src} width={frame.width} height={frame.height} alt={`The browser on ${id}, live`} /> : null}
      {note ? <figcaption className="field-note">{note}</figcaption> : null}
    </figure>
  );
}

/** What the chat did on this computer, newest first. */
export function Activity({ id }: { id: string }) {
  const { api } = useConnection();
  const activity = useResource<ActivityEntry[]>((signal) => api.computerActivity(id, signal), [api, id], true, { refreshMs: 2000 });
  const entries = [...(activity.data ?? [])].reverse();
  return (
    <div className="chat-activity">
      <h3 className="h-sub">Activity</h3>
      {activity.error ? <ErrorBlock error={activity.error} /> : null}
      {activity.data && entries.length === 0 ? (
        <EmptyState title="Nothing yet." body="Each tool call this chat makes on its computer appears here." />
      ) : null}
      <ol className="activity-list" aria-live="polite">
        {entries.map((e, i) => (
          <li key={`${e.at}-${i}`} className={e.ok ? undefined : 'activity-failed'}>
            <span className="field-note tnum">{formatWhen(e.at)}</span> <strong>{e.tool}</strong>
            {e.summary ? <code className="mono"> {e.summary}</code> : null}
            <span className="field-note">
              {' '}
              · {e.ok ? `${e.ms} ms` : 'failed'}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
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
      <h3 className="h-sub">Turn this chat into a bot</h3>
      <p className="field-note">
        Husk reads the conversation, writes a husk.yaml you can review, and saves it as a bot you can run from Husks, on a
        schedule, a webhook, or Discord, Slack and Telegram.
      </p>
      {error ? <ErrorBlock error={error} /> : null}
      {draft ? (
        <>
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
        </>
      ) : null}
      {saved ? <p role="status">Saved as {saved}. Run it from Husks.</p> : null}
      {clash && draft ? (
        <p role="alert">
          A bot called <strong>{draft.spec.name}</strong> already exists. Saving replaces it. Rename this one in Husks, or
          replace it.
        </p>
      ) : null}
      <div className="btn-row">
        <Button loading={busy && !draft} onClick={() => void make()}>
          {draft ? 'Distill again' : 'Make this a bot'}
        </Button>
        {draft && !saved ? (
          <Button variant="primary" loading={busy} onClick={() => void save(clash)}>
            {clash ? `Replace ${draft.spec.name}` : 'Save as a bot'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

