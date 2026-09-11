/**
 * The browser: `POST /v1/computers/:id/browse`.
 *
 * What this is, so the panel does not lie about it: there is no browser engine
 * anywhere in this stack. The server writes a small python script into the
 * computer, runs it there, and the script fetches the URL, strips the markup
 * and prints the text plus the first 300 links as JSON. No scripts run, no CSS
 * is applied, no subresource is fetched. `packages/core/src/browse.ts` says why
 * it works that way rather than with a host `fetch()`: the console has to show
 * the page the *agent* would get — same IP, same DNS, same egress — or the two
 * are looking at different machines.
 *
 * So the reader view below is extracted text, and it says so on screen rather
 * than leaving a user to work out why example.com has no serif heading.
 *
 * The refusal path is the interesting one. An `egress` policy with an allow
 * list is the normal way to run a computer, so `E_EXEC_DENIED` is not a bug —
 * it is the policy working. It gets the server's own message and hint verbatim,
 * plus the machine's declared policy read back off `ComputerInfo.spec.network`
 * and the yaml that would change it. The console does not re-derive the
 * decision: `assertUrlAllowed` in `@husk/core` owns that, and duplicating it
 * here would be a second contract.
 *
 * There is no iframe and no `dangerouslySetInnerHTML`. Everything below renders
 * through React's text nodes, because every byte of it came off a page the
 * machine was pointed at and none of it is trusted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection } from '../state/connection';
import { isAbort, toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import type { BrowsePage, ComputerInfo } from '../api/wire';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBlock,
  PanelHeader,
  Skeleton,
  StatusDot,
  StatusLine,
  formatBytes,
} from '../components/primitives';
import type { Tone } from '../components/primitives';

// The same two thresholds `useResource` uses, for the same reason: a loading
// state that flashes for 200ms reads as a glitch, and a skeleton that sits
// there for four seconds stops being honest. UI-PRINCIPLES §6.
const SKELETON_AFTER_MS = 400;
const STATUS_LINE_AFTER_MS = 2000;

/** Enough links to scan. The fetcher caps at 300; the rest are one click away. */
const LINKS_SHOWN = 60;

/**
 * `example.com` is what a person types; `https://example.com` is what the route
 * needs. Anything that already carries a scheme is left exactly as typed —
 * including `http://`, because a user asking for cleartext usually means it.
 */
function normalise(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** The hostname, for the refusal explanation. Null when the URL will not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * The blank line is the only paragraph signal the fetcher leaves: it turns
 * `</p>`, `</div>`, `</li>`, `</h1..6>` and `<br>` into newlines and then
 * collapses runs of three or more. Splitting on it is what makes the text a
 * readable measure instead of one 200 KB block.
 */
function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter((p) => p !== '');
}

/** An HTTP status is information; the word next to the dot carries it. */
function statusTone(status: number): Tone {
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'info';
  if (status >= 400 && status < 500) return 'warn';
  if (status >= 500) return 'danger';
  return 'muted';
}

interface History {
  /** Requested URLs, oldest first. */
  entries: string[];
  /** -1 before anything has been loaded. */
  index: number;
}

const NO_HISTORY: History = { entries: [], index: -1 };

export function BrowserPanel({
  computers,
  activeId,
  onSelect,
}: {
  computers: ComputerInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const { api } = useConnection();
  const active = computers.find((c) => c.id === activeId) ?? null;

  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<History>(NO_HISTORY);
  const [page, setPage] = useState<BrowsePage | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [slow, setSlow] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [allLinks, setAllLinks] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // A history stack belongs to a machine. Switching machines is a new session,
  // not a continuation of the old one — the allow-list is different too.
  useEffect(() => {
    setDraft('');
    setHistory(NO_HISTORY);
    setPage(null);
    setError(null);
    setCancelled(false);
    setNotice(null);
    setAllLinks(false);
  }, [active?.id]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const load = useCallback(
    async (url: string) => {
      if (!activeId) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setError(null);
      setCancelled(false);
      setNotice(null);
      setAllLinks(false);
      setLoading(true);
      setShowSkeleton(false);
      setSlow(false);

      const skeletonTimer = setTimeout(() => setShowSkeleton(true), SKELETON_AFTER_MS);
      const slowTimer = setTimeout(() => setSlow(true), STATUS_LINE_AFTER_MS);

      try {
        const next = await api.browse(activeId, { url }, controller.signal);
        if (controller.signal.aborted) return;
        setPage(next);
        setNotice(
          `Loaded ${next.title || next.url} — HTTP ${next.status}, ${next.links.length} link${
            next.links.length === 1 ? '' : 's'
          }, ${next.elapsedMs} ms.`,
        );
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return;
        // Error and page are mutually exclusive, the same way `useResource`
        // drops its data on failure: leaving the last page on screen under a
        // status line describing a different URL is a worse lie than a blank.
        setPage(null);
        setError(toDisplayError(err));
      } finally {
        clearTimeout(skeletonTimer);
        clearTimeout(slowTimer);
        if (!controller.signal.aborted) {
          setLoading(false);
          setShowSkeleton(false);
          setSlow(false);
        }
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [api, activeId],
  );

  /** A new destination: truncate anything ahead of the cursor, then push. */
  const navigate = useCallback(
    (raw: string) => {
      const url = normalise(raw);
      if (url === null) return;
      setDraft(url);
      setHistory((h) => ({ entries: [...h.entries.slice(0, h.index + 1), url], index: h.index + 1 }));
      void load(url);
    },
    [load],
  );

  /** Back and forward move the cursor. Neither one rewrites the stack. */
  const step = useCallback(
    (delta: -1 | 1) => {
      const next = history.index + delta;
      const url = history.entries[next];
      if (url === undefined) return;
      setHistory({ entries: history.entries, index: next });
      setDraft(url);
      void load(url);
    },
    [history, load],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setShowSkeleton(false);
    setSlow(false);
    setCancelled(true);
  }, []);

  const current = history.index >= 0 ? (history.entries[history.index] ?? null) : null;
  const canBack = history.index > 0;
  const canForward = history.index >= 0 && history.index < history.entries.length - 1;

  if (computers.length === 0) {
    return (
      <section className="panel">
        <PanelHeader title="Browser" lede="POST /v1/computers/:id/browse" />
        <EmptyState
          title="No computer to browse from."
          body="The fetch happens inside a machine, on that machine's network — so there has to be a machine first. Create one on the Computers panel."
          command={'husk run "echo hello"'}
        />
      </section>
    );
  }

  const links = page?.links ?? [];
  const shown = allLinks ? links : links.slice(0, LINKS_SHOWN);
  const body = page ? paragraphs(page.text) : [];
  const policy = active?.spec.network;
  const deniedHost = error?.code === 'E_EXEC_DENIED' && current ? hostOf(current) : null;

  return (
    <section className="panel" aria-labelledby="browser-title">
      <PanelHeader
        title="Browser"
        lede="A page fetched from inside the machine and shown as extracted text. There is no browser engine here, and no iframe."
        actions={
          <>
            <label className="visually-hidden" htmlFor="browse-computer">
              Computer
            </label>
            <select
              id="browse-computer"
              className="select"
              style={{ width: 'auto' }}
              value={activeId ?? ''}
              onChange={(e) => onSelect(e.target.value)}
            >
              {computers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id} · {c.provider} · {c.state}
                </option>
              ))}
            </select>
          </>
        }
      />
      <span id="browser-title" className="visually-hidden">
        Browser
      </span>

      {active && active.state !== 'running' ? (
        <div className="card warn-card" role="note" style={{ marginBottom: 'var(--space-4)' }}>
          <p>
            <strong>
              {active.id} is {active.state}.
            </strong>{' '}
            The fetch runs as a command inside it, so every load will fail until it is started again.
          </p>
        </div>
      ) : null}

      <form
        className="inline-gap"
        style={{ marginBottom: 'var(--space-4)' }}
        onSubmit={(e) => {
          e.preventDefault();
          navigate(draft);
        }}
      >
        <Button onClick={() => step(-1)} disabled={!canBack} aria-label="Back one page">
          Back
        </Button>
        <Button onClick={() => step(1)} disabled={!canForward} aria-label="Forward one page">
          Forward
        </Button>
        <label htmlFor="browse-url" className="field-label">
          URL
        </label>
        <input
          id="browse-url"
          className="input mono"
          style={{ maxWidth: '32rem' }}
          type="text"
          inputMode="url"
          placeholder="example.com"
          aria-describedby="browse-url-note"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <Button type="submit" variant="primary" disabled={normalise(draft) === null}>
          Load
        </Button>
        {loading ? (
          <Button variant="ghost" onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button
            variant="ghost"
            onClick={() => {
              if (current !== null) void load(current);
            }}
            disabled={current === null}
          >
            Reload
          </Button>
        )}
      </form>
      <p className="field-note" id="browse-url-note">
        A bare host gets <code>https://</code> in front of it. Type the scheme yourself to override that.
      </p>

      {/* §6, with one deliberate reading of it. A skeleton is for content that
          is not on screen yet — it holds the shape so nothing reflows on
          arrival. When a page is already rendered, a skeleton stacked above it
          says less than a line naming the URL being fetched, so the status line
          takes over at 400ms rather than waiting for the 2s threshold. */}
      {loading && (slow || (showSkeleton && page !== null)) ? (
        <StatusLine text={`Fetching ${current ?? draft} from inside ${activeId ?? ''}…`} />
      ) : null}
      {loading && showSkeleton && !slow && page === null ? <Skeleton rows={6} height={24} /> : null}

      {cancelled ? (
        <p className="hint" role="status">
          Load cancelled, so nothing new was rendered. Anything below is still the previous page and still carries its
          own URL; the URL bar holds the one you cancelled, and <strong>Reload</strong> retries it. The request was
          aborted here rather than on the machine, so the command may still be finishing there.
        </p>
      ) : null}

      <p className="visually-hidden" role="status">
        {notice ?? ''}
      </p>

      {error ? (
        <div className="row-gap-4">
          {/* `exactOptionalPropertyTypes`: an absent retry is not `retry: undefined`. */}
          <ErrorBlock
            error={error}
            {...(current !== null ? { retry: () => void load(current) } : {})}
            retryLabel="Load again"
          />
          {error.code === 'E_EXEC_DENIED' ? (
            <div className="card">
              <h3>This is the network policy, not a failure.</h3>
              <p className="hint" style={{ marginTop: 'var(--space-2)' }}>
                {policy ? (
                  <>
                    {active?.id} was created with <code>network.mode: {policy.mode}</code>
                    {policy.allow && policy.allow.length > 0 ? (
                      <>
                        {' '}
                        and an allow list of <code>{policy.allow.join(', ')}</code>
                      </>
                    ) : (
                      <> and no allow list, which under <code>egress</code> permits nothing</>
                    )}
                    {policy.deny && policy.deny.length > 0 ? (
                      <>
                        , denying <code>{policy.deny.join(', ')}</code>
                      </>
                    ) : null}
                    . The host {deniedHost ? <code>{deniedHost}</code> : 'in that URL'} did not get through it.
                  </>
                ) : (
                  <>
                    {active?.id} declares no <code>network</code> block, so only the built-in refusals apply: loopback,
                    link-local and the RFC1918 ranges.
                  </>
                )}
              </p>
              <p className="hint">The fix is in the husk that owns this computer, not in the console:</p>
              {/* Quoted, the way `examples/sprout.yaml` writes them. A bare
                  `*.example.com` is not valid YAML — `*` opens an alias — and a
                  fix snippet that does not parse is worse than no snippet. */}
              <pre className="code" style={{ marginTop: 'var(--space-2)' }}>
                {[
                  'computer:',
                  '  network:',
                  `    mode: ${policy?.mode ?? 'egress'}`,
                  '    allow:',
                  ...(policy?.allow ?? []).map((h) => `      - '${h}'`),
                  `      - '${deniedHost ?? '<host>'}'`,
                ].join('\n')}
              </pre>
              <p className="hint">
                Two of those refusals are not worth undoing lightly. <code>169.254.169.254</code> is the cloud metadata
                endpoint — it hands IAM credentials to anything that asks, which is exactly what a prompt-injected agent
                will do — and the RFC1918 ranges are the LAN and the host&apos;s own admin panels. Naming one in{' '}
                <code>allow</code> is a decision a reviewer can see in the yaml; that is the point of it being there and
                not here.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {!page && !error && !loading && !cancelled ? (
        <EmptyState
          title="Nothing loaded yet."
          body="Type a URL above and the machine will fetch it. What comes back is the page's text and its links, not a rendered page — and only for hosts this computer's network policy allows."
          command={`husk exec ${activeId ?? '<id>'} -- curl -sS -o /dev/null -w "%{http_code}" https://example.com`}
        />
      ) : null}

      {/* `.split-wide` is a complete grid on its own; `.split` is kept here only
          so the pair reads as one family in the markup. */}
      {page ? (
        <div className="split split-wide">
          <div className="browse-frame">
            <div className="browse-bar">
              <span className="inline-gap">
                <StatusDot tone={statusTone(page.status)} label={`HTTP ${page.status}`} />
                <span>via {page.via}</span>
                <span className="tnum">{page.elapsedMs} ms</span>
                <span className="tnum">{formatBytes(page.bytes)}</span>
              </span>
              <span className="inline-gap">
                {page.truncated ? <Badge tone="warn">truncated at {formatBytes(page.bytes)}</Badge> : null}
                {page.contentType ? <span>{page.contentType}</span> : null}
              </span>
            </div>

            <article className="read">
              <h2>{page.title === '' ? 'No title' : page.title}</h2>
              <p className="read-url mono">{page.url}</p>
              {page.url !== page.requestedUrl ? (
                <p className="hint">
                  Redirected. You asked for <code>{page.requestedUrl}</code>.
                </p>
              ) : null}

              {page.truncated ? (
                <div className="card warn-card" role="note" style={{ marginTop: 'var(--space-3)' }}>
                  <p>
                    <strong>Truncated.</strong> The page was longer than the {formatBytes(page.bytes)} cap, so the text
                    below stops mid-document and the link list is incomplete.
                  </p>
                </div>
              ) : null}

              {page.status >= 400 ? (
                <div className="card warn-card" role="note" style={{ marginTop: 'var(--space-3)' }}>
                  <p>
                    <strong>The server answered {page.status}.</strong> The text below is that response body — an error
                    page from the far end, not a husk error.
                  </p>
                </div>
              ) : null}

              {page.via === 'curl' ? (
                <div className="card warn-card" role="note" style={{ marginTop: 'var(--space-3)' }}>
                  <p>
                    <strong>Fetched with curl.</strong> This machine has no <code>python3</code>, so the fallback ran:
                    it strips tags and returns the body, but extracts no title and no links.
                  </p>
                </div>
              ) : null}

              <div className="read-body" aria-busy={loading || undefined}>
                {body.length === 0 ? (
                  <p className="hint">
                    No text came back. {page.bytes} bytes arrived with content type{' '}
                    <code>{page.contentType || 'unknown'}</code>, and nothing in it survived tag-stripping — an image, a
                    binary, or a page that builds itself with JavaScript that never runs here.
                  </p>
                ) : (
                  body.map((para, i) => <p key={i}>{para}</p>)
                )}
              </div>
            </article>
          </div>

          <div>
            <h2>Links</h2>
            <p className="hint">
              {links.length === 0
                ? 'None were extracted from this page.'
                : `${links.length} on the page${links.length >= 300 ? ' — the fetcher stops at 300' : ''}. Each one loads here, in this panel.`}
            </p>

            {links.length > 0 ? (
              <>
                <ul className="link-list" style={{ marginTop: 'var(--space-3)' }}>
                  {shown.map((link, i) => (
                    <li key={`${link.href}-${i}`}>
                      <button type="button" className="link-item" onClick={() => navigate(link.href)}>
                        <span className="link-text">{link.text}</span>
                        <span className="link-href mono">{link.href}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {!allLinks && links.length > LINKS_SHOWN ? (
                  <div className="btn-row" style={{ marginTop: 'var(--space-3)' }}>
                    <Button onClick={() => setAllLinks(true)}>Show all {links.length}</Button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <p className="hint">
        This is text, not a rendered page. The server writes a small python script into the computer and runs it there;
        it fetches the URL, strips the markup and returns the text and the links. Nothing renders: scripts do not
        execute, stylesheets and images are never fetched, and a page that builds itself in the browser arrives empty.
        That is deliberate — the fetch happens on the machine so that what you read is what the agent got, from the same
        IP, the same DNS and the same egress path, under the same <code>network</code> policy. A host that policy
        refuses returns <code>E_EXEC_DENIED</code> and is explained here rather than retried.
      </p>
    </section>
  );
}
