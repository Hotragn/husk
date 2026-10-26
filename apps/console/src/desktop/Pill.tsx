/**
 * The notch: where the Computers window goes when it is minimized. A black
 * capsule hanging from the top of the screen holds the logo of each computer
 * in the window. On a Mac with a notch it wraps the notch, logos left and
 * right of it; elsewhere it is the same shape, centred. A logo brings the
 * window back on that computer's tab; hover opens a short list of what each
 * is doing, with Open, and a way to put the window away altogether.
 *
 * The desktop app shows this window only while the Computers window is
 * minimized, and makes it click-through except while the pointer is on it.
 * It never takes the keyboard from a click: the app's shortcut hands it over,
 * opening the list on the first computer, and Escape gives it back.
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { AppGlyph } from './AppGlyph';
import { ago, arrive, desktopBridge, doing, statusOf, tabName, useDesktopState } from './bridge';
import type { DesktopComputer } from './bridge';

export function Pill() {
  const desk = desktopBridge();
  const state = useDesktopState();
  const pill = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const items = state?.computers ?? [];
  const notch = state?.notch;
  const away = state?.connected === false;
  useEffect(() => {
    const shut = () => setOpen(false);
    window.addEventListener('blur', shut);
    const off = arrive(pill, () => setOpen(true));
    return () => {
      off();
      window.removeEventListener('blur', shut);
    };
  }, []);
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
        <AppGlyph computer={c} size={20} husk />
        <span className={`pill-dot pill-dot-${statusOf(c)}`} aria-hidden="true" />
      </button>
    ));
  const half = Math.ceil(items.length / 2);
  const style = notch ? ({ '--notch-gap': `${notch.gap}px`, '--bar-h': `${notch.height}px` } as CSSProperties) : undefined;

  return (
    <div className="pill-stage">
      <div
        ref={pill}
        className={`pill${open ? ' pill-open' : ''}${notch ? ' pill-notch' : ''}`}
        style={style}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          setOpen(false);
          void desk.act({ type: 'release' });
        }}
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
          <>
            <ul className="pill-list" aria-label="Computers">
              {items.map((c) => (
                <li key={c.id} className={`pill-row pill-row-${statusOf(c)}`}>
                  <AppGlyph computer={c} size={26} husk />
                  <span className="pill-text">
                    <strong title={c.label}>{tabName(c, items)}</strong>
                    <span title={doing(c, away)}>
                      {doing(c, away)}
                      {c.last ? ` · ${ago(c.last.at)}` : ''}
                    </span>
                  </span>
                  <button type="button" className="pill-btn" aria-label={`Open ${tabName(c, items)}`} onClick={() => void desk.act({ type: 'open', id: c.id })}>
                    Open
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="pill-dismiss" onClick={() => void desk.act({ type: 'dismiss' })}>
              Put the window away
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
