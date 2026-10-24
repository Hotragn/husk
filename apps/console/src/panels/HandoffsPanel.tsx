/**
 * Runs that stopped for a person, and a view of the page they stopped on.
 *
 * A run hands off when it reaches something only a person can do: a login, a
 * 2FA or TOTP code, a consent prompt. It waits here until someone presses
 * **Done**. Nothing else resumes it — closing this tab, losing the connection
 * or walking away all leave it paused, which the panel says in as many words.
 *
 * The view is a frame of the page refreshed about once a second, not a stream,
 * and the bar says so. Clicks, the wheel, text and a few named keys go back to
 * the page; there is no address bar and no script, because a person taking over
 * needs a mouse and a keyboard, not the debugger.
 *
 * What a person types here is usually a password or a one-time code. It is
 * held in a password field by default, sent once, and never kept: the field is
 * cleared on send and nothing is written to storage or to the event log.
 *
 * The reason is model text. It is rendered as a React text node and nothing
 * else.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import type { HandoffInput, HandoffKey, PendingHandoff, ScopedComputer } from '../api/wire';
import { Button, EmptyState, ErrorBlock, PanelHeader, StatusLine, formatWhen } from '../components/primitives';
import { useConnection } from '../state/connection';

const LIST_EVERY_MS = 2_000;
const FRAME_EVERY_MS = 1_000;
const KEYS: HandoffKey[] = ['Enter', 'Tab', 'Backspace', 'Escape'];

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
      <PanelHeader
        title="Handoffs"
        lede="Computers a chat handed to you, or you took. Only Done or Give back hands one back."
      />
      <span id="handoffs-title" className="visually-hidden">
        Handoffs
      </span>

      {error ? <ErrorBlock error={error} /> : null}

      {list.length === 0 && !error ? (
        <EmptyState
          title="Nothing is waiting on you"
          body="When a run needs you to sign in or enter a code, it appears here and waits. It stays paused until you press Done."
        />
      ) : null}

      {list.length > 1 ? (
        <div className="btn-row" role="group" aria-label="Waiting handoffs">
          {list.map((h) => (
            <Button
              key={h.handoffId}
              variant={h.handoffId === active?.handoffId ? 'primary' : 'secondary'}
              aria-pressed={h.handoffId === active?.handoffId}
              onClick={() => setSelected(h.handoffId)}
            >
              {h.husk}
            </Button>
          ))}
        </div>
      ) : null}

      {active ? <HandoffView key={active.handoffId} handoff={active} onDone={() => {
            drop(active.handoffId);
            setSelected(null);
          }} /> : null}
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
      <EmptyState title="This handoff has ended" body="It was finished or the chat closed. Ask your AI chat for a new link if it still needs you." />
    ) : (
      <ErrorBlock error={error} />
    );
  }
  if (!handoff) return <p role="status">Opening the computer…</p>;
  return <HandoffView handoff={handoff} onDone={() => setFinished(true)} />;
}

const COMPUTER_EVERY_MS = 3_000;

/**
 * One chat's computer, opened from its in-chat card. The link's token opens
 * this computer and nothing else. When a handoff is waiting on it, this is the
 * take-over view; otherwise it says what state the computer is in and shows a
 * read-only frame of its browser, if one is open.
 */
export function LinkedComputer() {
  const { api } = useConnection();
  const [computer, setComputer] = useState<ScopedComputer | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  // The handoff the person just finished, so a later one on this computer still shows.
  const [handedBack, setHandedBack] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let url: string | null = null;
    const tick = async () => {
      try {
        const next = await api.scopedComputer(controller.signal);
        setComputer(next);
        setError(null);
        if (!next.handoff) {
          try {
            const frame = await api.scopedComputerScreen(controller.signal);
            const objectUrl = URL.createObjectURL(frame.image);
            if (url) URL.revokeObjectURL(url);
            url = objectUrl;
            setFrameUrl(objectUrl);
          } catch {
            setFrameUrl(null);
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
  }, [api]);

  if (error) {
    return error.code === 'E_COMPUTER_NOT_FOUND' ? (
      <EmptyState title="This link has expired" body="Links from a chat last a few minutes. Open the computer again from your AI chat." />
    ) : (
      <ErrorBlock error={error} />
    );
  }
  if (!computer) return <p role="status">Opening the computer…</p>;
  if (computer.handoff && computer.handoff.handoffId !== handedBack) {
    return <HandoffView key={computer.handoff.handoffId} handoff={computer.handoff} onDone={() => setHandedBack(computer.handoff!.handoffId)} />;
  }
  return (
    <div className="row-gap-4">
      <div className="card" role="status" aria-live="polite">
        <h3>{computer.state === 'running' ? 'Computer running' : `Computer ${computer.state}`}</h3>
        {computer.label ? <p className="field-note">{computer.label}</p> : null}
        <p className="field-note">
          {handedBack ? 'Handed back. ' : ''}Nothing needs you right now. If your AI hands this computer to you, it
          appears here.
        </p>
      </div>
      {frameUrl ? (
        <figure className="handoff-screen">
          <img src={frameUrl} alt="What this computer's browser is showing" draggable={false} />
          <figcaption className="field-note">A look at its browser, refreshed every few seconds. View only.</figcaption>
        </figure>
      ) : (
        <StatusLine text="No browser is open on this computer." />
      )}
    </div>
  );
}

function HandoffView({ handoff, onDone }: { handoff: PendingHandoff; onDone: () => void }) {
  const { api } = useConnection();
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [takenAt, setTakenAt] = useState<Date | null>(null);
  const [frameError, setFrameError] = useState<DisplayError | null>(null);
  const [actionError, setActionError] = useState<DisplayError | null>(null);
  const [text, setText] = useState('');
  const [reveal, setReveal] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const inFlight = useRef(false);
  const urlRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current || document.visibilityState === 'hidden') return;
    inFlight.current = true;
    try {
      const frame = await api.handoffScreen(handoff.handoffId);
      const next = URL.createObjectURL(frame.image);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = next;
      setFrameUrl(next);
      setViewport(frame.width > 0 && frame.height > 0 ? { width: frame.width, height: frame.height } : null);
      setTakenAt(new Date());
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

  const send = useCallback(
    async (input: HandoffInput) => {
      try {
        await api.handoffInput(handoff.handoffId, input);
        setActionError(null);
      } catch (err) {
        setActionError(toDisplayError(err));
      }
      void refresh();
    },
    [api, handoff.handoffId, refresh],
  );

  /** Where on the page a point on the image is, in the page's own CSS pixels. */
  const toPage = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const img = imgRef.current;
      if (!img || !viewport) return null;
      const rect = img.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const x = ((clientX - rect.left) / rect.width) * viewport.width;
      const y = ((clientY - rect.top) / rect.height) * viewport.height;
      return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
    },
    [viewport],
  );

  // A wheel listener React attaches is passive, so it cannot stop the console
  // scrolling underneath. This one is not.
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const onWheel = (e: WheelEvent) => {
      const at = toPage(e.clientX, e.clientY);
      if (!at) return;
      e.preventDefault();
      void send({ type: 'scroll', ...at, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
    };
    img.addEventListener('wheel', onWheel, { passive: false });
    return () => img.removeEventListener('wheel', onWheel);
  }, [send, toPage, frameUrl]);

  const submitText = (e: FormEvent) => {
    e.preventDefault();
    if (!text) return;
    const value = text;
    setText('');
    void send({ type: 'text', text: value });
  };

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

  // Taken from Home or Chat by the person, not asked for by the chat.
  const mine = handoff.runId === 'person';
  return (
    <div className="row-gap-4">
      <div className="card" role="status" aria-live="polite">
        <h3>{mine ? 'You have this computer' : 'Paused, waiting for you'}</h3>
        <p className="handoff-reason">{handoff.reason}</p>
        <p className="field-note">
          {handoff.husk} · since {formatWhen(handoff.createdAt)} · closing this tab or losing the connection does not
          resume the run
        </p>
      </div>

      {frameError ? (
        frameError.code === 'E_BROWSER_NOT_FOUND' ? (
          <StatusLine text="This run has no browser open. Finish the step another way, then press Done." />
        ) : (
          <ErrorBlock error={frameError} retry={() => void refresh()} />
        )
      ) : null}

      {frameUrl ? (
        <figure className="handoff-screen">
          <img
            ref={imgRef}
            src={frameUrl}
            alt={`The page the run is paused on: ${handoff.reason}`}
            draggable={false}
            onClick={(e) => {
              const at = toPage(e.clientX, e.clientY);
              if (at) void send({ type: 'click', ...at });
            }}
            onDoubleClick={(e) => {
              const at = toPage(e.clientX, e.clientY);
              if (at) void send({ type: 'click', ...at, double: true });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              const at = toPage(e.clientX, e.clientY);
              if (at) void send({ type: 'click', ...at, button: 'right' });
            }}
          />
          <figcaption className="field-note">
            A frame about once a second, not a live stream
            {takenAt ? ` · last ${takenAt.toLocaleTimeString()}` : ''}. Click, scroll and type below.
          </figcaption>
        </figure>
      ) : null}

      <form className="handoff-type" onSubmit={submitText}>
        <label htmlFor="handoff-text">Type into the page</label>
        <div className="btn-row">
          <input
            id="handoff-text"
            className="input"
            type={reveal ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            maxLength={2000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" disabled={!text}>
            Send
          </Button>
          <Button onClick={() => setReveal((r) => !r)} aria-pressed={reveal}>
            {reveal ? 'Hide' : 'Show'}
          </Button>
        </div>
        <p className="field-note">Click the field on the page first. What you send is not kept.</p>
      </form>

      <div className="btn-row" role="group" aria-label="Keys">
        {KEYS.map((key) => (
          <Button key={key} size="sm" onClick={() => void send({ type: 'key', key })}>
            {key}
          </Button>
        ))}
      </div>

      {actionError ? <ErrorBlock error={actionError} /> : null}

      <div className="btn-row">
        {confirming ? (
          <>
            <Button variant="primary" loading={finishing} onClick={() => void finish()}>
              Yes, hand back to the agent
            </Button>
            <Button onClick={() => setConfirming(false)} disabled={finishing}>
              Not yet
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => setConfirming(true)}>
            {mine ? 'Give back' : 'Done'}
          </Button>
        )}
      </div>
    </div>
  );
}
