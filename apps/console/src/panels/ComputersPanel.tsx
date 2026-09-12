/**
 * `GET /v1/computers`, plus create / stop / start / destroy.
 *
 * The isolation column is joined from `GET /v1/doctor`, because `ComputerInfo`
 * does not carry an `isolated` flag — the provider does. A machine on the
 * `local` provider says so in its own row, not in a footnote.
 */

import { useCallback, useMemo, useState } from 'react';
import { useConnection } from '../state/connection';
import { useComputers } from '../state/computers';
import { useResource } from '../state/useResource';
import { toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import type { ComputerInfo, ComputerSpec, DoctorProvider, DoctorReport } from '../api/wire';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBlock,
  Field,
  PanelHeader,
  Skeleton,
  StatusDot,
  StatusLine,
  formatWhen,
} from '../components/primitives';
import { IsolationBadge } from './DoctorPanel';
import type { Tone } from '../components/primitives';

const FLAVORS = ['base', 'python', 'node', 'full'] as const;
const NETWORK_MODES = ['none', 'egress', 'full'] as const;

type Flavor = (typeof FLAVORS)[number];
type NetworkMode = (typeof NETWORK_MODES)[number];

function stateTone(state: ComputerInfo['state']): Tone {
  switch (state) {
    case 'running':
      return 'success';
    case 'creating':
      return 'info';
    case 'paused':
    case 'stopped':
      return 'warn';
    case 'error':
      return 'danger';
    default:
      return 'muted';
  }
}

/**
 * The one-word isolation summary shown beside a provider in the create form.
 *
 * Deliberately blunt: the dropdown is where someone picks what will run their
 * agent's code, and "local" must not read like a peer of "docker" there.
 */
function isolationWord(p: DoctorProvider): string {
  switch (p.isolationKind) {
    case 'kernel':
      return 'isolated';
    case 'machine':
      return 'isolated from this machine';
    case 'guardrails':
      return 'guardrails only';
    default:
      if (p.isolated === null || p.isolated === undefined) return 'isolation unknown';
      return p.isolated ? 'isolated' : 'guardrails only';
  }
}

export function ComputersPanel({
  activeId,
  onSelect,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const { api, revision, invalidate } = useConnection();

  // The shared list — the one `GET /v1/computers` in the app. This panel used
  // to make its own identical call; two sources of the same fact is how the
  // list could be populated here and empty everywhere else at the same moment.
  const computers = useComputers();
  const doctor = useResource<DoctorReport>((signal) => api.doctor(signal), [api, revision]);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<DisplayError | null>(null);

  // The whole provider, not just its boolean: the badge needs `isolationKind`
  // to tell an ssh box apart from a docker container.
  const providerByName = useMemo(() => {
    const map = new Map<string, DoctorProvider>();
    for (const p of doctor.data?.providers ?? []) map.set(p.name, p);
    return map;
  }, [doctor.data]);

  const act = useCallback(
    async (id: string, fn: () => Promise<unknown>) => {
      setBusyId(id);
      setActionError(null);
      try {
        await fn();
        invalidate();
        computers.reload();
      } catch (err) {
        setActionError(toDisplayError(err));
      } finally {
        setBusyId(null);
      }
    },
    [computers, invalidate],
  );

  const destroy = useCallback(
    (c: ComputerInfo) => {
      const ok = window.confirm(
        `Destroy ${c.id}? Its filesystem at ${c.nativeId ?? c.workdir} goes with it. This cannot be undone.`,
      );
      if (ok) void act(c.id, () => api.destroyComputer(c.id));
    },
    [act, api],
  );

  const rows = computers.list;

  return (
    <section className="panel" aria-labelledby="computers-title">
      <PanelHeader
        title="Computers"
        lede="Live from GET /v1/computers. Nothing is spun up in advance."
        actions={<Button onClick={computers.reload}>Refresh</Button>}
      />
      <span id="computers-title" className="visually-hidden">
        Computers
      </span>

      {actionError ? <ErrorBlock error={actionError} /> : null}
      {computers.error ? <ErrorBlock error={computers.error} retry={computers.reload} /> : null}

      {!computers.loaded && computers.loading && computers.slow ? (
        <StatusLine text="Listing computers from the provider…" />
      ) : null}
      {!computers.loaded && computers.showSkeleton && !computers.slow ? <Skeleton rows={5} /> : null}

      {computers.loaded && rows.length === 0 ? (
        <EmptyState
          title="No computers running."
          body="A computer starts the first time an agent needs one — nothing is spun up in advance. Create one below, or let a husk do it."
          command={'husk run "echo hello"'}
        />
      ) : null}

      {rows.length > 0 ? (
        <div className="table-scroll">
          <table className="data">
            <caption>
              {rows.length} computer{rows.length === 1 ? '' : 's'}. Select a row to point the Terminal and Files panels
              at it.
            </caption>
            <thead>
              <tr>
                <th scope="col">State</th>
                <th scope="col">ID</th>
                <th scope="col">Provider</th>
                <th scope="col">Isolation</th>
                <th scope="col">Image</th>
                <th scope="col">Workdir</th>
                <th scope="col">Created</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const provider = providerByName.get(c.provider);
                const busy = busyId === c.id;
                return (
                  <tr
                    key={c.id}
                    className="selectable"
                    aria-selected={c.id === activeId}
                    tabIndex={0}
                    onClick={() => onSelect(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(c.id);
                      }
                    }}
                  >
                    <td>
                      <StatusDot tone={stateTone(c.state)} label={c.state} />
                    </td>
                    <td className="mono">
                      {c.id}
                      {c.name && c.name !== c.id ? <span className="field-note"> · {c.name}</span> : null}
                    </td>
                    <td className="mono">{c.provider}</td>
                    <td>
                      {provider === undefined ? (
                        <Badge>unknown — doctor did not report this provider</Badge>
                      ) : (
                        <IsolationBadge isolated={provider.isolated} kind={provider.isolationKind} />
                      )}
                    </td>
                    <td className="mono">{c.image}</td>
                    <td className="mono">{c.workdir}</td>
                    <td className="mono tnum">{formatWhen(c.createdAt)}</td>
                    <td className="actions" onClick={(e) => e.stopPropagation()}>
                      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                        {c.state === 'running' ? (
                          <Button
                            size="sm"
                            loading={busy}
                            onClick={() => void act(c.id, () => api.stopComputer(c.id))}
                            aria-label={`Stop ${c.id}`}
                          >
                            Stop
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            loading={busy}
                            onClick={() => void act(c.id, () => api.startComputer(c.id))}
                            aria-label={`Start ${c.id}`}
                          >
                            Start
                          </Button>
                        )}
                        <Button size="sm" variant="danger" loading={busy} onClick={() => destroy(c)} aria-label={`Destroy ${c.id}`}>
                          Destroy
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {rows.some((c) => c.error) ? (
        <div className="section row-gap-2">
          {rows
            .filter((c) => c.error)
            .map((c) => (
              <ErrorBlock key={c.id} error={{ code: 'E_COMPUTER_FAILED', message: `${c.id}: ${c.error ?? ''}` }} />
            ))}
        </div>
      ) : null}

      <CreateComputer
        providers={doctor.data?.providers ?? []}
        doctorLoading={doctor.loading}
        onCreated={(c) => {
          onSelect(c.id);
          invalidate();
          computers.reload();
        }}
      />
    </section>
  );
}

function CreateComputer({
  providers,
  doctorLoading,
  onCreated,
}: {
  providers: DoctorReport['providers'];
  doctorLoading: boolean;
  onCreated: (c: ComputerInfo) => void;
}) {
  const { api } = useConnection();

  const [provider, setProvider] = useState('');
  const [flavor, setFlavor] = useState<Flavor>('base');
  const [network, setNetwork] = useState<NetworkMode>('egress');
  const [name, setName] = useState('');
  const [idleTimeoutSec, setIdleTimeoutSec] = useState('900');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);
  const [created, setCreated] = useState<ComputerInfo | null>(null);

  const chosen = providers.find((p) => p.name === provider);
  const idleInvalid = idleTimeoutSec !== '' && !/^\d+$/.test(idleTimeoutSec);

  const submit = useCallback(async () => {
    if (idleInvalid) return;
    setSubmitting(true);
    setError(null);
    setCreated(null);

    const spec: ComputerSpec = { flavor, network: { mode: network } };
    if (provider) spec.provider = provider;
    if (name.trim()) spec.name = name.trim();
    if (idleTimeoutSec !== '') spec.idleTimeoutSec = Number.parseInt(idleTimeoutSec, 10);

    try {
      const info = await api.createComputer(spec);
      setCreated(info);
      onCreated(info);
      setName('');
    } catch (err) {
      setError(toDisplayError(err));
    } finally {
      setSubmitting(false);
    }
  }, [api, flavor, idleInvalid, idleTimeoutSec, name, network, onCreated, provider]);

  return (
    <div className="section">
      <h2 id="create-computer">Create a computer</h2>
      <p className="hint">
        POST /v1/computers. The provider decides whether this is a sandbox or a guarded directory — the list below is
        what doctor says is actually usable on this machine.
      </p>

      <form
        className="form-grid"
        style={{ marginTop: 'var(--space-4)' }}
        id="create-computer-form"
        aria-labelledby="create-computer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Provider"
          htmlFor="cc-provider"
          note={doctorLoading && providers.length === 0 ? 'Asking doctor…' : chosen?.reason}
        >
          <select
            id="cc-provider"
            className="select"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="">auto (server picks the highest-priority available one)</option>
            {providers.map((p) => (
              <option key={p.name} value={p.name} disabled={!p.available}>
                {p.name}
                {p.available ? '' : ' — unavailable'}
                {` · ${isolationWord(p)}`}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Flavor" htmlFor="cc-flavor">
          <select
            id="cc-flavor"
            className="select"
            value={flavor}
            onChange={(e) => setFlavor(e.target.value as Flavor)}
          >
            {FLAVORS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Network" htmlFor="cc-network" note={network === 'full' ? 'Unrestricted egress.' : undefined}>
          <select
            id="cc-network"
            className="select"
            value={network}
            onChange={(e) => setNetwork(e.target.value as NetworkMode)}
          >
            <option value="none">none — no egress at all</option>
            <option value="egress">egress — allowlist only</option>
            <option value="full">full — unrestricted</option>
          </select>
        </Field>

        <Field label="Name" htmlFor="cc-name" note="Optional. Defaults to the generated id.">
          <input
            id="cc-name"
            className="input mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="scratch"
            maxLength={96}
          />
        </Field>

        <Field
          label="Idle timeout (s)"
          htmlFor="cc-idle"
          note={idleInvalid ? undefined : '0 disables the reaper.'}
        >
          <input
            id="cc-idle"
            className="input mono tnum"
            inputMode="numeric"
            value={idleTimeoutSec}
            aria-invalid={idleInvalid || undefined}
            aria-describedby={idleInvalid ? 'cc-idle-err' : undefined}
            onChange={(e) => setIdleTimeoutSec(e.target.value)}
          />
          {idleInvalid ? (
            <span id="cc-idle-err" className="field-note" style={{ color: 'var(--color-danger)' }}>
              Whole seconds only, e.g. 900.
            </span>
          ) : null}
        </Field>

      </form>

      <div className="btn-row" style={{ marginTop: 'var(--space-4)' }}>
        <Button
          type="submit"
          form="create-computer-form"
          variant="primary"
          loading={submitting}
          disabled={idleInvalid}
        >
          Create computer
        </Button>
      </div>

      {/*
        `isolated === false` and not `!chosen.isolated`: a provider that could
        not be probed reports `null`, and "we do not know" must not be shouted
        as "we know it is unsafe".
      */}
      {chosen && chosen.isolated === false ? (
        <div className="card warn-card" style={{ marginTop: 'var(--space-4)' }} role="note">
          <p>
            <strong>{chosen.name} is not isolated.</strong> Do not run untrusted code on it.
          </p>
          {/* The provider's own words, not a paraphrase of them. */}
          <p className="mono">{chosen.reason ?? 'process guardrails, not a sandbox'}</p>
        </div>
      ) : null}

      {submitting ? <StatusLine text="Creating the machine — first boot on a cold provider can take a while." /> : null}
      {error ? (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <ErrorBlock error={error} />
        </div>
      ) : null}
      {created ? (
        <p className="hint" role="status">
          Created <code>{created.id}</code> on <code>{created.provider}</code> — state <code>{created.state}</code>.
        </p>
      ) : null}
    </div>
  );
}
