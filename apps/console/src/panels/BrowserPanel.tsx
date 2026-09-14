/**
 * Two browsers, one panel, and a label on each saying which one you are looking at.
 *
 * **Rendered** drives a real Chromium inside the computer over CDP:
 * `POST /v1/computers/:id/browser/{goto,snapshot,click,type}` and
 * `GET .../browser/screenshot`. Scripts run, CSS applies, subresources load —
 * so a page whose body is written by a `<script>` is visible here and nowhere
 * else in this console. What you see is a PNG the machine took, refreshed after
 * anything that changes the page, and a list of the page's interactive nodes
 * you can click and type into by `ref`.
 *
 * **Text** is the old `POST /v1/computers/:id/browse`: the server writes a small
 * python script into the computer, runs it there, and it fetches the URL, strips
 * the markup and returns the text plus the first 300 links. It renders nothing
 * and it needs nothing installed, which is exactly why it stays — it answers in
 * about 200ms where the real browser wants a 111 MB download the first time.
 *
 * Three things this file refuses to fake:
 *
 * 1. **The screenshot is a still.** Each frame is one `GET`. There is no video
 *    stream behind it and no "live" badge above it; the bar says when the frame
 *    was taken, and every action that could change the page takes a new one.
 * 2. **The first launch is slow and large.** It is announced before it starts,
 *    with the size; while it runs the panel counts the seconds and reports the
 *    machine's own progress — `routes/browser.ts` puts the provisioner's
 *    messages on the event bus as `computers/browser_progress`. That includes
 *    megabytes downloaded, which is not curl's progress meter (that is on a
 *    stderr inside the computer) but the size of the file curl is writing,
 *    measured from inside every few seconds.
 * 3. **The debug port.** On `local` and `ssh` the computer shares a network
 *    stack with the host, so Chromium's CDP port may be reachable by other
 *    local processes, and CDP has no authentication. `@husk-ai/browser` says this
 *    at launch into the server's log, where nobody using the console will see
 *    it. It is said here too, once, as a property of the provider — not as an
 *    alarm, because nothing has gone wrong.
 *
 * There is still no iframe and no `dangerouslySetInnerHTML`. The rendered view
 * is an `<img>` of a PNG and a list of strings in React text nodes; every byte
 * of both came off a page the machine was pointed at, and none of it is trusted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection } from '../state/connection';
import { useComputers } from '../state/computers';
import { computerGate } from './computerGate';
import { isAbort, toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import type { BrowsePage, SnapshotNode } from '../api/wire';
import {
  actionableNodes,
  classifyBrowserError,
  debugPortIsShared,
  followUps,
  isTextInput,
  latestProgressFor,
  nodeLabel,
  normaliseUrl,
} from './browserModel';
import type { PageAction } from './browserModel';
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

/** What the snapshot route defaults to, stated rather than left implicit. */
const SNAPSHOT_LIMIT = 400;

/** `downloadPlanFor` in `@husk-ai/browser`: 111 MB on arm64, and about that on x64. */
const DOWNLOAD_MB = 111;

/**
 * Which computers have answered a `/browser/*` call in this console session.
 *
 * Module-level, not state: the point of it is to survive switching panels and
 * switching machines, because the expensive thing it gates — the ~111 MB
 * download — survives both too. It is a cache of "we have seen this work", so
 * being wrong after a server restart costs one extra pre-flight card, not a bug.
 */
const launched = new Set<string>();

/** Computers whose debug-port note the user has already read and closed. */
const noteRead = new Set<string>();

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

function clockOf(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

interface History {
  /** Requested URLs, oldest first. */
  entries: string[];
  /** -1 before anything has been loaded. */
  index: number;
}

const NO_HISTORY: History = { entries: [], index: -1 };

/** A captured frame and when it was captured. The object URL is ours to revoke. */
interface Still {
  src: string;
  at: number;
}

type Mode = 'render' | 'text';

export function BrowserPanel({
  activeId,
  onSelect,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const { api, events } = useConnection();
  const computers = useComputers();
  const active = computers.list.find((c) => c.id === activeId) ?? null;

  // Text is the default because it is the cheap one: nothing to install, no
  // 111 MB, an answer in about 200ms. Rendered is one click away and says what
  // it costs before it spends it.
  const [mode, setMode] = useState<Mode>('text');

  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<History>(NO_HISTORY);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  // -- text view ------------------------------------------------------------
  const [page, setPage] = useState<BrowsePage | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [slow, setSlow] = useState(false);
  const [allLinks, setAllLinks] = useState(false);

  // -- rendered view --------------------------------------------------------
  const [still, setStill] = useState<Still | null>(null);
  const [nodes, setNodes] = useState<SnapshotNode[]>([]);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [rError, setRError] = useState<DisplayError | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  /** null while unknown. Gates the download prompt, which `ready` cannot: `ready`
   *  only knows whether *this* session launched a browser, so a reload or a
   *  previous session's install still showed a 111 MB offer for nothing. */
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const stillRef = useRef<Still | null>(null);

  /** One place owns the object URL, so there is exactly one revoke per frame. */
  const putStill = useCallback((next: Still | null) => {
    if (stillRef.current) URL.revokeObjectURL(stillRef.current.src);
    stillRef.current = next;
    setStill(next);
  }, []);

  // A history stack belongs to a machine. Switching machines is a new session,
  // not a continuation of the old one — the allow-list is different too, and so
  // is the browser: `browserFor` keys its sessions by computer id.
  useEffect(() => {
    setDraft('');
    setHistory(NO_HISTORY);
    setPage(null);
    setError(null);
    setCancelled(false);
    setNotice(null);
    setAllLinks(false);
    setNodes([]);
    setPageUrl(null);
    setPageTitle(null);
    setPartial(false);
    setRError(null);
    setDrafts({});
    putStill(null);
    setReady(activeId !== null && launched.has(activeId));
    setInstalled(null);
    setNoteOpen(activeId !== null && !noteRead.has(activeId));
  }, [activeId, putStill]);

  // Ask the machine whether it already has a browser, so the download prompt is
  // only shown to someone who would actually pay for it. Render mode only: the
  // text view installs nothing and should not spend a round trip asking.
  useEffect(() => {
    if (!activeId || mode !== 'render') return;
    let cancelled = false;
    const ac = new AbortController();
    void api
      .browserStatus(activeId, ac.signal)
      .then((s) => {
        if (!cancelled) setInstalled(s.installed);
      })
      .catch(() => {
        // A machine that cannot answer is treated as not installed: offering the
        // download is recoverable, hiding it when it is needed is not.
        if (!cancelled) setInstalled(false);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [api, activeId, mode]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (stillRef.current) URL.revokeObjectURL(stillRef.current.src);
    },
    [],
  );

  /**
   * The seconds counter under a running browser call.
   *
   * A number that is actually measured, which §6 prefers to any animation. It
   * is not the download's byte progress — the console is not sent that — and
   * the copy next to it says so rather than implying otherwise.
   */
  useEffect(() => {
    if (busy === null) return;
    // The zeroing happens in `drive`, where the wait actually begins; doing it
    // here would be a setState inside an effect for no reason.
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // -- the text view's loader ----------------------------------------------

  const loadText = useCallback(
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
          `Loaded ${next.title || next.url} as text — HTTP ${next.status}, ${next.links.length} link${
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

  // -- the rendered view's driver ------------------------------------------

  /**
   * Run one browser action, then everything `followUps` says must follow it.
   *
   * The rule lives in `browserModel.ts` and is unit-tested there, because "the
   * screenshot is refreshed after anything that changes the page" is precisely
   * the kind of invariant that survives review and then dies in a later edit.
   */
  const drive = useCallback(
    async (
      action: PageAction,
      label: string,
      call: (id: string, signal: AbortSignal) => Promise<void>,
    ): Promise<void> => {
      if (!activeId) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setRError(null);
      setCancelled(false);
      setNotice(null);
      setElapsed(0);
      setBusy(label);

      try {
        await call(activeId, controller.signal);
        if (controller.signal.aborted) return;
        launched.add(activeId);
        setReady(true);

        for (const stepName of followUps(action)) {
          if (stepName === 'snapshot') {
            const snap = await api.browserSnapshot(activeId, SNAPSHOT_LIMIT, controller.signal);
            if (controller.signal.aborted) return;
            setNodes(snap.nodes);
            setPageUrl(snap.url);
          } else {
            const bytes = await api.browserScreenshot(activeId, false, controller.signal);
            if (controller.signal.aborted) return;
            putStill({ src: URL.createObjectURL(pngBlob(bytes)), at: Date.now() });
          }
        }
        setNotice(`${label} finished. The screenshot below was taken after it.`);
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return;
        setRError(toDisplayError(err));
      } finally {
        if (!controller.signal.aborted) setBusy(null);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [api, activeId, putStill],
  );

  const gotoRendered = useCallback(
    (url: string) =>
      void drive('goto', `Opening ${url}`, async (id, signal) => {
        const res = await api.browserGoto(id, { url }, signal);
        setPageUrl(res.url);
        setPageTitle(res.title);
        setPartial(!res.loaded);
      }),
    [api, drive],
  );

  const clickRef = useCallback(
    (node: SnapshotNode) =>
      void drive('click', `Clicking ${nodeLabel(node)}`, async (id, signal) => {
        const res = await api.browserClick(id, node.ref, signal);
        setNodes(res.nodes);
        setPageUrl(res.url);
      }),
    [api, drive],
  );

  const typeInto = useCallback(
    (node: SnapshotNode, text: string, submit: boolean) =>
      void drive('type', `Typing into ${nodeLabel(node)}`, async (id, signal) => {
        const res = await api.browserType(id, node.ref, text, submit, signal);
        setNodes(res.nodes);
        setPageUrl(res.url);
      }),
    [api, drive],
  );

  const resnapshot = useCallback(
    () =>
      void drive('snapshot', 'Taking a snapshot', async (id, signal) => {
        const snap = await api.browserSnapshot(id, SNAPSHOT_LIMIT, signal);
        setNodes(snap.nodes);
        setPageUrl(snap.url);
      }),
    [api, drive],
  );

  const recapture = useCallback(
    () =>
      void drive('screenshot', 'Taking a screenshot', async (id, signal) => {
        const bytes = await api.browserScreenshot(id, false, signal);
        putStill({ src: URL.createObjectURL(pngBlob(bytes)), at: Date.now() });
      }),
    [api, drive, putStill],
  );

  // -- shared navigation ----------------------------------------------------

  const go = useCallback(
    (url: string) => {
      if (mode === 'render') gotoRendered(url);
      else void loadText(url);
    },
    [mode, gotoRendered, loadText],
  );

  /** A new destination: truncate anything ahead of the cursor, then push. */
  const navigate = useCallback(
    (raw: string) => {
      const url = normaliseUrl(raw);
      if (url === null) return;
      setDraft(url);
      setHistory((h) => ({ entries: [...h.entries.slice(0, h.index + 1), url], index: h.index + 1 }));
      go(url);
    },
    [go],
  );

  /** Back and forward move the cursor. Neither one rewrites the stack. */
  const step = useCallback(
    (delta: -1 | 1) => {
      const next = history.index + delta;
      const url = history.entries[next];
      if (url === undefined) return;
      setHistory({ entries: history.entries, index: next });
      setDraft(url);
      go(url);
    },
    [history, go],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setShowSkeleton(false);
    setSlow(false);
    setBusy(null);
    setCancelled(true);
  }, []);

  const current = history.index >= 0 ? (history.entries[history.index] ?? null) : null;
  const canBack = history.index > 0;
  const canForward = history.index >= 0 && history.index < history.entries.length - 1;

  const gate = computerGate({
    computers,
    title: 'Browser',
    lede: 'POST /v1/computers/:id/browser/* — a real Chromium in the machine, or the text fallback',
    emptyTitle: 'No computer to browse from.',
    emptyBody:
      "The browser runs inside a machine, on that machine's network — so there has to be a machine first. Create one on the Computers panel.",
  });
  if (gate) return <>{gate}</>;

  const links = page?.links ?? [];
  const shown = allLinks ? links : links.slice(0, LINKS_SHOWN);
  const body = page ? paragraphs(page.text) : [];
  const policy = active?.spec.network;
  const shownError = mode === 'render' ? rError : error;
  const deniedHost = shownError?.code === 'E_EXEC_DENIED' && current ? hostOf(current) : null;
  const failure = shownError ? classifyBrowserError(shownError) : null;
  const controls = actionableNodes(nodes);
  const working = mode === 'render' ? busy !== null : loading;
  const provisioning = mode === 'render' && busy !== null && !ready;
  // The machine's own last word on what it is doing, off the event bus.
  const progress = latestProgressFor(events, activeId);

  return (
    <section className="panel" aria-labelledby="browser-title">
      <PanelHeader
        title="Browser"
        lede={
          mode === 'render'
            ? 'A real Chromium running inside the machine. Scripts run; the view is a screenshot it took, and the page is driven by accessibility ref, not by coordinate.'
            : 'A page fetched from inside the machine and shown as extracted text. No browser engine, no iframe — and nothing to install.'
        }
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
              {computers.list.map((c) => (
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

      {/* Two views of the same URL, named by what they actually are. §4's tab
          states: the selected one carries a border and `aria-selected`, never
          colour alone. */}
      <div className="view-switch" role="tablist" aria-label="How to show the page">
        <button
          type="button"
          role="tab"
          id="browser-tab-render"
          className="view-tab"
          aria-selected={mode === 'render'}
          aria-controls="browser-view"
          onClick={() => setMode('render')}
        >
          Rendered
          <span className="view-tab-note">real Chromium · screenshot · clickable</span>
        </button>
        <button
          type="button"
          role="tab"
          id="browser-tab-text"
          className="view-tab"
          aria-selected={mode === 'text'}
          aria-controls="browser-view"
          onClick={() => setMode('text')}
        >
          Text
          <span className="view-tab-note">fetch and strip · ~200 ms · nothing to install</span>
        </button>
      </div>

      {active && active.state !== 'running' ? (
        <div className="card warn-card" role="note" style={{ marginBottom: 'var(--space-4)' }}>
          <p>
            <strong>
              {active.id} is {active.state}.
            </strong>{' '}
            Both views run as commands inside it, so every load will fail until it is started again.
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
        <Button type="submit" variant="primary" disabled={normaliseUrl(draft) === null}>
          {mode === 'render' ? 'Open' : 'Load'}
        </Button>
        {working ? (
          <Button variant="ghost" onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button
            variant="ghost"
            onClick={() => {
              if (current !== null) go(current);
            }}
            disabled={current === null}
          >
            Reload
          </Button>
        )}
      </form>
      <p className="field-note" id="browse-url-note">
        A bare host gets <code>https://</code> in front of it. Type the scheme yourself to override that.{' '}
        {mode === 'render'
          ? 'The URL is checked against this computer’s network policy before Chromium navigates to it.'
          : 'The same network policy applies to this fetch.'}
      </p>

      {/* §6, with one deliberate reading of it. A skeleton is for content that
          is not on screen yet — it holds the shape so nothing reflows on
          arrival. When a page is already rendered, a skeleton stacked above it
          says less than a line naming the URL being fetched. */}
      {mode === 'text' && loading && (slow || (showSkeleton && page !== null)) ? (
        <StatusLine text={`Fetching ${current ?? draft} from inside ${activeId ?? ''}…`} />
      ) : null}
      {mode === 'text' && loading && showSkeleton && !slow && page === null ? <Skeleton rows={6} height={24} /> : null}

      {mode === 'render' && busy !== null ? (
        <StatusLine
          text={
            provisioning
              ? `${busy} — ${elapsed}s. First use installs Chromium inside ${activeId ?? ''} (~${DOWNLOAD_MB} MB).`
              : `${busy} — ${elapsed}s.`
          }
        />
      ) : null}

      {provisioning && elapsed >= 5 ? (
        <div className="card" role="note" style={{ marginTop: 'var(--space-3)' }}>
          <p>
            <strong>Installing Chromium in {activeId}.</strong> It is downloaded from inside the computer, over that
            computer&apos;s own egress path, into <code>/work/.husk-browser</code> — so on a persistent machine it is
            kept, and this wait happens once.
          </p>
          {progress ? (
            <p style={{ marginTop: 'var(--space-2)' }}>
              <span className="hint">Now: </span>
              <span role="status">{progress}</span>
            </p>
          ) : null}
          <p className="hint" style={{ marginTop: 'var(--space-2)' }}>
            Everything above is measured, not estimated. The byte count is the size of the file curl is writing inside
            the machine, read every few seconds — so it moves when the download moves and stops when it stalls. The
            total is approximate because it is the published archive size, not a <code>Content-Length</code> we were
            given. To watch the same file yourself:
          </p>
          <pre className="code" style={{ marginTop: 'var(--space-2)' }}>
            {`husk exec ${activeId ?? '<id>'} -- du -sh /work/.husk-browser`}
          </pre>
        </div>
      ) : null}

      {cancelled ? (
        <p className="hint" role="status">
          Cancelled here, not in the machine — the command may still be finishing there, and a Chromium download that
          had already started will still land. Anything below is the previous state.
        </p>
      ) : null}

      <p className="visually-hidden" role="status">
        {notice ?? ''}
      </p>

      {shownError && failure ? (
        <div className="row-gap-4">
          {/* `exactOptionalPropertyTypes`: an absent retry is not `retry: undefined`. */}
          <ErrorBlock
            error={shownError}
            {...(current !== null ? { retry: () => go(current) } : {})}
            retryLabel={mode === 'render' ? 'Open again' : 'Load again'}
          />
          <div className="card">
            <h3>
              {failure.kind === 'denied'
                ? 'This is the network policy, not a failure.'
                : failure.kind === 'unavailable'
                  ? 'The real browser is not available on this machine.'
                  : failure.kind === 'launch'
                    ? 'The browser did not answer.'
                    : failure.kind === 'stale-ref'
                      ? 'The page moved under that ref.'
                      : 'What state things are in now.'}
            </h3>
            <p className="hint" style={{ marginTop: 'var(--space-2)' }}>
              {failure.body}
            </p>
            {failure.suggestTextView || failure.suggestSnapshot ? (
              <div className="btn-row" style={{ marginTop: 'var(--space-3)' }}>
                {failure.suggestTextView ? (
                  <Button
                    onClick={() => {
                      setMode('text');
                      if (current !== null) void loadText(current);
                    }}
                  >
                    Show the text view instead
                  </Button>
                ) : null}
                {failure.suggestSnapshot && mode === 'render' ? (
                  <Button onClick={resnapshot}>Take a new snapshot</Button>
                ) : null}
              </div>
            ) : null}
          </div>

          {shownError.code === 'E_EXEC_DENIED' ? (
            <div className="card">
              <h3>The policy that refused it</h3>
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
                      <>
                        {' '}
                        and no allow list, which under <code>egress</code> permits nothing
                      </>
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

      <div id="browser-view" role="tabpanel" aria-labelledby={`browser-tab-${mode}`}>
        {mode === 'render' ? (
          <RenderedView
            activeId={activeId}
            provider={active?.provider ?? ''}
            sharedPort={active ? debugPortIsShared(active.provider) : false}
            noteOpen={noteOpen}
            onCloseNote={() => {
              if (activeId) noteRead.add(activeId);
              setNoteOpen(false);
            }}
            ready={ready}
            installed={installed}
            busy={busy}
            still={still}
            pageUrl={pageUrl}
            pageTitle={pageTitle}
            partial={partial}
            nodes={nodes}
            controls={controls}
            drafts={drafts}
            onDraft={(ref, value) => setDrafts((d) => ({ ...d, [ref]: value }))}
            hasError={rError !== null}
            onOpen={() => {
              const url = normaliseUrl(draft) ?? current;
              if (url !== null) navigate(url);
            }}
            onClickNode={clickRef}
            onTypeNode={typeInto}
            onSnapshot={resnapshot}
            onRecapture={recapture}
          />
        ) : (
          <TextView
            activeId={activeId}
            page={page}
            body={body}
            links={links}
            shown={shown}
            allLinks={allLinks}
            onShowAll={() => setAllLinks(true)}
            onNavigate={navigate}
            loading={loading}
            idle={!page && error === null && !loading && !cancelled}
          />
        )}
      </div>
    </section>
  );
}

/** PNG bytes to something `URL.createObjectURL` will take, with no copy games. */
function pngBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/png' });
}

/* -------------------------------------------------------------------------- */

function RenderedView({
  activeId,
  provider,
  sharedPort,
  noteOpen,
  onCloseNote,
  ready,
  installed,
  busy,
  still,
  pageUrl,
  pageTitle,
  partial,
  nodes,
  controls,
  drafts,
  onDraft,
  hasError,
  onOpen,
  onClickNode,
  onTypeNode,
  onSnapshot,
  onRecapture,
}: {
  activeId: string | null;
  provider: string;
  sharedPort: boolean;
  noteOpen: boolean;
  onCloseNote: () => void;
  ready: boolean;
  /** null while unknown; gates the download prompt. */
  installed: boolean | null;
  busy: string | null;
  still: Still | null;
  pageUrl: string | null;
  pageTitle: string | null;
  partial: boolean;
  nodes: SnapshotNode[];
  controls: SnapshotNode[];
  drafts: Record<string, string>;
  onDraft: (ref: string, value: string) => void;
  hasError: boolean;
  onOpen: () => void;
  onClickNode: (node: SnapshotNode) => void;
  onTypeNode: (node: SnapshotNode, text: string, submit: boolean) => void;
  onSnapshot: () => void;
  onRecapture: () => void;
}) {
  return (
    <div className="row-gap-4">
      {/* Said once per machine, in the same words `warnIfDebugPortIsExposed`
          uses, and closable — it is a property of the provider, not an event,
          and an unclosable banner about a condition that will never change is
          how people learn to ignore banners. */}
      {sharedPort && noteOpen ? (
        <div className="card" role="note">
          <h3>Chromium’s debug port sits on a network stack this computer shares with the host.</h3>
          <p className="hint" style={{ marginTop: 'var(--space-2)' }}>
            Husk binds the port to the computer’s loopback and publishes nothing, but <code>{provider}</code> does not
            own its own network namespace — under WSL2 the platform forwards loopback listeners to Windows by itself —
            so another local process may be able to reach it. CDP has no authentication: anything that reaches it can
            drive this browser, read what it reads, and run script in its pages. Use <code>docker</code>,{' '}
            <code>podman</code> or <code>fly</code> for browsing you do not trust. Nothing has failed; this is what the
            provider is.
          </p>
          <div className="btn-row" style={{ marginTop: 'var(--space-3)' }}>
            <Button variant="ghost" onClick={onCloseNote}>
              Understood
            </Button>
          </div>
        </div>
      ) : null}

      {!ready && installed === true && busy === null && !hasError ? (
        <div className="card">
          <h3>Chromium is already in {activeId ?? 'this computer'}.</h3>
          <p className="hint" style={{ marginTop: 'var(--space-2)' }}>
            Nothing to download. Opening a page starts it and takes a few seconds.
          </p>
          <div className="btn-row" style={{ marginTop: 'var(--space-3)' }}>
            <Button variant="primary" onClick={onOpen}>
              Open the page
            </Button>
          </div>
        </div>
      ) : null}

      {!ready && installed === false && busy === null && !hasError ? (
        <div className="card">
          <h3>
            First use downloads about {DOWNLOAD_MB} MB into {activeId ?? 'this computer'}.
          </h3>
          <p className="hint" style={{ marginTop: 'var(--space-2)' }}>
            There is no Chromium in the machine yet. Opening a page installs one: a headless build is fetched from
            inside the computer, under that computer’s own network policy, and unpacked into{' '}
            <code>/work/.husk-browser</code>. On a persistent machine it is kept, so this happens once. Expect a minute
            or two on a normal connection — the panel counts the seconds while it runs.
          </p>
          <p className="hint">
            If you only need the page&apos;s words, the <strong>Text</strong> view answers in about 200 ms and installs
            nothing.
          </p>
          <div className="btn-row" style={{ marginTop: 'var(--space-3)' }}>
            <Button variant="primary" onClick={onOpen}>
              Install Chromium and open the page
            </Button>
          </div>
        </div>
      ) : null}

      {still === null && ready && busy === null && !hasError ? (
        <EmptyState
          title="Chromium is running; nothing is on screen yet."
          body="Type a URL above and open it. What appears below is a screenshot the machine took, with the page's interactive nodes listed beside it."
          command={`husk exec ${activeId ?? '<id>'} -- ls /work/.husk-browser`}
        />
      ) : null}

      {still !== null ? (
        <div className="split split-wide">
          <div className="browse-frame">
            <div className="browse-bar">
              <span className="inline-gap">
                <StatusDot tone={partial ? 'warn' : 'success'} label={partial ? 'load timed out' : 'loaded'} />
                <span>still · captured {clockOf(still.at)}</span>
              </span>
              <span className="inline-gap">
                <Badge tone="muted">not a live stream</Badge>
                <Button variant="ghost" onClick={onRecapture} disabled={busy !== null}>
                  New screenshot
                </Button>
              </span>
            </div>

            <div className="shot">
              {/* A PNG the machine took, fitted to the panel. The `alt` names
                  what the image is rather than describing it: the description a
                  screen reader can act on is the node list beside it. */}
              <img
                className="shot-img"
                src={still.src}
                alt={`Screenshot of ${pageUrl ?? 'the page'}, taken at ${clockOf(still.at)}`}
                aria-busy={busy !== null || undefined}
              />
            </div>

            <div className="shot-foot">
              <h2 className="shot-title">{pageTitle ? pageTitle : 'No title'}</h2>
              <p className="read-url mono">{pageUrl ?? ''}</p>
              {partial ? (
                <p className="hint">
                  The load timed out before the page finished. What is above is the page as it stood at that moment —
                  usable, just not final. <strong>New screenshot</strong> shows where it has got to since.
                </p>
              ) : null}
              <p className="hint">
                Each frame is one <code>GET .../browser/screenshot</code>. Nothing streams: this image is as current as
                its timestamp and no more. It is retaken automatically after anything that changes the page.
              </p>
            </div>
          </div>

          <div>
            <h2>Interactive nodes</h2>
            <p className="hint">
              {nodes.length === 0
                ? 'No snapshot yet.'
                : `${controls.length} of ${nodes.length} nodes can be acted on. Each is addressed by its ref, taken from the accessibility tree — not by pixel, which is how both agents and people misclick when the layout shifts.`}
            </p>
            <div className="btn-row" style={{ marginTop: 'var(--space-3)' }}>
              <Button onClick={onSnapshot} disabled={busy !== null}>
                New snapshot
              </Button>
            </div>

            {controls.length > 0 ? (
              <ul className="node-list" style={{ marginTop: 'var(--space-3)' }}>
                {controls.map((node) => (
                  <li key={node.ref}>
                    <div className="node-row">
                      <span className="node-head">
                        <Badge tone="info">{node.role}</Badge>
                        <span className="node-name">{nodeLabel(node)}</span>
                        <span className="node-ref mono">{node.ref}</span>
                      </span>

                      {isTextInput(node) ? (
                        <form
                          className="node-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            onTypeNode(node, drafts[node.ref] ?? '', true);
                          }}
                        >
                          <label className="visually-hidden" htmlFor={`type-${node.ref}`}>
                            Text to type into {nodeLabel(node)}
                          </label>
                          <input
                            id={`type-${node.ref}`}
                            className="input"
                            type="text"
                            value={drafts[node.ref] ?? ''}
                            placeholder={node.value ? node.value : 'text to type'}
                            onChange={(e) => onDraft(node.ref, e.target.value)}
                            spellCheck={false}
                            autoComplete="off"
                            disabled={busy !== null}
                          />
                          <Button onClick={() => onTypeNode(node, drafts[node.ref] ?? '', false)} disabled={busy !== null}>
                            Type
                          </Button>
                          <Button type="submit" variant="primary" disabled={busy !== null}>
                            Type and Enter
                          </Button>
                        </form>
                      ) : (
                        <Button onClick={() => onClickNode(node)} disabled={busy !== null}>
                          Click
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : nodes.length > 0 ? (
              <p className="hint" style={{ marginTop: 'var(--space-3)' }}>
                The snapshot holds {nodes.length} nodes and none of them can be acted on — they are headings, text and
                landmarks, or nodes the tree gave no resolvable handle for. A page can be entirely readable and have
                nothing to click.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function TextView({
  activeId,
  page,
  body,
  links,
  shown,
  allLinks,
  onShowAll,
  onNavigate,
  loading,
  idle,
}: {
  activeId: string | null;
  page: BrowsePage | null;
  body: string[];
  links: BrowsePage['links'];
  shown: BrowsePage['links'];
  allLinks: boolean;
  onShowAll: () => void;
  onNavigate: (url: string) => void;
  loading: boolean;
  idle: boolean;
}) {
  return (
    <>
      {idle ? (
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
                    binary, or a page that builds itself with JavaScript. That last one is exactly what the{' '}
                    <strong>Rendered</strong> view is for: it runs the script.
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
                      <button type="button" className="link-item" onClick={() => onNavigate(link.href)}>
                        <span className="link-text">{link.text}</span>
                        <span className="link-href mono">{link.href}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {!allLinks && links.length > LINKS_SHOWN ? (
                  <div className="btn-row" style={{ marginTop: 'var(--space-3)' }}>
                    <Button onClick={onShowAll}>Show all {links.length}</Button>
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
        execute, stylesheets and images are never fetched, and a page that builds itself in the browser arrives empty —
        switch to <strong>Rendered</strong> for that one. The fetch happens on the machine so that what you read is what
        the agent got, from the same IP, the same DNS and the same egress path, under the same <code>network</code>{' '}
        policy.
      </p>
    </>
  );
}
