/**
 * Every computer at a glance: what it is doing, and whether it is waiting on you.
 *
 * One `GET /v1/overview` every few seconds gives the computers, what each run is
 * doing and on which computer, and the handoffs waiting on a person. Cards are
 * sorted waiting first, then busy, then idle. A look at the browser is taken
 * only when asked for -- a frame runs the driver inside the computer, which
 * counts as use, so polling it would make every computer look busy -- and the
 * server never launches a browser for it. CPU, memory and disk are shown only
 * where they were measured. Model text and app text are rendered as text.
 */

import { useEffect, useState } from 'react';
import { toDisplayError } from '../api/client';
import type { ActiveRunInfo, ActivityEntry, ComputerInfo, ComputerStats, DoctorReport, Overview, PendingHandoff } from '../api/wire';
import { Badge, Button, EmptyState, ErrorBlock, Icon, StatusDot, formatBytes, formatWhen } from '../components/primitives';
import { useConnection } from '../state/connection';
import { useResource } from '../state/useResource';
import { stateTone } from './ComputersPanel';
import { IsolationBadge } from './DoctorPanel';
import { LiveScreen, TakeOver } from './ChatPanel';

export type OverviewTarget = 'chat' | 'terminal' | 'files' | 'browser' | 'handoffs';

interface Row {
  computer: ComputerInfo;
  run?: ActiveRunInfo;
  handoff?: PendingHandoff;
  last?: ActivityEntry;
}

/** Waiting on you first, then busy, then idle; most recently used first within each. */
export function sortRows(overview: Overview): Row[] {
  const rows: Row[] = overview.computers.map((computer) => {
    const run = overview.activeRuns.find((r) => r.computerId === computer.id);
    const handoff = overview.handoffs.find((h) => h.computerId === computer.id);
    const last = overview.activity?.[computer.id];
    return { computer, ...(run ? { run } : {}), ...(handoff ? { handoff } : {}), ...(last ? { last } : {}) };
  });
  const rank = (r: Row) => (r.handoff ? 0 : r.run ? 1 : 2);
  return rows.sort(
    (a, b) => rank(a) - rank(b) || Date.parse(b.computer.lastUsedAt || b.computer.createdAt) - Date.parse(a.computer.lastUsedAt || a.computer.createdAt),
  );
}

function idleFor(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'idle';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'idle for under a minute';
  if (min < 60) return `idle for ${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `idle for ${h} h` : `idle for ${Math.floor(h / 24)} days`;
}

export function OverviewPanel({ onOpen }: { onOpen: (target: OverviewTarget, computerId: string) => void }) {
  const { api, revision } = useConnection();
  const overview = useResource<Overview>((signal) => api.overview(signal), [api, revision], true, { refreshMs: 3000 });
  const doctor = useResource<DoctorReport>((signal) => api.doctor(signal), [api, revision]);
  const [actionError, setActionError] = useState<ReturnType<typeof toDisplayError> | null>(null);

  const rows = overview.data ? sortRows(overview.data) : [];
  const running = rows.filter((r) => r.computer.state === 'running').length;
  const stopped = rows.filter((r) => r.computer.state === 'stopped').length;
  const other = rows.length - running - stopped;
  // A computer the person took themselves is not waiting on them.
  const waiting = overview.data?.handoffs.filter((h) => h.runId !== 'person').length ?? 0;
  // A handoff raised before its run had a computer has no card to sit on.
  const listed = new Set(rows.map((r) => r.computer.id));
  const unplaced = overview.data?.handoffs.filter((h) => !h.computerId || !listed.has(h.computerId)) ?? [];

  const stop = async (id: string) => {
    try {
      setActionError(null);
      await api.stopComputer(id);
      overview.reload();
    } catch (err) {
      setActionError(toDisplayError(err));
    }
  };

  return (
    <section className="panel" aria-labelledby="overview-title">
      <div className="panel-head">
        <h1 id="overview-title">Computers</h1>
        {overview.data ? (
          <p className="overview-summary" role="status">
            <span className="stat">
              <strong>{running}</strong> running
            </span>{' '}
            <span className={waiting ? 'stat stat-alert' : 'stat'}>
              <strong>{waiting}</strong> waiting on you
            </span>{' '}
            <span className="stat">
              <strong>{stopped}</strong> stopped
            </span>
            {other > 0 ? (
              <>
                {' '}
                <span className="stat">
                  <strong>{other}</strong> other
                </span>
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      {overview.error ? <ErrorBlock error={overview.error} retry={overview.reload} /> : null}
      {actionError ? <ErrorBlock error={actionError} /> : null}

      {overview.data && rows.length === 0 ? (
        <EmptyState
          title="No computers yet."
          body="One starts the first time a chat needs it."
        />
      ) : null}

      {unplaced.map((h) => (
        <div key={h.handoffId} className="overview-waiting">
          <div className="row-gap-2" role="status">
            <strong>Waiting for you · {h.husk}</strong>
            <p className="handoff-reason">{h.reason}</p>
          </div>
          <Button variant="primary" onClick={() => onOpen('handoffs', h.computerId ?? '')}>
            Take over
          </Button>
        </div>
      ))}

      <div className="overview-grid">
        {rows.map((row) => (
          <ComputerCard
            key={row.computer.id}
            row={row}
            isolation={doctor.data?.providers.find((p) => p.name === row.computer.provider)}
            onOpen={onOpen}
            onStop={() => void stop(row.computer.id)}
            onChange={overview.reload}
          />
        ))}
      </div>
    </section>
  );
}

function ComputerCard({
  row,
  isolation,
  onOpen,
  onStop,
  onChange,
}: {
  row: Row;
  isolation: DoctorReport['providers'][number] | undefined;
  onOpen: (target: OverviewTarget, computerId: string) => void;
  onStop: () => void;
  onChange: () => void;
}) {
  const { computer, run, handoff, last } = row;
  const name = computer.chatLabel ?? (computer.name && computer.name !== computer.id ? computer.name : computer.id);
  const activity = run
    ? `Running ${run.husk}${run.step !== undefined ? ` · step ${run.step}` : ''}${run.tool ? ` · ${run.tool}` : ''}`
    : computer.state === 'running'
      ? idleFor(computer.lastUsedAt || computer.createdAt)
      : `last used ${formatWhen(computer.lastUsedAt)}`;

  return (
    <article className={`card overview-card${handoff ? (handoff.runId === 'person' ? ' overview-card-held' : ' overview-card-waiting') : ''}`} aria-label={name}>
      <header className="overview-card-head">
        <div>
          <h2 className="overview-card-name">{name}</h2>
          <div className="overview-card-meta">
            {computer.platform ? <Badge>{computer.platform}</Badge> : null}
            {isolation ? <IsolationBadge isolated={isolation.isolated} kind={isolation.isolationKind} /> : <Badge>{computer.provider}</Badge>}
          </div>
        </div>
        <StatusDot pill tone={stateTone(computer.state)} label={computer.state} />
      </header>

      {computer.state !== 'running' ? null : inUse(row) ? <LiveScreen id={computer.id} fps={1} /> : <BrowserLook id={computer.id} />}

      <div>
        <p className="field-note overview-line">{activity}</p>
        {last && !run ? (
          <p className="field-note overview-line">
            <strong>{last.tool}</strong>
            {last.summary ? <code className="mono"> {last.summary}</code> : null}
            {last.ok ? '' : ' · failed'}
          </p>
        ) : null}
        <StatsLine id={computer.id} running={computer.state === 'running'} />
      </div>

      {handoff ? <TakeOver computerId={computer.id} handoff={handoff} onOpen={onOpen} onChange={onChange} /> : null}

      <footer className="overview-card-foot">
        <div className="btn-row">
          <Button size="sm" variant="primary" onClick={() => onOpen('chat', computer.id)} aria-label={`Open ${name}`}>
            Open
          </Button>
          {!handoff && computer.state === 'running' ? (
            <TakeOver computerId={computer.id} handoff={undefined} onOpen={onOpen} onChange={onChange} />
          ) : null}
        </div>
        <div className="btn-row">
          <Button size="sm" variant="ghost" className="btn-icon" onClick={() => onOpen('terminal', computer.id)} aria-label="Terminal" title="Terminal">
            <Icon name="terminal" />
          </Button>
          <Button size="sm" variant="ghost" className="btn-icon" onClick={() => onOpen('files', computer.id)} aria-label="Files" title="Files">
            <Icon name="files" />
          </Button>
          <Button size="sm" variant="ghost" className="btn-icon" onClick={() => onOpen('browser', computer.id)} aria-label="Browser" title="Browser">
            <Icon name="browser" />
          </Button>
          {computer.state === 'running' ? (
            <Button size="sm" variant="ghost" className="btn-icon" onClick={onStop} aria-label={`Stop ${computer.id}`} title="Stop">
              <Icon name="stop" />
            </Button>
          ) : null}
        </div>
      </footer>
    </article>
  );
}

/**
 * Live only while the computer is in use anyway: a chat acted on it in the last
 * two minutes, a run is on it, or a person holds it. Every frame runs the
 * driver inside the computer, which counts as use, so a live screen on an idle
 * card would keep that computer from ever stopping while Home is open.
 */
function inUse(row: Row): boolean {
  return Boolean(row.run || row.handoff || (row.last && Date.now() - Date.parse(row.last.at) < 120_000));
}

/**
 * One look at the browser, when asked. Not polled: taking a frame runs the
 * driver in the computer, which counts as use, so a polled thumbnail would
 * reset every computer's idle time while this page is open.
 */
function BrowserLook({ id }: { id: string }) {
  const { api } = useConnection();
  const [url, setUrl] = useState<string | null>(null);
  const [none, setNone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  const look = async () => {
    setBusy(true);
    try {
      setUrl(URL.createObjectURL(await api.computerThumbnail(id)));
      setNone(false);
    } catch {
      setUrl(null);
      setNone(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overview-look">
      {url ? <img className="overview-thumb" src={url} alt={`The browser on ${id}`} /> : null}
      {none ? <p className="field-note">No browser is open on this computer.</p> : null}
      <Button size="sm" variant="ghost" loading={busy} onClick={() => void look()}>
        <Icon name="browser" /> {url ? 'Look again' : 'Look at browser'}
      </Button>
    </div>
  );
}

/** CPU, memory and disk, only where measured. Never an estimate. */
function StatsLine({ id, running }: { id: string; running: boolean }) {
  const { api } = useConnection();
  const stats = useResource<ComputerStats>((signal) => api.computerStats(id, signal), [api, id, running], true, {
    // Only while the tab is visible (useResource), and not often: each Docker
    // computer's numbers cost a `docker stats` run.
    refreshMs: running ? 30_000 : 0,
  });
  const s = stats.data;
  if (!s) return null;
  const measured = [
    s.cpuPercent === null ? null : `CPU ${s.cpuPercent.toFixed(1)}%`,
    s.memoryBytes === null ? null : `memory ${formatBytes(s.memoryBytes)}${s.memoryLimitBytes !== null ? ` of ${formatBytes(s.memoryLimitBytes)}` : ''}`,
    s.diskBytes === null ? null : `disk ${formatBytes(s.diskBytes)}`,
  ].filter(Boolean);
  if (measured.length === 0) return null;
  return (
    <p className="field-note overview-line tnum" title={s.notes?.join('; ')}>
      {measured.join(' · ')}
    </p>
  );
}
