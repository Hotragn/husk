/**
 * Connect: where chats' computers run, and which chat apps use Husk.
 *
 * The same choices as `husk setup`. The computer choice is written into each
 * app's launch line when it is connected, so changing it means connecting the
 * apps again; the page says so rather than pretending it applies by itself.
 * Every change names the file it edits and the backup it made.
 */

import { useState } from 'react';
import { toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import type { ChatApp, ComputerChoice, ConnectResult, SetupState } from '../api/wire';
import { Badge, Button, ErrorBlock, PanelHeader, StatusDot } from '../components/primitives';
import { useConnection } from '../state/connection';
import { useResource } from '../state/useResource';

const CONTAINERS = new Set(['docker', 'podman']);

export function ConnectPanel() {
  const { api, revision } = useConnection();
  const state = useResource<SetupState>((signal) => api.setupState(signal), [api, revision]);
  const [provider, setProvider] = useState<string | null>(null);
  const [browser, setBrowser] = useState(true);
  const [results, setResults] = useState<Record<string, ConnectResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [test, setTest] = useState<{ ok: boolean; provider: string; output: string; ms: number } | null>(null);

  const computers = state.data?.computers ?? [];
  const recommended = computers.find((c) => c.available && c.isolated) ?? computers.find((c) => c.available);
  const chosen = provider ?? recommended?.name ?? 'auto';
  const choice: ComputerChoice = {
    provider: chosen,
    ...(CONTAINERS.has(chosen) && browser ? { flavor: 'full' as const } : {}),
  };

  const act = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(toDisplayError(err));
    } finally {
      setBusy(null);
    }
  };
  const connect = (app: ChatApp) =>
    act(app.id, async () => {
      const r = await api.connectApp(app.id, choice);
      setResults((m) => ({ ...m, [app.id]: r }));
      state.reload();
    });
  const disconnect = (app: ChatApp) =>
    act(app.id, async () => {
      const r = await api.disconnectApp(app.id);
      setResults((m) => ({ ...m, [app.id]: r }));
      state.reload();
    });

  return (
    <section className="panel" aria-label="Connect">
      <PanelHeader title="Connect" />
      {state.error ? <ErrorBlock error={state.error} retry={state.reload} /> : null}
      {error ? <ErrorBlock error={error} /> : null}

      <div className="connect-grid">
      <fieldset className="card connect-computers">
        <legend className="h-sub">Where computers run</legend>
        {computers.map((c) => (
          <label key={c.name} className={`connect-option${c.available ? '' : ' connect-option-off'}`}>
            <input
              type="radio"
              name="computer"
              value={c.name}
              disabled={!c.available}
              checked={chosen === c.name}
              onChange={() => setProvider(c.name)}
            />
            <span className="connect-option-body">
              <span className="connect-option-title">
                <strong>{c.name}</strong>
                {c === recommended ? <Badge tone="success">recommended</Badge> : null}
                {c.available ? c.isolated ? <Badge>isolated</Badge> : <Badge tone="warn">not isolated</Badge> : null}
              </span>
              <span className="field-note">{c.available ? c.description : (c.reason ?? 'not available here')}</span>
              {!c.available && c.hint ? <span className="field-note mono">Fix: {c.hint}</span> : null}
            </span>
          </label>
        ))}
        {CONTAINERS.has(chosen) ? (
          <label className="connect-option connect-option-plain">
            <input
              type="checkbox"
              checked={browser}
              onChange={(e) => setBrowser(e.target.checked)}
              aria-label="Include a browser"
            />
            <span>Include a browser</span>
          </label>
        ) : null}
        <div className="btn-row">
          <Button
            size="sm"
            loading={busy === 'test'}
            onClick={() => void act('test', async () => setTest(await api.testComputer(choice)))}
          >
            Test this computer
          </Button>
          {test ? (
            <span role="status" className="field-note">
              {test.ok ? '✓' : '✗'} {test.provider} answered in {(test.ms / 1000).toFixed(1)} s: <code className="mono">{test.output}</code>
            </span>
          ) : null}
        </div>
      </fieldset>

      <div className="card connect-apps">
        <h2 className="h-sub">Chat apps</h2>
        <p className="field-note">Connecting uses the computer you chose. Changed it? Connect again.</p>
        <ul className="connect-list">
          {(state.data?.apps ?? []).map((app) => {
            const r = results[app.id];
            return (
              <li key={app.id}>
                <div className="connect-row">
                  <StatusDot
                    tone={app.connected ? 'success' : app.found ? 'info' : 'muted'}
                    label={app.connected ? 'connected' : app.found ? 'found' : 'not found'}
                  />
                  <strong>{app.name}</strong>
                  <div className="btn-row">
                    {app.found || app.connected ? (
                      <Button
                        size="sm"
                        variant={app.connected ? 'secondary' : 'primary'}
                        loading={busy === app.id}
                        onClick={() => void connect(app)}
                        aria-label={`${app.connected ? 'Connect again' : 'Connect'} ${app.name}`}
                      >
                        {app.connected ? 'Connect again' : 'Connect'}
                      </Button>
                    ) : null}
                    {app.connected ? (
                      <Button size="sm" onClick={() => void disconnect(app)} aria-label={`Disconnect ${app.name}`}>
                        Disconnect
                      </Button>
                    ) : null}
                  </div>
                </div>
                <code className="mono field-note">{app.where}</code>
                {r ? (
                  <p role="status" className={r.ok ? 'field-note' : 'field-note connect-failed'}>
                    {r.message}
                    {r.backup ? ` Backup: ${r.backup}` : ''}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      </div>
    </section>
  );
}
