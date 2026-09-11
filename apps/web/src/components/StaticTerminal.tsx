import { CopyButton } from "@/components/CopyButton";
import type { LineKind, TermLine } from "@/lib/content";

const CLASS_FOR: Record<LineKind, string> = {
  prompt: "term-prompt",
  out: "term-out",
  dim: "term-dim",
  ok: "term-ok",
  err: "term-err",
  key: "term-key",
  blank: "term-out",
};

/** `$ command      # trailing note` — the note is quieter than the command. */
function renderLine(line: TermLine, i: number) {
  if (line.kind === "prompt") {
    const at = line.text.search(/ {2,}#/);
    if (at > -1) {
      return (
        <span key={i} className="term-line term-prompt">
          {line.text.slice(0, at)}
          <span className="term-dim">{line.text.slice(at)}</span>
          {"\n"}
        </span>
      );
    }
  }
  return (
    <span key={i} className={`term-line ${CLASS_FOR[line.kind]}`}>
      {line.text}
      {"\n"}
    </span>
  );
}

/**
 * Terminal output as text, not as a screenshot: selectable, searchable,
 * copyable, and it does not go stale as a 2x PNG (UI-PRINCIPLES.md §8.4).
 */
export function StaticTerminal({
  title,
  lines,
  label,
}: {
  title: string;
  lines: TermLine[];
  label: string;
}) {
  const text = lines.map((l) => l.text).join("\n");
  return (
    <div className="frame">
      <div className="frame-bar">
        <span className="frame-title">{title}</span>
        <span className="frame-actions">
          <CopyButton value={text} what="output" />
        </span>
      </div>
      <pre className="term" tabIndex={0} role="group" aria-label={label}>
        {lines.map(renderLine)}
      </pre>
    </div>
  );
}
