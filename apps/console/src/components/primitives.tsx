/**
 * The small pieces every panel is built from.
 *
 * They exist so the three-state pattern and the error anatomy from
 * UI-PRINCIPLES §6 are written once and cannot drift between panels.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { DisplayError } from '../api/client';

// -----------------------------------------------------------------------------
// Button
// -----------------------------------------------------------------------------

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  /** The label never changes and the width never moves. UI-PRINCIPLES §4. */
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  const classes = ['btn', `btn-${variant}`, size !== 'md' ? `btn-${size}` : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

export type Tone = 'success' | 'warn' | 'danger' | 'info' | 'muted';

/** Dot plus word. The dot alone would make colour the only channel. */
export function StatusDot({ tone, label, pill = false }: { tone: Tone; label: string; pill?: boolean }) {
  return (
    <span className={pill ? 'status status-pill' : 'status'}>
      <span className={`dot${tone === 'muted' ? '' : ` dot-${tone}`}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge${tone === 'muted' ? '' : ` badge-${tone}`}`}>{children}</span>;
}

// -----------------------------------------------------------------------------
// Icons: a handful of 16px strokes, always beside a label or an aria-label
// -----------------------------------------------------------------------------

const ICONS = {
  terminal: 'M3 4.5 7 8l-4 3.5M8.5 12H13',
  files: 'M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z',
  browser: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM2.5 8h11M8 2.5c1.6 1.6 2.2 3.4 2.2 5.5S9.6 11.9 8 13.5C6.4 11.9 5.8 10.1 5.8 8S6.4 4.1 8 2.5',
  stop: 'M4.5 4.5h7v7h-7z',
  sun: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1',
  moon: 'M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z',
  hand: 'M5.5 8V3.8a1 1 0 0 1 2 0V7.5M7.5 7V3a1 1 0 0 1 2 0v4M9.5 7.2V4a1 1 0 0 1 2 0v5.5a4 4 0 0 1-4 4h-.6a4 4 0 0 1-3.2-1.6L2.4 9.9a1 1 0 0 1 1.5-1.3l1.6 1.4',
} as const;

export function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// Empty / loading / error
// -----------------------------------------------------------------------------

/**
 * "One line of what this is, one line of why it is empty, one command or one
 * button" — UI-PRINCIPLES §6. No illustration, no exclamation mark.
 */
export function EmptyState({
  title,
  body,
  command,
  action,
}: {
  title: string;
  body: string;
  command?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state">
      <h3>{title}</h3>
      <p>{body}</p>
      {command ? <CopyCommand command={command} /> : null}
      {action ? <div className="btn-row" style={{ marginTop: command ? 'var(--space-3)' : 0 }}>{action}</div> : null}
    </div>
  );
}

/** Things exist; your filter excluded them. A different message from empty. */
export function FilteredEmptyState({ what, onClear }: { what: string; onClear: () => void }) {
  return (
    <div className="state">
      <h3>No {what} match this filter.</h3>
      <p>They still exist — the filter is hiding them.</p>
      <Button onClick={onClear}>Clear the filter</Button>
    </div>
  );
}

export function Skeleton({ rows = 4, height = 40 }: { rows?: number; height?: number }) {
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: `${height}px` }} />
      ))}
    </div>
  );
}

/** Over ~2s, a skeleton stops being honest. Name what is being waited on. */
export function StatusLine({ text }: { text: string }) {
  return (
    <p className="status-line" role="status">
      {text}
    </p>
  );
}

/**
 * The error anatomy: code in mono, the human sentence at body size, the fix as
 * a command or a button, and the raw details behind a disclosure.
 */
export function ErrorBlock({
  error,
  retry,
  retryLabel = 'Try again',
}: {
  error: DisplayError;
  retry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="error-block" role="alert">
      <span className="code">{error.code}</span>
      <p className="message">{error.message}</p>
      {error.hint ? (
        <div className="fix">
          <CopyCommand command={error.hint} label="Copy hint" wrap />
        </div>
      ) : null}
      {retry ? (
        <div className="fix btn-row">
          <Button onClick={retry}>{retryLabel}</Button>
        </div>
      ) : null}
      {error.details ? (
        <details>
          <summary>Details</summary>
          <pre className="code" style={{ marginTop: 'var(--space-2)' }}>
            {error.details}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Copyable command
// -----------------------------------------------------------------------------

export function CopyCommand({
  command,
  label = 'Copy',
  wrap = false,
}: {
  command: string;
  label?: string;
  /** Hints are sentences, not commands: let them wrap instead of scroll. */
  wrap?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  }, [command]);

  return (
    <div className={wrap ? 'cmd cmd-wrap' : 'cmd'}>
      <code>{command}</code>
      <Button size="sm" variant="ghost" onClick={copy} aria-label={`${label}: ${command}`}>
        {copied ? 'Copied' : label}
      </Button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Panel scaffolding
// -----------------------------------------------------------------------------

export function PanelHeader({
  title,
  lede,
  actions,
}: {
  title: string;
  lede?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="panel-head">
      <div>
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {actions ? <div className="btn-row">{actions}</div> : null}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  note,
  children,
}: {
  label: string;
  htmlFor: string;
  /** `| undefined` on purpose: `exactOptionalPropertyTypes` is on, and callers
      legitimately pass a note that is only sometimes there. */
  note?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {note ? <span className="field-note">{note}</span> : null}
    </div>
  );
}

export function bytesToText(bytes: Uint8Array): { text: string; binary: boolean } {
  // A NUL in the first 8 KiB is the cheap, reliable "this is not text" signal.
  const probe = bytes.subarray(0, 8192);
  if (probe.includes(0)) return { text: '', binary: true };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), binary: false };
  } catch {
    return { text: '', binary: true };
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(1)} GiB`;
}

export function formatWhen(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
