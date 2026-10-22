/**
 * The notch: where a minimized computer window goes. A black capsule hanging
 * from the top of the screen holds the chat app logos of minimized computers.
 * On a Mac with a notch it wraps the notch, logos left and right of it;
 * elsewhere it is the same shape, centred. Hover opens it into a list: what
 * each computer is doing, a live thumbnail, Open and close.
 *
 * The desktop app shows this window only while something is minimized, and
 * makes it click-through except while the pointer is on the capsule.
 */

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useScreenFeed } from '../components/useScreenFeed';
import { AppGlyph } from './AppGlyph';
import { ago, desktopBridge, doing, statusOf, useDesktopState } from './bridge';
import type { DesktopComputer } from './bridge';

export function Pill() {
  const desk = desktopBridge();
  const state = useDesktopState();
  const [open, setOpen] = useState(false);
  const items = (state?.computers ?? []).filter((c) => c.window === 'minimized');
  const notch = state?.notch;
  if (!desk) return <p className="desk-note">Open this from the Husk app.</p>;

  const enter = () => {
    setOpen(true);
    void desk.act({ type: 'interactive', on: true });
  };
  const leave = () => {
    setOpen(false);
    void desk.act({ type: 'interactive', on: false });
  };
  const logos = (list: DesktopComputer[]) =>
    list.map((c) => (
      <button key={c.id} type="button" className="pill-logo" aria-label={`Open ${c.label}`} onClick={() => void desk.act({ type: 'open', id: c.id })}>
        <AppGlyph computer={c} size={18} />
        <span className={`pill-dot pill-dot-${statusOf(c)}`} aria-hidden="true" />
      </button>
    ));
  const half = Math.ceil(items.length / 2);
  const style = notch ? ({ '--notch-gap': `${notch.gap}px`, '--bar-h': `${notch.height}px` } as CSSProperties) : undefined;

  return (
    <div className="pill-stage">
      <div
        className={`pill${open ? ' pill-open' : ''}${notch ? ' pill-notch' : ''}`}
        style={style}
        onPointerEnter={enter}
        onPointerLeave={leave}
      >
        <div className="pill-bar">
          {notch ? (
            <>
              <span className="pill-side">{logos(items.slice(0, half))}</span>
              <span className="pill-gap" aria-hidden="true" />
              <span className="pill-side">{logos(items.slice(half))}</span>
            </>
          ) : (
            logos(items)
          )}
        </div>
        {open ? (
          <ul className="pill-list" aria-label="Minimized computers">
            {items.map((c) => (
              <Row key={c.id} computer={c} />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function Row({ computer: c }: { computer: DesktopComputer }) {
  const desk = desktopBridge();
  const { frame } = useScreenFeed(c.id, { fps: 1, enabled: c.live && c.state === 'running' });
  return (
    <li className={`pill-row pill-row-${statusOf(c)}`}>
      <span className="pill-thumb" aria-hidden="true">
        {frame ? <img src={frame.src} alt="" draggable={false} /> : <AppGlyph computer={c} size={22} />}
      </span>
      <span className="pill-text">
        <strong title={c.label}>{c.label}</strong>
        <span title={doing(c)}>
          {doing(c)}
          {c.last ? ` · ${ago(c.last.at)}` : ''}
        </span>
      </span>
      <button type="button" className="pill-btn" onClick={() => void desk?.act({ type: 'open', id: c.id })}>
        Open
      </button>
      <button type="button" className="pill-btn pill-btn-x" aria-label={`Close ${c.label}’s window`} onClick={() => void desk?.act({ type: 'close', id: c.id })}>
        ×
      </button>
    </li>
  );
}
