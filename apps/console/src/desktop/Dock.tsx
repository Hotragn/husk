/**
 * The corner of the screen: one very small 3D computer for each computer a
 * chat is using, on a small frosted tray. Minimal on purpose, so it never
 * pulls the eye: white screens, no moving picture, a soft glow only when a
 * chat waits for the person or the person holds it. Hover shows a tiny label
 * with the chat app's name; a click opens the Computers window on that tab.
 *
 * The 3D is drawn by dock3d.ts on one canvas; the buttons here sit over it on
 * the same grid, so the row is keyboard- and screen-reader-usable and the
 * label is plain DOM. The desktop app makes this window click-through except
 * while the pointer is over a computer (`interactive`). Without WebGL the same
 * buttons draw flat computers instead. The window never takes the keyboard
 * from a click: the app's shortcut hands it over, on the first computer, and
 * Escape gives it back.
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { arrive, desktopBridge, doing, statusOf, useDesktopState } from './bridge';
import type { DesktopComputer } from './bridge';
import type { DockStage } from './dock3d';
import { TINTS, tintOf } from './tints';
import type { TintName } from './tints';

export function Dock() {
  const desk = desktopBridge();
  const state = useDesktopState();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const row = useRef<HTMLUListElement | null>(null);
  const [stage, setStage] = useState<DockStage | null>(null);
  const [flat, setFlat] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const list = state?.computers ?? [];
  const items = list.map((c) => ({ id: c.id, status: statusOf(c), tint: tintOf(c.platform, c.id) }));
  const itemsKey = items.map((i) => `${i.id}:${i.status}:${i.tint}`).join(',');

  useEffect(() => {
    let alive = true;
    let made: DockStage | null = null;
    import('./dock3d').then(
      ({ createDockStage }) => {
        if (!alive || !canvas.current) return;
        try {
          made = createDockStage(canvas.current);
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

  useEffect(() => arrive(row), []);

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
      {list.length > 0 ? <span className="dock-tray" aria-hidden="true" style={{ width: list.length * 44 - 4 }} /> : null}
      <canvas ref={canvas} className="dock-canvas" aria-hidden="true" hidden={flat} />
      <ul
        ref={row}
        className="dock-row"
        aria-label="Computers"
        onKeyDown={(e) => {
          if (e.key === 'Escape') void desk.act({ type: 'release' });
        }}
      >
        {list.map((c) => (
          <Slot
            key={c.id}
            computer={c}
            away={state?.connected === false}
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
  away,
  flat,
  hovered,
  onEnter,
  onLeave,
  onClick,
}: {
  computer: DesktopComputer;
  away: boolean;
  flat: boolean;
  hovered: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onClick: () => void;
}) {
  const status = statusOf(c);
  const tip = `tip-${c.id}`;
  return (
    <li className={`dock-slot dock-${status}`}>
      {hovered ? (
        <span className="dock-tip" role="tooltip" id={tip}>
          {c.platform ?? c.label}
        </span>
      ) : null}
      <button
        type="button"
        className="dock-hit"
        aria-label={`${c.label}: ${doing(c, away)}. Open it`}
        aria-describedby={hovered ? tip : undefined}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
        onClick={onClick}
      >
        {flat ? <FlatComputer tint={tintOf(c.platform, c.id)} /> : null}
      </button>
    </li>
  );
}

/** The same small iMac, facing front with a white screen, drawn in CSS where WebGL is not available. */
function FlatComputer({ tint }: { tint: TintName }) {
  const colours = { '--mac-back': TINTS[tint].back, '--mac-chin': TINTS[tint].chin } as CSSProperties;
  return (
    <span className="flat-mac" aria-hidden="true" style={colours}>
      <span className="flat-mac-display">
        <span className="flat-mac-screen" />
        <span className="flat-mac-chin" />
      </span>
      <span className="flat-mac-neck" />
      <span className="flat-mac-foot" />
    </span>
  );
}
