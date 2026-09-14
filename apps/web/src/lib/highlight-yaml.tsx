import type { ReactNode } from "react";

/**
 * A small YAML highlighter. Four token classes, all of them bound to audited
 * tokens: keys are husk gold, literals are core teal, punctuation and comments
 * are subtle text, everything else is body text. No dependency, no theme file,
 * no colour that is not already in the palette.
 *
 * It understands block scalars (`persona: |`), because a husk.yaml is mostly
 * block scalars and highlighting prose as if it were YAML looks broken.
 */

const KEY = /^(\s*(?:-\s+)?)([A-Za-z_][\w.\-/]*)(:)(?=\s|$)/;
const SCAN =
  /('(?:[^']|'')*'|"(?:\\.|[^"\\])*")|(\btrue\b|\bfalse\b|\bnull\b|\b\d+(?:\.\d+)?\b)|([[\]{},:|>]+)|(#.*)$|(\s+)|([^\s#'"[\]{},:]+)/g;

function scan(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let m: RegExpExecArray | null;
  SCAN.lastIndex = 0;
  let i = 0;
  while ((m = SCAN.exec(text)) !== null) {
    const k = `${keyPrefix}-${i++}`;
    if (m[1]) out.push(<span key={k} className="tok-string">{m[1]}</span>);
    else if (m[2]) out.push(<span key={k} className="tok-literal">{m[2]}</span>);
    else if (m[3]) out.push(<span key={k} className="tok-punct">{m[3]}</span>);
    else if (m[4]) out.push(<span key={k} className="tok-comment">{m[4]}</span>);
    else out.push(m[0]);
    if (m.index === SCAN.lastIndex) SCAN.lastIndex++;
  }
  return out;
}

export function highlightYaml(source: string): ReactNode[] {
  const lines = source.replace(/\n$/, "").split("\n");
  const nodes: ReactNode[] = [];
  let blockIndent: number | null = null;

  lines.forEach((line, index) => {
    const key = `l${index}`;
    const indent = line.length - line.trimStart().length;

    // Inside a block scalar: plain text until the indentation drops back.
    if (blockIndent !== null) {
      if (line.trim() === "" || indent > blockIndent) {
        nodes.push(<span key={key}>{line}{"\n"}</span>);
        return;
      }
      blockIndent = null;
    }

    if (line.trim().startsWith("#")) {
      nodes.push(
        <span key={key} className="tok-comment">
          {line}
          {"\n"}
        </span>,
      );
      return;
    }

    const km = KEY.exec(line);
    if (km) {
      const rest = line.slice(km[0].length);
      if (/^\s*[|>][-+]?\s*$/.test(rest)) blockIndent = indent;
      nodes.push(
        <span key={key}>
          {km[1]}
          <span className="tok-key">{km[2]}</span>
          <span className="tok-punct">{km[3]}</span>
          {scan(rest, key)}
          {"\n"}
        </span>,
      );
      return;
    }

    nodes.push(
      <span key={key}>
        {scan(line, key)}
        {"\n"}
      </span>,
    );
  });

  return nodes;
}
