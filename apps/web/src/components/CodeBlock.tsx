import { CopyButton } from "@/components/CopyButton";
import { highlightYaml } from "@/lib/highlight-yaml";

/**
 * A file, shown as a file. Selectable, searchable, diffable text — not a
 * screenshot of text (UI-PRINCIPLES.md §8.4).
 */
export function CodeBlock({
  title,
  source,
  what = "file",
}: {
  title: string;
  source: string;
  what?: string;
}) {
  return (
    <div className="frame">
      <div className="frame-bar">
        <span className="frame-title">{title}</span>
        <span className="frame-actions">
          <CopyButton value={source} what={what} />
        </span>
      </div>
      <pre className="code" tabIndex={0} role="group" aria-label={title}>
        <code>{highlightYaml(source)}</code>
      </pre>
    </div>
  );
}

/**
 * One command, with the sigil kept out of the copied string. Nobody wants a
 * leading `$` in their shell.
 */
export function CommandBlock({
  command,
  size = "md",
  what = "command",
}: {
  command: string;
  size?: "md" | "lg";
  what?: string;
}) {
  return (
    <div className={`cmd${size === "lg" ? " cmd-lg" : ""}`}>
      <code className="cmd-text">
        <span className="cmd-sigil" aria-hidden="true">
          ${" "}
        </span>
        {command}
      </code>
      <CopyButton value={command} what={what} />
    </div>
  );
}
