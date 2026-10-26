/**
 * Computers a person holds: ones a run or a chat handed over, and ones the
 * person took. Also the page a chat's link opens.
 *
 * A run hands off when it reaches something only a person can do: a login, a
 * 2FA or TOTP code, a consent prompt. It waits until someone presses **Done**
 * (or **Give back**, for a computer they took). Nothing else resumes it —
 * closing this tab, losing the connection or walking away all leave it paused.
 *
 * The view is a frame of the page refreshed about once a second, not a stream.
 * The screen itself takes clicks, the wheel, keys and typed text
 * (components/Screen.tsx); there is no address bar and no script, because a
 * person taking over needs a mouse and a keyboard, not the debugger. What they
 * type is never kept: nothing is written to storage or to the event log.
 *
 * The reason is model text. It is rendered as a React text node and nothing
 * else.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import type { HandoffInput, HandoffKey, PendingHandoff, ScopedComputer } from '../api/wire';
import { Button, EmptyState, ErrorBlock, StatusDot, formatWhen } from '../components/primitives';
import { Screen, useInputQueue } from '../components/Screen';
import type { Frame } from '../components/Screen';
import { ON_DEMAND_NOTE, PUSHED_SCREEN, useLook } from '../components/useScreenFeed';
import { useConnection } from '../state/connection';

const LIST_EVERY_MS = 2_000;
const FRAME_EVERY_MS = 1_000;
const KEYS: Array<[HandoffKey, string]> = [
  ['Tab', 'Tab'],
  ['Enter', 'Enter'],
  ['Escape', 'Esc'],
];

/** Waiting handoffs, polled. Shared by the panel and the nav badge. */
export function useHandoffs(): {
  list: PendingHandoff[];
  error: DisplayError | null;
  /** Drop one at once, rather than showing a finished handoff until the next poll. */
  drop(handoffId: string): void;
} {
  const { api } = useConnection();
  const [list, setList] = useState<PendingHandoff[]>([]);
  const [error, setError] = useState<DisplayError | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        setList(await api.listHandoffs(controller.signal));
        setError(null);
      } catch (err) {
        if (!controller.signal.aborted) setError(toDisplayError(err));
      }
      if (!controller.signal.aborted) timer = setTimeout(tick, LIST_EVERY_MS);
    };
    void tick();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api]);

  const drop = useCallback((handoffId: string) => {
    setList((prev) => prev.filter((h) => h.handoffId !== handoffId));
  }, []);

  return { list, error, drop };
}

export function HandoffsPanel() {
  const { list, error, drop } = useHandoffs();
  const [selected, setSelected] = useState<string | null>(null);
  const active = list.find((h) => h.handoffId === selected) ?? list[0];

  return (
    <section className="panel" aria-labelledby="handoffs-title">
      <div className="panel-head">
        <h1 id="handoffs-title">Handoffs</h1>
        {list.length > 1 ? (
          <div className="btn-row" role="group" aria-label="Waiting handoffs">
            {list.map((h) => (
              <Button
                key={h.handoffId}
                size="sm"
                variant={h.handoffId === active?.handoffId ? 'primary' : 'secondary'}
                aria-pressed={h.handoffId === active?.handoffId}
                onClick={() => setSelected(h.handoffId)}
              >
                {h.husk}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      {error ? <ErrorBlock error={error} /> : null}

      {list.length === 0 && !error ? (
        <EmptyState title="Nothing is waiting on you" body="When a chat needs you to sign in or enter a code, it waits here." />
      ) : null}

      {active ? (
        <HandoffView
          key={active.handoffId}
          handoff={active}
          onDone={() => {
            drop(active.handoffId);
            setSelected(null);
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * One handoff, opened from the link a chat gave the person. The link's key
 * opens this handoff and nothing else, so there is no list and no navigation.
 */
export function LinkedHandoff({ handoffId }: { handoffId: string }) {
  const { api } = useConnection();
  const [handoff, setHandoff] = useState<PendingHandoff | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api.getHandoff(handoffId, controller.signal).then(setHandoff, (err: unknown) => {
      if (!controller.signal.aborted) setError(toDisplayError(err));
    });
    return () => controller.abort();
  }, [api, handoffId]);

  if (finished) {
    return <EmptyState title="Handed back" body="Your AI chat has the computer again. You can close this tab." />;
  }
  if (error) {
    return error.code === 'E_HANDOFF_NOT_FOUND' ? (
      <EmptyState title="This handoff has ended" body="Ask your AI chat for a new link if it still needs you." />
    ) : (
      <ErrorBlock error={error} />
    );
  }
  if (!handoff) return <p role="status">Opening the computer…</p>;
  return <HandoffView handoff={handoff} onDone={() => setFinished(true)} />;
}

const COMPUTER_EVERY_MS = 3_000;

/**
 * One chat's computer, opened from its in-chat card or the link a chat gave.
 * The link's token opens this computer and nothing else. With a handoff on it,
 * this is the take-over view; otherwise its browser, which Take over makes the
 * person's. The link keeps working after they give it back.
 */
export function LinkedComputer() {
  const { api } = useConnection();
  const [computer, setComputer] = useState<ScopedComputer | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  // The handoff the person just finished, so a later one on this computer still shows.
  const [handedBack, setHandedBack] = useState<string | null>(null);
  const [taking, setTaking] = useState(false);
  const [takeError, setTakeError] = useState<DisplayError | null>(null);
  // ssh and fly: every picture is a command on the computer, so it shows when the person looks. Unknown until read.
  const { looking, look } = useLook(!computer || (computer.provider !== undefined && !PUSHED_SCREEN.has(computer.provider)));
  // Take-overs from this page, counted as asked and as answered: a reading asked
  // for before one finished must not undo it by answering after.
  const takes = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let url: string | null = null;
    // A Look starts this again, so the screen comes at once.
    const tick = async () => {
      const seen = takes.current;
      try {
        const next = await api.scopedComputer(controller.signal);
        if (takes.current === seen) {
          setComputer(next);
          setError(null);
          if (!looking) setFrame(null);
          else if (!next.handoff) {
            try {
              const shot = await api.scopedComputerScreen(controller.signal);
              const objectUrl = URL.createObjectURL(shot.image);
              if (url) URL.revokeObjectURL(url);
              url = objectUrl;
              setFrame({ src: objectUrl, width: shot.width, height: shot.height });
            } catch {
              setFrame(null);
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(toDisplayError(err));
      }
      if (!controller.signal.aborted) timer = setTimeout(tick, COMPUTER_EVERY_MS);
    };
    void tick();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, looking]);

  const take = async () => {
    setTaking(true);
    setTakeError(null);
    takes.current++;
    try {
      const handoff = await api.scopedTakeOver();
      takes.current++;
      setComputer((c) => (c ? { ...c, handoff } : c));
    } catch (err) {
      setTakeError(toDisplayError(err));
    } finally {
      setTaking(false);
    }
  };

  if (error) {
    return error.code === 'E_COMPUTER_NOT_FOUND' ? (
      <EmptyState title="This link has expired" body="Open the computer again from your AI chat." />
    ) : (
      <ErrorBlock error={error} />
    );
  }
  if (!computer) return <p role="status">Opening the computer…</p>;
  if (computer.handoff && computer.handoff.handoffId !== handedBack) {
    const done = computer.handoff.handoffId;
    return (
      <HandoffView
        key={done}
        handoff={computer.handoff}
        onDone={() => {
          setHandedBack(done);
          setComputer((c) => (c ? { ...c, handoff: null } : c));
        }}
      />
    );
  }
  const running = computer.state === 'running';
  return (
    <div className="chat-grid">
      <Screen
        frame={frame}
        alt="What this computer's browser is showing"
        note={looking ? 'No browser is open on this computer.' : ON_DEMAND_NOTE}
        onTakeOver={running ? () => void take() : undefined}
        onLook={running && !looking ? look : undefined}
        taking={taking}
      />
      <div className="chat-side">
        <div className="card control-card">
          <div className="row-gap-2" role="status">
            <h1 className="h-sub">{running ? 'Computer running' : `Computer ${computer.state}`}</h1>
            {computer.label ? <p className="field-note">{computer.label}</p> : null}
            <StatusDot tone="muted" label={handedBack ? 'Handed back to the chat' : 'The chat is in control'} />
          </div>
          {running ? (
            <Button variant="accent" loading={taking} onClick={() => void take()}>
              Take over
            </Button>
          ) : null}
          {takeError ? <ErrorBlock error={takeError} /> : null}
        </div>
      </div>
    </div>
  );
}

function HandoffView({ handoff, onDone }: { handoff: PendingHandoff; onDone: () => void }) {
  const { api } = useConnection();
  const [frame, setFrame] = useState<Frame | null>(null);
  const [frameError, setFrameError] = useState<DisplayError | null>(null);
  const [actionError, setActionError] = useState<DisplayError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const inFlight = useRef(false);
  const urlRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current || document.visibilityState === 'hidden') return;
    inFlight.current = true;
    try {
      const shot = await api.handoffScreen(handoff.handoffId);
      const next = URL.createObjectURL(shot.image);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = next;
      setFrame({ src: next, width: shot.width, height: shot.height });
      setFrameError(null);
    } catch (err) {
      setFrameError(toDisplayError(err));
    } finally {
      inFlight.current = false;
    }
  }, [api, handoff.handoffId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), FRAME_EVERY_MS);
    return () => {
      clearInterval(timer);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [refresh]);

  const input = useCallback(
    async (next: HandoffInput) => {
      try {
        await api.handoffInput(handoff.handoffId, next);
        setActionError(null);
      } catch (err) {
        setActionError(toDisplayError(err));
      }
      void refresh();
    },
    [api, handoff.handoffId, refresh],
  );
  const send = useInputQueue(input);

  const finish = async () => {
    setFinishing(true);
    try {
      await api.handoffDone(handoff.handoffId);
      onDone();
    } catch (err) {
      setActionError(toDisplayError(err));
      setFinishing(false);
      setConfirming(false);
    }
  };

  // Taken by the person, not asked for by a run: theirs to give back, no second question.
  const mine = handoff.runId === 'person';
  const noBrowser = frameError?.code === 'E_BROWSER_NOT_FOUND';
  return (
    <div className="chat-grid">
      <div>
        <Screen
          frame={frame}
          alt={`The page the run is paused on: ${handoff.reason}`}
          note={noBrowser ? 'No browser is open. Finish the step another way, then press Done.' : 'Opening the page…'}
          control={send}
        />
        <p className="screen-caption">
          <span>About one frame a second</span>
          <span>Nothing you type is kept</span>
        </p>
        {frameError && !noBrowser ? <ErrorBlock error={frameError} retry={() => void refresh()} /> : null}
      </div>

      <div className="chat-side">
        <div className={`card control-card ${mine ? 'overview-held' : 'overview-card-waiting'}`}>
          <div className="row-gap-2" role="status">
            <h2 className="h-sub">{mine ? 'You have this computer' : 'Paused, waiting for you'}</h2>
            {mine ? null : <p className="handoff-reason">{handoff.reason}</p>}
            <p className="field-note">
              {mine ? 'Since' : `${handoff.husk} · since`} {formatWhen(handoff.createdAt)}
            </p>
          </div>
          {confirming ? (
            <>
              <Button variant="primary" loading={finishing} onClick={() => void finish()}>
                Yes, hand back to the agent
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={finishing}>
                Not yet
              </Button>
            </>
          ) : (
            <Button variant="primary" loading={finishing} onClick={() => (mine ? void finish() : setConfirming(true))}>
              {mine ? 'Give back' : 'Done'}
            </Button>
          )}
          <div className="control-keys" role="group" aria-label="Keys">
            {KEYS.map(([key, label]) => (
              <Button key={key} size="sm" aria-label={`Press ${key}`} onClick={() => send({ type: 'key', key })}>
                {label}
              </Button>
            ))}
          </div>
          <p className="field-note">{mine ? 'The chat waits until you give it back.' : 'Closing this tab does not resume the run.'}</p>
          {actionError ? <ErrorBlock error={actionError} /> : null}
        </div>
      </div>
    </div>
  );
}
