"use client";

/**
 * The five providers, arranged around the object they describe.
 *
 * This replaces the row of five buttons under the isolation viewer. It is the
 * same control doing the same job — pick a provider, the shell above shows how
 * contained that provider leaves you — re-laid as a radial, with the core in
 * the middle and a spoke out to each node.
 *
 * No numbers on the nodes. docker, podman, local, ssh and fly are five
 * parallel options, not five steps, and numbering a set implies an order that
 * does not exist. `husk doctor` picks one; the reader is not walking through
 * them.
 *
 * Quiet on purpose. The hero is the page's set piece and this is not competing
 * with it: the nodes are still, the spokes are hairlines, and the only thing
 * that moves on its own is one faint ring with nothing on it — see the note on
 * the drift in globals.css for why the nodes themselves do not orbit.
 *
 * Keyboard and pointer reach the same states. Hover and focus both preview a
 * provider, which is what the brief for this asked for, and click commits —
 * so a reader tabbing through gets the identical readout a reader with a mouse
 * gets, rather than a hover-only affordance.
 */

import type { Provider } from "@/lib/content";

/** Evenly spaced, first node at twelve o'clock. */
function angleFor(index: number, count: number): number {
  return -90 + (360 / count) * index;
}

function polar(angleDeg: number, radius: number): { x: number; y: number } {
  const r = (angleDeg * Math.PI) / 180;
  return { x: 50 + Math.cos(r) * radius, y: 50 + Math.sin(r) * radius };
}

/** Percent of the box, so the whole thing scales with its container. */
const SPOKE_INNER = 21;
const SPOKE_OUTER = 35.5;
const NODE_RADIUS = 41;

export function ProviderOrbit({
  providers,
  activeId,
  onSelect,
  children,
}: {
  providers: Provider[];
  activeId: string;
  onSelect: (id: string) => void;
  /** The core stage. It sits in the middle of the ring. */
  children: React.ReactNode;
}) {
  return (
    <div className="orbit">
      {/* Spokes and rings, behind everything and announced to nobody: every
          relationship they draw is also in the DOM as a button and a table. */}
      <svg className="orbit-lines" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle className="orbit-ring" cx="50" cy="50" r={SPOKE_OUTER} />
        <circle className="orbit-ring orbit-ring-drift" cx="50" cy="50" r={NODE_RADIUS} />
        {providers.map((p, i) => {
          const a = angleFor(i, providers.length);
          const from = polar(a, SPOKE_INNER);
          const to = polar(a, SPOKE_OUTER);
          return (
            <line
              key={p.id}
              className="orbit-spoke"
              data-active={p.id === activeId ? "true" : undefined}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
            />
          );
        })}
      </svg>

      <div className="orbit-core">{children}</div>

      <div className="orbit-nodes" role="group" aria-label="Choose a computer provider">
        {providers.map((p, i) => {
          const a = angleFor(i, providers.length);
          const at = polar(a, NODE_RADIUS);
          return (
            <button
              key={p.id}
              type="button"
              className="orbit-node"
              aria-pressed={p.id === activeId}
              style={{ left: `${at.x}%`, top: `${at.y}%` }}
              onClick={() => onSelect(p.id)}
              onMouseEnter={() => onSelect(p.id)}
              onFocus={() => onSelect(p.id)}
            >
              <span className="orbit-node-dot" aria-hidden="true" />
              {p.id}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ProviderOrbit;
