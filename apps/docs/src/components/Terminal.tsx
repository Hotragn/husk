import type { ReactNode } from 'react';

/**
 * A frame around real terminal output.
 *
 * Distinct from a code block on purpose: a code block is something you run, a
 * terminal frame is something a machine said. It is unhighlighted, has no copy
 * button, and turns off ligatures and kerning, because quoted machine speech
 * should not have `!=` fused into a glyph the machine never printed.
 *
 * Nothing in one of these is invented. If a transcript is here, it came from
 * running the command.
 */
export function Terminal({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="terminal">
      {title ? <div className="terminal-bar">{title}</div> : null}
      <pre tabIndex={0}>{children}</pre>
    </div>
  );
}
