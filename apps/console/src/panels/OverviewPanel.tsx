/**
 * Every computer at a glance: what it is doing, and whether it is waiting on you.
 *
 * One `GET /v1/overview` every few seconds gives the computers, what each run is
 * doing and on which computer, and the handoffs waiting on a person. Cards are
 * sorted waiting first, then busy, then idle. A browser thumbnail appears only
 * when that computer already has a browser open -- the server never launches
 * one for it -- and CPU, memory and disk are shown only where they were
 * measured. Model text (handoff reasons) and app text (chat labels) are text.
 */

import { useEffect, useState } from 'react';
import { toDisplayError } from '../api/client';
import type { ActiveRunInfo, ComputerInfo, ComputerStats, DoctorReport, Overview, PendingHandoff } from '../api/wire';
import { Badge, Button, EmptyState, ErrorBlock, PanelHeader, StatusDot, formatBytes, formatWhen } from '../components/primitives';
import { useConnection } from '../state/connection';
import { useResource } from '../state/useResource';
import { stateTone } from './ComputersPanel';
import { IsolationBadge } from './DoctorPanel';

export type OverviewTarget = 'terminal' | 'files' | 'browser' | 'handoffs';

interface Row {
  computer: ComputerInfo;
  run?: ActiveRunInfo;
  handoff?: PendingHandoff;
}

/** Waiting on you first, then busy, then idle; most recently used first within each. */
export function sortRows(overview: Overview): Row[] {
  const rows: Row[] = overview.computers.map((computer) => {
    const run = overview.activeRuns.find((r) => r.computerId === computer.id);
    const handoff = overview.handoffs.find((h) => h.computerId === computer.id);
    return { computer, ...(run ? { run } : {}), ...(handoff ? { handoff } : {}) };
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
  const waiting = overview.data?.handoffs.length ?? 0;

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
      <PanelHeader title="Computers" lede="Every computer, what it is doing, and whether it is waiting on you." />
      <span id="overview-title" className="visually-hidden">
        Computers overview
      </span>

      {overview.data ? (
        <p className="overview-summary" role="status">
          <strong>{running}</strong> running · <strong className={waiting ? 'overview-waiting-count' : undefined}>{waiting}</strong>{' '}
          waiting on you · <strong>{stopped}</strong> stopped
        </p>
      ) : null}

      {overview.error ? <ErrorBlock error={overview.error} retry={overview.reload} /> : null}
      {actionError ? <ErrorBlock error={actionError} /> : null}

      {overview.data && rows.length === 0 ? (
        <EmptyState
          title="No computers yet."
          body="A computer starts the first time a chat or a husk needs one. Nothing runs in advance."
        />
      ) : null}

      <div className="overview-grid">
        {rows.map((row) => (
          <ComputerCard
            key={row.computer.id}
            row={row}
            isolation={doctor.data?.providers.find((p) => p.name === row.computer.provider)}
            onOpen={onOpen}
            onStop={() => void stop(row.computer.id)}
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
}: {
  row: Row;
  isolation: DoctorReport['providers'][number] | undefined;
  onOpen: (target: OverviewTarget, computerId: string) => void;
  onStop: () => void;
}) {
  const { computer, run, handoff } = row;
  const name = computer.chatLabel ?? (computer.name && computer.name !== computer.id ? computer.name : computer.id);
  const activity = run
    ? `Running ${run.husk}${run.step !== undefined ? ` · step ${run.step}` : ''}${run.tool ? ` · ${run.tool}` : ''}`
    : computer.state === 'running'
      ? idleFor(computer.lastUsedAt || computer.createdAt)
      : `last used ${formatWhen(computer.lastUsedAt)}`;

  return (
    <article className={`card overview-card${handoff ? ' overview-card-waiting' : ''}`} aria-label={name}>
      <header className="overview-card-head">
        <StatusDot tone={stateTone(computer.state)} label={computer.state} />
        <h3 className="overview-card-name">{name}</h3>
      </header>
      <div className="btn-row">
        {computer.platform ? <Badge>{computer.platform}</Badge> : null}
        {isolation ? <IsolationBadge isolated={isolation.isolated} kind={isolation.isolationKind} /> : <Badge>{computer.provider}</Badge>}
        <span className="field-note mono">{computer.id}</span>
      </div>
      <p className="field-note">{activity}</p>

      {handoff ? (
        <div className="overview-waiting" role="status">
          <strong>Waiting for you</strong>
          <p className="handoff-reason">{handoff.reason}</p>
          <Button variant="primary" onClick={() => onOpen('handoffs', computer.id)}>
            Take over
          </Button>
        </div>
      ) : null}

      {computer.state === 'running' ? <Thumbnail id={computer.id} /> : null}
      <StatsLine id={computer.id} running={computer.state === 'running'} />

      <div className="btn-row">
        <Button size="sm" onClick={() => onOpen('terminal', computer.id)}>
          Terminal
        </Button>
        <Button size="sm" onClick={() => onOpen('files', computer.id)}>
          Files
        </Button>
        <Button size="sm" onClick={() => onOpen('browser', computer.id)}>
          Browser
        </Button>
        {computer.state === 'running' ? (
          <Button size="sm" onClick={onStop} aria-label={`Stop ${computer.id}`}>
            Stop
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/** The browser, if one is already open. Nothing at all otherwise. */
function Thumbnail({ id }: { id: string }) {
  const { api } = useConnection();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let current: string | null = null;
    const tick = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const blob = await api.computerThumbnail(id, controller.signal);
        const next = URL.createObjectURL(blob);
        if (current) URL.revokeObjectURL(current);
        current = next;
        setUrl(next);
      } catch {
        if (current) URL.revokeObjectURL(current);
        current = null;
        setUrl(null);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
      if (current) URL.revokeObjectURL(current);
    };
  }, [api, id]);
  return url ? <img className="overview-thumb" src={url} alt={`The browser on ${id}`} /> : null;
}

/** CPU, memory and disk where measured; "not available" where not. Never an estimate. */
function StatsLine({ id, running }: { id: string; running: boolean }) {
  const { api } = useConnection();
  const stats = useResource<ComputerStats>((signal) => api.computerStats(id, signal), [api, id, running], true, {
    refreshMs: running ? 10_000 : 0,
  });
  const s = stats.data;
  if (!s) return null;
  const cpu = s.cpuPercent === null ? 'CPU not available' : `CPU ${s.cpuPercent.toFixed(1)}%`;
  const mem =
    s.memoryBytes === null
      ? 'memory not available'
      : `memory ${formatBytes(s.memoryBytes)}${s.memoryLimitBytes !== null ? ` of ${formatBytes(s.memoryLimitBytes)}` : ''}`;
  const disk = s.diskBytes === null ? 'disk not available' : `disk ${formatBytes(s.diskBytes)}`;
  return (
    <p className="field-note tnum" title={s.notes?.join('; ')}>
      {cpu} · {mem} · {disk}
    </p>
  );
}
