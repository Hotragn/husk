/**
 * One chat's computer in a small window of its own, the desktop app's
 * picture-in-picture: the browser live and edge to edge, its tabs by name,
 * and the one action that changes who has it. No console around it.
 *
 * The window chrome is drawn here because the desktop app opens it frameless:
 * traffic lights on a Mac, slim controls on the right elsewhere. Minimize
 * sends the window to the notch, close only hides it (the computer keeps
 * running, and its 3D computer stays in the row), and the title bar drags.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { BrowserTab, PendingHandoff } from '../api/wire';
import { ErrorBlock } from '../components/primitives';
import { Screen } from '../components/Screen';
import { useScreenFeed } from '../components/useScreenFeed';
import { SIDE_KEYS, useHold } from '../panels/ChatPanel';
import { useConnection } from '../state/connection';
import { useTheme } from '../state/theme';
import { useResource } from '../state/useResource';
import { AppGlyph } from './AppGlyph';
import { ago, desktopBridge, doing, statusOf, useDesktopState } from './bridge';
import type { DesktopBridge, DesktopComputer } from './bridge';

export function ComputerWindow({ id }: { id: string }) {
  useTheme();
  const desk = desktopBridge();
  const state = useDesktopState();
  const me = state?.computers.find((c) => c.id === id);
  if (!desk) return <p className="desk-note">Open this window from the Husk app.</p>;
  if (!me) {
    return (
      <div className="cw">
        <Bar desk={desk} title="Husk" />
        <p className="desk-note" role="status">
          Opening this computer…
        </p>
      </div>
    );
  }
  return <Window desk={desk} computer={me} />;
}

function Window({ desk, computer: c }: { desk: DesktopBridge; computer: DesktopComputer }) {
  const { api } = useConnection();
  const handoff: PendingHandoff | undefined = c.handoffId
    ? { handoffId: c.handoffId, runId: c.held ? 'person' : 'chat', husk: c.held ? 'you' : 'chat', reason: c.waiting ?? '', computerId: c.id, createdAt: '' }
    : undefined;
  const hold = useHold(c.id, handoff, () => void desk.act({ type: 'refresh' }));
  const running = c.state === 'running';
  const { frame, note } = useScreenFeed(c.id, { enabled: running });
  const tabs = useResource<BrowserTab[]>((signal) => api.browserTabs(c.id, signal), [api, c.id], running, { refreshMs: 2000 });
  const [confirming, setConfirming] = useState(false);
  const status = statusOf(c);

  const action = c.held ? (
    <button type="button" className="cw-pill cw-pill-light" disabled={hold.busy} onClick={() => void hold.giveBack()}>
      Give back
    </button>
  ) : handoff ? (
    <button type="button" className="cw-pill cw-pill-warn" disabled={hold.busy} onClick={() => setConfirming(true)}>
      Done
    </button>
  ) : (
    <button type="button" className="cw-pill cw-pill-accent" disabled={hold.busy || !running} onClick={() => void hold.take()}>
      Take over
    </button>
  );

  return (
    <div className={`cw cw-${status}`}>
      <Bar desk={desk} title={c.label} computer={c}>
        {action}
      </Bar>

      {tabs.data && tabs.data.length > 0 ? (
        <nav className="cw-tabs" aria-label="Tabs on this computer">
          {tabs.data.map((t) => (
            <span
              key={t.targetId}
              className={`cw-tab${t.active ? ' cw-tab-on' : ''}${isBlank(t) ? ' cw-tab-blank' : ''}`}
              title={t.url}
              aria-current={t.active ? 'page' : undefined}
            >
              {tabName(t)}
            </span>
          ))}
        </nav>
      ) : null}

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

      <main className="cw-body">
        <Screen
          frame={running ? frame : null}
          alt={`The browser on ${c.label}, live`}
          note={running ? note : 'This computer is stopped. It starts again when its chat uses it.'}
          control={handoff ? hold.send : undefined}
          onTakeOver={running && !handoff ? () => void hold.take() : undefined}
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
        <span className="cw-doing" title={doing(c)}>
          {doing(c)}
        </span>
        {c.last ? <span className="cw-ago">{ago(c.last.at)}</span> : null}
      </footer>
      {hold.error ? (
        <div className="cw-error">
          <ErrorBlock error={hold.error} />
        </div>
      ) : null}
    </div>
  );
}

/** The title bar: it drags the window; its buttons do not. */
function Bar({ desk, title, computer, children }: { desk: DesktopBridge; title: string; computer?: DesktopComputer; children?: ReactNode }) {
  const mac = desk.platform === 'darwin';
  const win = (op: 'close' | 'minimize' | 'maximize' | 'pin') => void desk.act({ type: 'window', op });
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
      <div className="cw-title">
        {computer ? <AppGlyph computer={computer} size={16} /> : null}
        <span className="cw-name" title={title}>
          {title}
        </span>
      </div>
      <div className="cw-tools">
        {computer ? (
          <>
            <button
              type="button"
              className={`cw-icon${computer.pinned ? ' cw-icon-on' : ''}`}
              aria-pressed={computer.pinned}
              aria-label="Keep on top"
              title="Keep on top"
              onClick={() => win('pin')}
            >
              <Glyph d="M9 3h6l-1 5 3 3v2h-4v6l-1 2-1-2v-6H7v-2l3-3z" />
            </button>
            <button type="button" className="cw-icon" aria-label="Open in Husk" title="Open in Husk" onClick={() => void desk.act({ type: 'console', id: computer.id })}>
              <Glyph d="M14 4h6v6M20 4l-8 8M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
            </button>
          </>
        ) : null}
        {children}
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

function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const isBlank = (t: BrowserTab) => t.url === 'about:blank' || t.url === '';

/** A tab's name as a browser shows it: its title, else its host; a blank one is a new tab. */
function tabName(t: BrowserTab): string {
  if (isBlank(t)) return 'New tab';
  return t.title && t.title !== t.url ? t.title : hostOf(t.url);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
