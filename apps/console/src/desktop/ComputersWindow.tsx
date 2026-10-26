/**
 * The Computers window: one compact window whose tabs are the computers your
 * chats are using. A tab shows its chat app's logo and name; the window shows
 * that computer's browser live on a white screen, with the one action that
 * changes who has it. It opens only when the person clicks a computer in the
 * corner (or a notification), never by itself unless they chose that.
 *
 * The chrome is drawn here because the desktop app opens it frameless: the
 * tabs sit in the title bar beside traffic lights on a Mac, slim controls on
 * the right elsewhere. Minimize sends the window to the notch; close only
 * hides it, and the computers keep running in the corner.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { PendingHandoff } from '../api/wire';
import { ErrorBlock } from '../components/primitives';
import { Screen } from '../components/Screen';
import { ON_DEMAND_NOTE, useLook, useScreenFeed } from '../components/useScreenFeed';
import { SIDE_KEYS, useHold } from '../panels/ChatPanel';
import { useTheme } from '../state/theme';
import { AppGlyph } from './AppGlyph';
import { ago, desktopBridge, doing, statusOf, tabName, takingText, useDesktopState } from './bridge';
import type { DesktopBridge, DesktopComputer, DesktopState } from './bridge';

export function ComputersWindow() {
  useTheme();
  const desk = desktopBridge();
  const state = useDesktopState();
  if (!desk) return <p className="desk-note">Open this window from the Husk app.</p>;
  const active = state?.computers.find((c) => c.id === state.active) ?? state?.computers[0];
  const away = state?.connected === false;
  return (
    <div className="cw">
      <Bar desk={desk} state={state} active={active} />
      {away ? (
        <div className="cw-banner cw-banner-away" role="alert">
          <span className="cw-dot cw-dot-away" aria-hidden="true" />
          <span className="cw-banner-text">
            <strong>Husk is not answering.</strong> The app is trying again; the screen comes back when Husk does.
          </span>
        </div>
      ) : null}
      {active ? (
        <Pane key={active.id} desk={desk} computer={active} away={away} />
      ) : (
        <p className="desk-note" role="status">
          {state ? 'No chat is using a computer right now.' : 'Opening…'}
        </p>
      )}
    </div>
  );
}

/** The title bar: the window's controls and the computers' tabs. It drags; its buttons do not. */
function Bar({ desk, state, active }: { desk: DesktopBridge; state: DesktopState | null; active: DesktopComputer | undefined }) {
  const mac = desk.platform === 'darwin';
  const win = (op: 'close' | 'minimize' | 'maximize' | 'pin') => void desk.act({ type: 'window', op });
  const computers = state?.computers ?? [];
  return (
    <header
      className={`cw-bar${mac ? ' cw-bar-mac' : ''}`}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) win('maximize');
      }}
    >
      {mac ? (
        <div className="cw-lights" role="group" aria-label="Window">
          <button type="button" className="cw-light cw-light-close" aria-label="Close window" onClick={() => win('close')} />
          <button type="button" className="cw-light cw-light-min" aria-label="Minimize to the notch" onClick={() => win('minimize')} />
          <button type="button" className="cw-light cw-light-zoom" aria-label="Zoom" onClick={() => win('maximize')} />
        </div>
      ) : null}
      <div className="cw-tabs" role="tablist" aria-label="Computers">
        {computers.map((c) => {
          const on = c.id === active?.id;
          const status = statusOf(c);
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              data-id={c.id}
              className={`cw-tab${on ? ' cw-tab-on' : ''}`}
              aria-selected={on}
              title={c.label}
              onClick={() => void desk.act({ type: 'select', id: c.id })}
            >
              <AppGlyph computer={c} size={18} husk />
              <span className="cw-tab-name">{tabName(c, computers)}</span>
              {status === 'waiting' || status === 'held' ? <span className={`cw-dot cw-dot-${status}`} aria-label={doing(c)} /> : null}
            </button>
          );
        })}
      </div>
      <div className="cw-tools">
        {state ? (
          <button
            type="button"
            className={`cw-icon${state.pinned ? ' cw-icon-on' : ''}`}
            aria-pressed={state.pinned}
            aria-label="Keep on top"
            title="Keep on top"
            onClick={() => win('pin')}
          >
            <Glyph d="M9 3h6l-1 5 3 3v2h-4v6l-1 2-1-2v-6H7v-2l3-3z" />
          </button>
        ) : null}
        {mac ? null : (
          <div className="cw-controls" role="group" aria-label="Window">
            <button type="button" className="cw-control" aria-label="Minimize to the notch" onClick={() => win('minimize')}>
              <Glyph d="M6 12h12" />
            </button>
            <button type="button" className="cw-control" aria-label="Maximize" onClick={() => win('maximize')}>
              <Glyph d="M7 7h10v10H7z" />
            </button>
            <button type="button" className="cw-control cw-control-close" aria-label="Close window" onClick={() => win('close')}>
              <Glyph d="M7 7l10 10M17 7 7 17" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

/** One computer: its screen, white, and who has it. Keyed by computer, so a tab switch starts fresh. */
function Pane({ desk, computer: c, away }: { desk: DesktopBridge; computer: DesktopComputer; away: boolean }) {
  const handoff: PendingHandoff | undefined = c.handoffId
    ? { handoffId: c.handoffId, runId: c.held ? 'person' : 'chat', husk: c.held ? 'you' : 'chat', reason: c.waiting ?? '', computerId: c.id, createdAt: '' }
    : undefined;
  const hold = useHold(c.id, handoff, () => void desk.act({ type: 'refresh' }));
  const running = c.state === 'running';
  // ssh and fly: every picture is a command on the computer, so the screen shows when the person looks, or has it.
  const { looking, look } = useLook(!c.live && !handoff);
  const showing = running && !away && looking;
  // With Husk away, the last frame is not the screen any more: it is cleared, and no feed is asked for.
  const { frame, note } = useScreenFeed(c.id, { enabled: showing });
  const [confirming, setConfirming] = useState(false);
  const status = statusOf(c);
  // While a take-over waits for the AI's call to stop, say which.
  const line = hold.busy && !handoff && c.calling ? takingText(c.calling) : doing(c, away);

  let action: ReactNode;
  if (c.held) {
    action = (
      <button type="button" className="cw-pill cw-pill-light" disabled={hold.busy || away} onClick={() => void hold.giveBack()}>
        Give back
      </button>
    );
  } else if (handoff) {
    action = (
      <button type="button" className="cw-pill cw-pill-warn" disabled={hold.busy || away} onClick={() => setConfirming(true)}>
        Done
      </button>
    );
  } else {
    action = (
      <button type="button" className="cw-pill cw-pill-accent" disabled={hold.busy || !running || away} onClick={() => void hold.take()}>
        Take over
      </button>
    );
  }

  return (
    <>
      {c.waiting && !c.held ? (
        <div className="cw-banner" role="status">
          <span className="cw-dot cw-dot-waiting" aria-hidden="true" />
          <span className="cw-banner-text">
            <strong>Waiting for you.</strong> {c.waiting}
          </span>
          {confirming ? (
            <span className="cw-banner-actions">
              <button type="button" className="cw-pill cw-pill-light" disabled={hold.busy} onClick={() => void hold.giveBack()}>
                Hand back to the chat
              </button>
              <button type="button" className="cw-pill" onClick={() => setConfirming(false)}>
                Not yet
              </button>
            </span>
          ) : null}
        </div>
      ) : null}

      <main className={`cw-body cw-${status}`} role="tabpanel" aria-label={c.label}>
        <Screen
          frame={showing ? frame : null}
          alt={`The browser on ${c.label}, live`}
          note={away ? 'Husk is not answering.' : !running ? 'This computer is stopped. It starts again when its chat uses it.' : looking ? note : ON_DEMAND_NOTE}
          control={handoff && !away ? hold.send : undefined}
          onTakeOver={running && !handoff && !away ? () => void hold.take() : undefined}
          onLook={running && !away && !looking ? look : undefined}
          taking={hold.busy}
          className="cw-screen"
        />
        {handoff ? (
          <div className="cw-keys" role="group" aria-label="Keys">
            {SIDE_KEYS.map(([key, label]) => (
              <button key={key} type="button" className="cw-key" aria-label={`Press ${key}`} onClick={() => hold.send({ type: 'key', key })}>
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </main>

      <footer className="cw-status">
        <span className={`cw-dot cw-dot-${status}`} aria-hidden="true" />
        <span className="cw-doing" title={line}>
          {line}
        </span>
        {c.last ? <span className="cw-ago">{ago(c.last.at)}</span> : null}
        {action}
      </footer>
      {hold.error ? (
        <div className="cw-error">
          <ErrorBlock error={hold.error} />
        </div>
      ) : null}
    </>
  );
}

function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
