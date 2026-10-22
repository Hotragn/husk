/**
 * The corner of the screen: one small 3D computer per computer a chat is
 * using. Hover one to see which chat it belongs to and what it is doing;
 * click it to show or hide its window.
 *
 * The 3D is drawn by dock3d.ts on one canvas; the buttons here sit over it on
 * the same grid, so the row is keyboard- and screen-reader-usable and the
 * hover tooltip is plain DOM. The desktop app makes this window click-through
 * except while the pointer is over a computer (`interactive`). Without WebGL
 * the same buttons draw flat computers instead.
 */

import { useEffect, useRef, useState } from 'react';
import { useScreenFeed } from '../components/useScreenFeed';
import { AppGlyph } from './AppGlyph';
import { ago, desktopBridge, doing, statusOf, useDesktopState } from './bridge';
import type { DesktopComputer } from './bridge';
import type { DockStage } from './dock3d';

/** Which computers stand in the row: running ones, and any whose window is still around. */
export function docked(list: DesktopComputer[]): DesktopComputer[] {
  return list.filter((c) => c.state === 'running' || c.window !== 'closed');
}

export function Dock() {
  const desk = desktopBridge();
  const state = useDesktopState();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [stage, setStage] = useState<DockStage | null>(null);
  const [flat, setFlat] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const list = docked(state?.computers ?? []);
  const items = list.map((c) => ({ id: c.id, status: statusOf(c) }));
  const itemsKey = items.map((i) => `${i.id}:${i.status}`).join(',');

  useEffect(() => {
    let alive = true;
    let made: DockStage | null = null;
    import('./dock3d').then(
      ({ createDockStage }) => {
        if (!alive || !canvas.current) return;
        try {
          made = createDockStage(canvas.current, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
          setStage(made);
        } catch {
          setFlat(true);
        }
      },
      () => {
        if (alive) setFlat(true);
      },
    );
    return () => {
      alive = false;
      made?.dispose();
    };
  }, []);

  useEffect(() => {
    stage?.setItems(items);
    // itemsKey is `items` as a value: the list is a new array on every push.
  }, [stage, itemsKey]);

  const enter = (id: string) => {
    setHover(id);
    stage?.hover(id);
    void desk?.act({ type: 'interactive', on: true });
  };
  const leave = () => {
    setHover(null);
    stage?.hover(null);
    void desk?.act({ type: 'interactive', on: false });
  };

  if (!desk) return <p className="desk-note">Open this from the Husk app.</p>;
  return (
    <div className={`dock${flat ? ' dock-flat' : ''}`}>
      <canvas ref={canvas} className="dock-canvas" aria-hidden="true" hidden={flat} />
      <ul className="dock-row" aria-label="Computers">
        {list.map((c) => (
          <Slot
            key={c.id}
            computer={c}
            stage={stage}
            flat={flat}
            hovered={hover === c.id}
            onEnter={() => enter(c.id)}
            onLeave={leave}
            onClick={() => void desk.act({ type: 'toggle', id: c.id })}
          />
        ))}
      </ul>
    </div>
  );
}

function Slot({
  computer: c,
  stage,
  flat,
  hovered,
  onEnter,
  onLeave,
  onClick,
}: {
  computer: DesktopComputer;
  stage: DockStage | null;
  flat: boolean;
  hovered: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onClick: () => void;
}) {
  const { frame } = useScreenFeed(c.id, { fps: 1, enabled: c.live && c.state === 'running' });
  useEffect(() => {
    if (frame) stage?.setFrame(c.id, frame.src);
  }, [stage, c.id, frame]);
  const status = statusOf(c);
  const tip = `tip-${c.id}`;
  return (
    <li className={`dock-slot dock-${status}`}>
      {hovered ? (
        <div className="dock-tip" role="tooltip" id={tip}>
          <span className="dock-tip-head">
            <AppGlyph computer={c} size={16} />
            <strong>{c.label}</strong>
          </span>
          <span className="dock-tip-doing">
            {doing(c)}
            {c.last ? ` · ${ago(c.last.at)}` : ''}
          </span>
        </div>
      ) : null}
      <button
        type="button"
        className="dock-hit"
        aria-label={`${c.label}: ${doing(c)}. ${c.window === 'open' ? 'Hide' : 'Show'} its window`}
        aria-describedby={hovered ? tip : undefined}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
        onClick={onClick}
      >
        {flat ? <FlatComputer src={frame?.src} /> : null}
      </button>
      <span className="dock-app" aria-hidden="true">
        <AppGlyph computer={c} size={14} />
      </span>
    </li>
  );
}

/** A computer drawn in CSS, for where WebGL is not available. */
function FlatComputer({ src }: { src: string | undefined }) {
  return (
    <span className="flat-mac" aria-hidden="true">
      <span className="flat-mac-display">
        <span className="flat-mac-screen">{src ? <img src={src} alt="" draggable={false} /> : null}</span>
      </span>
      <span className="flat-mac-neck" />
      <span className="flat-mac-foot" />
    </span>
  );
}
