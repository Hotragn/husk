"use client";

/**
 * Which client are you in, and what do you paste.
 *
 * One component, used twice — the hero and the `#mcp` section show the same
 * fact, so they update together rather than one getting fixed and the other
 * going stale. That was the actual bug: both hardcoded Claude Code's command
 * and the copy underneath said the server "speaks streamable HTTP, so Cursor,
 * Zed and anything else that talks MCP get the same thing" without ever saying
 * what those readers were supposed to type.
 *
 * It is a segmented control, per section 4 of UI-PRINCIPLES — a roving
 * tabindex, arrow keys move between pills, Home and End jump to the ends, and
 * the selected pill is the only one in the tab order. `role="tablist"` with
 * real `tabpanel`s, so a screen reader is told this is one thing with several
 * views rather than six unrelated blocks.
 *
 * Restrained on purpose. This is a functional control, not the page's set
 * piece; it gets the same pill treatment the rest of the site's controls get
 * and no entrance of its own.
 *
 * Every command and path in `lib/mcp-clients.ts` was read off that client's
 * own documentation. See the header there for the three that would have been
 * wrong by pattern-matching.
 */

import { useCallback, useId, useRef, useState } from "react";

import { CopyButton } from "@/components/CopyButton";
import { DEFAULT_CLIENT, MCP_CLIENTS } from "@/lib/mcp-clients";

export function InstallSelector({
  size = "md",
  idPrefix,
}: {
  size?: "md" | "lg";
  /** Two instances live on one page, so the ids cannot be shared. */
  idPrefix?: string;
}) {
  const auto = useId();
  const base = idPrefix ?? auto;
  const [active, setActive] = useState(DEFAULT_CLIENT);
  const pills = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const i = MCP_CLIENTS.findIndex((c) => c.id === active);
      let next = -1;
      if (e.key === "ArrowRight") next = (i + 1) % MCP_CLIENTS.length;
      else if (e.key === "ArrowLeft") next = (i - 1 + MCP_CLIENTS.length) % MCP_CLIENTS.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = MCP_CLIENTS.length - 1;
      if (next === -1) return;
      e.preventDefault();
      setActive(MCP_CLIENTS[next].id);
      pills.current[next]?.focus();
    },
    [active],
  );

  const client = MCP_CLIENTS.find((c) => c.id === active) ?? MCP_CLIENTS[0];
  const panelId = `${base}-panel-${client.id}`;

  return (
    <div className={`installer${size === "lg" ? " installer-lg" : ""}`}>
      <div
        className="installer-pills"
        role="tablist"
        aria-label="Choose your MCP client"
        onKeyDown={onKeyDown}
      >
        {MCP_CLIENTS.map((c, i) => {
          const selected = c.id === client.id;
          return (
            <button
              key={c.id}
              ref={(el) => {
                pills.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${c.id}`}
              aria-selected={selected}
              aria-controls={selected ? panelId : undefined}
              tabIndex={selected ? 0 : -1}
              className="installer-pill"
              onClick={() => setActive(c.id)}
            >
              {c.name}
            </button>
          );
        })}
      </div>

      <div
        className="installer-panel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${base}-tab-${client.id}`}
        tabIndex={0}
      >
        {client.panel.kind === "cli" ? (
          <div className={`cmd${size === "lg" ? " cmd-lg" : ""}`}>
            <code className="cmd-text">
              <span className="cmd-sigil" aria-hidden="true">${" "}</span>
              {client.panel.command}
            </code>
            <CopyButton value={client.panel.command} what="command" />
          </div>
        ) : null}

        {client.panel.kind === "config" ? (
          <>
            <div className="installer-where">
              <p className="installer-path">
                Paste this into <code className="inline">{client.panel.path}</code>
                {client.panel.altPath ? (
                  <>
                    {" "}
                    &mdash; or <code className="inline">{client.panel.altPath}</code>{" "}
                    {client.panel.altScope}
                  </>
                ) : null}
                .
              </p>
              {client.panel.deeplink ? (
                <a className="btn btn-secondary" href={client.panel.deeplink}>
                  Add to Cursor
                </a>
              ) : null}
            </div>
            <div className="frame">
              <div className="frame-bar">
                <span className="frame-title">{client.name}</span>
                <span className="frame-actions">
                  <CopyButton value={client.panel.snippet} what="config" />
                </span>
              </div>
              <pre className="code" tabIndex={0} role="group" aria-label={`${client.name} config`}>
                <code>{client.panel.snippet}</code>
              </pre>
            </div>
          </>
        ) : null}

        {client.panel.kind === "link" ? (
          <p className="installer-path">
            <a href={client.panel.href} rel="noreferrer noopener">
              The README
            </a>{" "}
            has the stdio command and the flags, for clients without a panel here.
          </p>
        ) : null}

        <p className="installer-note">{client.note}</p>
      </div>
    </div>
  );
}

export default InstallSelector;
