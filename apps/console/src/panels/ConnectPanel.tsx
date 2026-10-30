/**
 * Connect: where chats' computers run, and which chat apps use Husk.
 *
 * The same choices as `husk setup`. The computer choice is written into each
 * app's launch line when it is connected, so changing it means connecting the
 * apps again; the page says so rather than pretending it applies by itself.
 * Every change names the file it edits and the backup it made. Below them:
 * chat apps on the web, when this Husk was started with remote access.
 */

import { useState } from 'react';
import { toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import type { ChatApp, ComputerChoice, ConnectResult, RemoteStatus, SetupState } from '../api/wire';
import { Badge, Button, ErrorBlock, PanelHeader, StatusDot } from '../components/primitives';
import { useConnection } from '../state/connection';
import { useResource } from '../state/useResource';
import type { Resource } from '../state/useResource';
import { setupPrompt } from './setupPrompt';

const CONTAINERS = new Set(['docker', 'podman']);
const REMOTE_GUIDE = 'https://github.com/Hotragn/husk/blob/main/apps/docs/content/guides/remote-access.mdx';

export function ConnectPanel() {
  const { api, revision } = useConnection();
  const state = useResource<SetupState>((signal) => api.setupState(signal), [api, revision]);
  const remote = useResource<RemoteStatus | null>((signal) => api.remoteStatus(signal), [api, revision]);
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

  const act = async (key: string, run: () => Promise<unknown>) => {
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
            // An entry from 0.1.4, or another install: Update moves it here, keeping its own flags and env.
            const verb = app.outdated ? 'Update' : app.connected ? 'Connect again' : 'Connect';
            return (
              <li key={app.id}>
                <div className="connect-row">
                  <StatusDot
                    tone={app.outdated ? 'warn' : app.connected ? 'success' : app.found ? 'info' : 'muted'}
                    label={app.outdated ? 'older Husk' : app.connected ? 'connected' : app.found ? 'found' : 'not found'}
                  />
                  <strong>{app.name}</strong>
                  <div className="btn-row">
                    {app.found || app.connected ? (
                      <Button
                        size="sm"
                        variant={app.connected && !app.outdated ? 'secondary' : 'primary'}
                        loading={busy === app.id}
                        onClick={() => void connect(app)}
                        aria-label={`${verb} ${app.name}`}
                      >
                        {verb}
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

      <SetupFromChat apps={state.data?.apps ?? []} />
      <RemoteAccess remote={remote} busy={busy} act={(key, run) => act(key, async () => { await run(); remote.reload(); })} />
    </section>
  );
}

/**
 * claude.ai and ChatGPT reaching this Husk through a public HTTPS name
 * (`husk serve --remote`): whether it is on and why not, the one owner, the
 * apps signed in, advisories against this install, and what those apps and
 * the tunnel can see.
 */
function RemoteAccess({ remote, busy, act }: { remote: Resource<RemoteStatus | null>; busy: string | null; act: (key: string, run: () => Promise<unknown>) => Promise<void> }) {
  const { api } = useConnection();
  const [code, setCode] = useState<string | null>(null);
  const s = remote.data;
  if (remote.loading && !s) return null;
  if (!s) {
    return (
      <div className="card connect-remote">
        <h2 className="h-sub">Chat apps on the web</h2>
        {remote.error ? <ErrorBlock error={remote.error} retry={remote.reload} /> : null}
        <p className="field-note">
          claude.ai and ChatGPT can use this Husk through a public HTTPS name you own. It is off: start Husk with{' '}
          <code className="mono">husk serve --remote --public-url https://&lt;your name&gt;</code> behind a tunnel.{' '}
          <a href={REMOTE_GUIDE} target="_blank" rel="noreferrer">How to set it up</a>
        </p>
      </div>
    );
  }
  const severe = (a: RemoteStatus['advisories'][number]) => a.severity === 'high' || a.severity === 'critical';
  const switchOff = () => {
    if (window.confirm('Switch remote access off? Every chat app is signed out, and none can reach this Husk until you switch it on again.')) {
      void act('remote-switch', () => api.remoteSwitch(false));
    }
  };
  const startOver = () => {
    if (window.confirm('Forget the owner, every app and every token? You get a new claim code.')) {
      void act('remote-reset', async () => setCode((await api.remoteReset()).code));
    }
  };
  return (
    <div className="card connect-remote">
      <h2 className="h-sub">Chat apps on the web</h2>
      <div className="connect-row">
        <StatusDot tone={s.on ? 'success' : 'warn'} label={s.on ? 'Remote access on' : 'Remote access off'} />
        <code className="mono">{s.publicUrl}</code>
        <div className="btn-row">
          {s.on ? (
            <Button size="sm" loading={busy === 'remote-switch'} onClick={switchOff}>
              Switch off
            </Button>
          ) : (
            <Button size="sm" variant="primary" loading={busy === 'remote-switch'} onClick={() => void act('remote-switch', () => api.remoteSwitch(true))}>
              Switch on
            </Button>
          )}
        </div>
      </div>
      {s.offReason ? <p role="status" className="field-note connect-failed">{s.offReason}</p> : null}
      <p className="field-note">
        Add <code className="mono">{s.endpoint}</code> as a custom connector in claude.ai, or as an MCP server in ChatGPT&rsquo;s developer mode.
      </p>

      {s.owner ? (
        <p className="field-note">An owner has claimed this Husk and signs in with a passkey. Commands, file changes and browser actions wait for their passkey too.</p>
      ) : (
        <div className="btn-row">
          <Button size="sm" variant="primary" loading={busy === 'remote-claim'} onClick={() => void act('remote-claim', async () => setCode((await api.remoteClaim()).code))}>
            Make a claim code
          </Button>
          <span className="field-note">No owner yet. Whoever types the code first on the sign-in page a chat app opens becomes the owner.</span>
        </div>
      )}
      {code && !s.owner ? (
        <p role="status">
          Claim code <strong className="mono">{code}</strong> <span className="field-note">good for 15 minutes and 5 tries</span>
        </p>
      ) : null}

      {s.apps.length ? (
        <ul className="connect-list" aria-label="Apps signed in">
          {s.apps.map((a) => (
            <li key={a.id}>
              <div className="connect-row">
                <StatusDot tone="success" label="signed in" />
                <strong>{a.name}</strong>
                <div className="btn-row">
                  <Button size="sm" loading={busy === `remote-${a.id}`} onClick={() => void act(`remote-${a.id}`, () => api.remoteSignOut(a.id))} aria-label={`Sign out ${a.name}`}>
                    Sign out
                  </Button>
                </div>
              </div>
              <span className="field-note">since {new Date(a.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-note">No app is signed in.</p>
      )}

      {s.advisories.length ? (
        <ul className="connect-list" aria-label="Advisories">
          {s.advisories.map((a) => (
            <li key={`${a.name} ${a.url} ${a.title}`}>
              <span>
                <Badge tone={severe(a) ? 'danger' : 'warn'}>{a.severity}</Badge>{' '}
                {a.url.startsWith('https://') ? <a href={a.url} target="_blank" rel="noreferrer">{a.title}</a> : a.title}
              </span>
              <span className="field-note mono">
                {a.name}@{a.version}
                {a.vulnerable ? `, affected: ${a.vulnerable}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {s.advisories.some(severe) ? <p className="field-note connect-failed">Remote access stays off until Husk is upgraded past these.</p> : null}
      {s.checkError ? <p className="field-note">Husk could not check for advisories ({s.checkError}), and tries again every hour.</p> : null}

      <ul className="field-note connect-told">
        <li>The chat app sees everything the tools return: shell output, files, page text and screenshots, under that app&rsquo;s own policies. What you type during a hand-off goes to the browser on this computer, not to the chat.</li>
        <li>Your tunnel can read it too, unless it is Tailscale Funnel or ngrok with agent termination.</li>
      </ul>
      <div className="btn-row">
        <Button size="sm" loading={busy === 'remote-reset'} onClick={startOver}>
          Start over
        </Button>
      </div>
    </div>
  );
}

/**
 * The other way in: a prompt to paste into a chat, which then sets Husk up
 * itself with the same `husk setup` this page drives.
 */
function SetupFromChat({ apps }: { apps: ChatApp[] }) {
  const [appId, setAppId] = useState('all');
  const [copied, setCopied] = useState(false);
  const app = apps.find((a) => a.id === appId);
  const prompt = setupPrompt(app ? { id: app.id, name: app.name } : undefined);
  const copy = () =>
    void navigator.clipboard.writeText(prompt).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  return (
    <div className="card connect-prompt">
      <h2 className="h-sub">Or let your chat set it up</h2>
      <p className="field-note">Paste this into the chat. It runs the setup, then tells you to restart the app.</p>
      <label className="connect-prompt-app">
        <span>Chat app</span>
        <select
          value={appId}
          onChange={(e) => {
            setAppId(e.target.value);
            setCopied(false);
          }}
        >
          <option value="all">Every chat app here</option>
          {apps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <textarea className="connect-prompt-text mono" readOnly value={prompt} rows={9} aria-label="Setup prompt" />
      <div className="btn-row">
        <Button variant="primary" onClick={copy}>
          {copied ? 'Copied' : 'Copy prompt'}
        </Button>
      </div>
    </div>
  );
}
