/**
 * `GET /v1/doctor`, rendered verbatim.
 *
 * Nothing here is summarised, ranked or softened. `husk doctor` is the product's
 * honesty surface: if a provider is unavailable the reason and the hint are the
 * two most useful strings on the page, and if the selected provider is not
 * isolated that has to be impossible to miss.
 */

import { useConnection } from '../state/connection';
import { useResource } from '../state/useResource';
import { Badge, Button, ErrorBlock, PanelHeader, Skeleton, StatusDot, StatusLine } from '../components/primitives';
import type { DoctorReport, IsolationKind } from '../api/wire';

export function DoctorPanel() {
  const { api, revision } = useConnection();
  const doctor = useResource<DoctorReport>((signal) => api.doctor(signal), [api, revision]);

  return (
    <section className="panel" aria-labelledby="doctor-title">
      <PanelHeader
        title="Doctor"
        lede="The honest state of this machine, exactly as GET /v1/doctor reports it."
        actions={<Button onClick={doctor.reload}>Re-probe</Button>}
      />
      <span id="doctor-title" className="visually-hidden">
        Doctor
      </span>

      {doctor.error ? <ErrorBlock error={doctor.error} retry={doctor.reload} /> : null}

      {!doctor.data && doctor.loading && doctor.slow ? (
        <StatusLine text="Probing providers — a cold `docker version` takes about 800 ms." />
      ) : null}
      {!doctor.data && doctor.showSkeleton && !doctor.slow ? <Skeleton rows={6} /> : null}

      {doctor.data ? <DoctorBody report={doctor.data} /> : null}
    </section>
  );
}

function DoctorBody({ report }: { report: DoctorReport }) {
  const selectedProvider = report.providers.find((p) => p.name === report.selection.provider);

  return (
    <div className="row-gap-4">
      {report.warnings.length > 0 ? (
        <div className="card warn-card" role="note">
          <h3>
            {report.warnings.length} warning{report.warnings.length === 1 ? '' : 's'}
          </h3>
          <ul className="list-plain" style={{ marginTop: 'var(--space-2)' }}>
            {report.warnings.map((w) => (
              <li key={w} style={{ color: 'var(--color-text)' }}>
                {w}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        The reason is the point. "husk picked local" is not actionable on its
        own; "local, because it is the highest-priority available provider" is,
        because it tells you that starting Docker would change the answer. The
        server sends the reason next to every choice, so it is rendered next to
        every choice.
      */}
      <div className="card">
        <h2>Selection</h2>
        <p className="hint">What husk would use right now, and why.</p>
        <dl className="kv" style={{ marginTop: 'var(--space-3)' }}>
          <dt>provider</dt>
          <dd>
            {report.selection.provider ?? 'none'}
            {selectedProvider ? (
              <>
                {' '}
                <IsolationBadge isolated={selectedProvider.isolated} kind={selectedProvider.isolationKind ?? undefined} />
              </>
            ) : null}
            <div className="field-note">{report.selection.providerReason}</div>
          </dd>
          <dt>model</dt>
          <dd>
            {report.selection.model ?? 'none — computers still work'}
            <div className="field-note">{report.selection.modelReason}</div>
          </dd>
          <dt>version</dt>
          <dd>{report.version}</dd>
          <dt>node</dt>
          <dd>
            {report.node} <span className="field-note">· {report.platform}</span>
          </dd>
          <dt>husk home</dt>
          <dd className="mono">
            {report.huskHome}
            {report.firstRun ? <span className="field-note"> · not created yet</span> : null}
          </dd>
        </dl>
      </div>

      <div>
        <h2 id="doctor-providers">Providers</h2>
        <div className="table-scroll" style={{ marginTop: 'var(--space-3)' }}>
          <table className="data">
            <caption>Where a computer can run. {report.providers.length} probed.</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Available</th>
                <th scope="col">Isolation</th>
                <th scope="col">Version</th>
                <th scope="col">Reason</th>
                <th scope="col">Hint</th>
              </tr>
            </thead>
            <tbody>
              {report.providers.map((p) => (
                <tr key={p.name}>
                  <td className="mono">
                    {p.name}
                    <div className="field-note">{p.description}</div>
                  </td>
                  <td>
                    <StatusDot tone={p.available ? 'success' : 'muted'} label={p.available ? 'yes' : 'no'} />
                  </td>
                  <td>
                    <IsolationBadge isolated={p.isolated} kind={p.isolationKind ?? undefined} />
                  </td>
                  <td className="mono">{p.version ?? '—'}</td>
                  <td>{p.reason ?? '—'}</td>
                  <td className="mono">{p.hint ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 id="doctor-models">Models</h2>
        <div className="table-scroll" style={{ marginTop: 'var(--space-3)' }}>
          <table className="data">
            <caption>Model providers. {report.models.filter((m) => m.available).length} available.</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Available</th>
                <th scope="col">Models</th>
                <th scope="col">Reason</th>
                <th scope="col">Hint</th>
              </tr>
            </thead>
            <tbody>
              {report.models.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.displayName}
                    <div className="field-note mono">
                      {m.id}
                      {m.envKey ? ` · ${m.envKey}` : ''}
                    </div>
                  </td>
                  <td>
                    <StatusDot tone={m.available ? 'success' : 'muted'} label={m.available ? 'yes' : 'no'} />
                  </td>
                  {/* The ids, not a count: the picker needs the string you would paste. */}
                  <td className="mono">{m.models.length > 0 ? m.models.join(', ') : '—'}</td>
                  <td>{m.reason ?? '—'}</td>
                  <td>{m.hint ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <details>
        <summary style={{ cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>
          Raw response
        </summary>
        <pre className="code" style={{ marginTop: 'var(--space-2)' }}>
          {JSON.stringify(report, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/**
 * The isolation label. Same three cases `husk doctor` prints, same words.
 *
 * A plain green "isolated" is a claim, so only `kernel` gets one. An ssh box is
 * isolated from *this* laptop and not from itself — the agent holds a real
 * shell on the far end — so `machine` says which boundary it means; those three
 * words cost nothing and prevent a genuine misreading. `guardrails` is not
 * isolation and says so.
 *
 * `isolated: false` is a security fact, so it is a filled warn badge with the
 * word in it, not a grey dash somewhere on the right. `isolated: null` means
 * the provider could not be probed at all, which is not the same as "no" and
 * is not rendered as one.
 */
export function IsolationBadge({ isolated, kind }: { isolated: boolean | null; kind?: IsolationKind | undefined }) {
  switch (kind) {
    case 'kernel':
      return <Badge tone="success">isolated</Badge>;
    case 'machine':
      return (
        <span className="status">
          <Badge tone="success">isolated from this machine</Badge>
          <span className="field-note">the agent still holds a shell on the far end</span>
        </span>
      );
    case 'guardrails':
      return <Badge tone="warn">not isolated — process guardrails only</Badge>;
    default:
      // No `isolationKind` on the wire: fall back to the coarse boolean, the
      // way the CLI does.
      if (isolated === null) return <Badge>unknown — the provider could not be probed</Badge>;
      return isolated ? (
        <Badge tone="success">isolated</Badge>
      ) : (
        <Badge tone="warn">not isolated — process guardrails only</Badge>
      );
  }
}
