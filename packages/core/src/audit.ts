import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { paths } from './config.js';
import { redact } from './util.js';

/**
 * What the computer was asked to do, and what happened.
 *
 * Agent runs have always persisted their events. The MCP path -- Claude Code or
 * Cursor calling `shell`, `write_file`, `browser_click` against a real machine
 * -- recorded nothing durable at all: one `log.info` to stderr at startup and
 * silence thereafter. That is the integration husk exists for, and it was the
 * one with no answer to "what did it actually do in there".
 *
 * The shape is deliberately small, because an audit log nobody can read is the
 * same as no audit log:
 *
 *   - one NDJSON line per tool call, appended, never rewritten
 *   - one file per computer, so a machine's whole history is `cat`-able
 *   - arguments summarised rather than stored whole; a 200 KB `write_file`
 *     body is not evidence, its path and size are
 *   - secrets passed through the same redactor as every other output, because
 *     the log is exactly where a leaked token would sit undisturbed for months
 *
 * Fire-and-forget by design: auditing must never fail the operation it is
 * describing, and a full disk should cost you the record, not the work.
 */

export interface AuditEntry {
  /** ISO 8601, when the call returned. */
  at: string;
  computerId: string;
  /** Where the call came in from: `mcp`, `api`, `cli`. */
  via: string;
  tool: string;
  /** Short, redacted summary of the arguments -- never the full payload. */
  args: string;
  ok: boolean;
  durationMs: number;
  /** First line of the failure, when there was one. */
  error?: string;
}

/** Keep a summary readable and bounded; the full payload is not the point. */
const MAX_ARG_CHARS = 300;

/**
 * A one-line description of a call's arguments.
 *
 * Values are truncated hard and the whole thing is redacted, so a token passed
 * as an argument does not get a permanent home in the log.
 */
export function summariseArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    let shown: string;
    if (typeof v === 'string') {
      // Long strings are a body, not an argument. Say how big instead.
      shown = v.length > 80 ? `<${v.length} chars>` : v;
    } else if (typeof v === 'object' && v !== null) {
      shown = Array.isArray(v) ? `<${v.length} items>` : '<object>';
    } else {
      shown = String(v);
    }
    parts.push(`${k}=${shown}`);
  }
  const joined = parts.join(' ');
  return redact(joined.length > MAX_ARG_CHARS ? `${joined.slice(0, MAX_ARG_CHARS)}…` : joined);
}

/** `~/.husk/audit/<computerId>.ndjson` -- one file per machine. */
export function auditPath(computerId: string): string {
  return join(paths().data, 'audit', `${computerId}.ndjson`);
}

/**
 * Append one entry. Never throws.
 *
 * The caller is on the response path of a tool the model is waiting for, so
 * this does not block it and cannot break it.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    const file = auditPath(entry.computerId);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // An audit log that can break the thing it audits is worse than none.
  }
}

/**
 * Time a call and record it, whatever the outcome.
 *
 * Wrapping rather than two call sites so a future tool cannot be added and
 * quietly skip the log -- which is how the MCP path came to have none.
 */
export async function audited<T>(
  meta: { computerId: string; via: string; tool: string; args: Record<string, unknown> },
  run: () => Promise<T>,
  failed?: (value: T) => string | undefined,
): Promise<T> {
  const started = Date.now();
  const base = {
    computerId: meta.computerId,
    via: meta.via,
    tool: meta.tool,
    args: summariseArgs(meta.args),
  };

  try {
    const value = await run();
    // A tool that reports failure in its result rather than by throwing --
    // which is how MCP tools signal errors -- must not be logged as a success.
    const why = failed?.(value);
    void recordAudit({ ...base, at: new Date().toISOString(), ok: !why, durationMs: Date.now() - started, ...(why ? { error: why } : {}) });
    return value;
  } catch (err) {
    void recordAudit({
      ...base,
      at: new Date().toISOString(),
      ok: false,
      durationMs: Date.now() - started,
      error: redact(String((err as Error).message ?? err).split('\n')[0] ?? ''),
    });
    throw err;
  }
}
