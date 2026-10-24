/**
 * The console shell.
 *
 * Sidebar 256px, content on the remainder, `--container-2xl` overall — the
 * console row of the layout table in UI-PRINCIPLES §1. Seven panels, each backed
 * by a real endpoint; there is nothing here that renders without a server
 * behind it.
 */

import { useCallback, useEffect, useState } from 'react';
import { ConnectionProvider, useConnection } from './state/connection';
import { ComputersProvider, useComputers } from './state/computers';
import { useTheme } from './state/theme';
import { Button, Icon, StatusDot } from './components/primitives';
import { ComputersPanel } from './panels/ComputersPanel';
import { TerminalPanel } from './panels/TerminalPanel';
import { FilesPanel } from './panels/FilesPanel';
import { BrowserPanel } from './panels/BrowserPanel';
import { HandoffsPanel, LinkedComputer, LinkedHandoff, useHandoffs } from './panels/HandoffsPanel';
import { linkedComputerId, linkedHandoffId } from './state/viewerToken';
import { HusksPanel } from './panels/HusksPanel';
import { DoctorPanel } from './panels/DoctorPanel';
import { EventsPanel } from './panels/EventsPanel';
import { DisconnectedScreen } from './panels/DisconnectedScreen';
import { HomePanel } from './panels/HomePanel';
import { OverviewPanel } from './panels/OverviewPanel';
import { ChatPanel } from './panels/ChatPanel';
import { ConnectPanel } from './panels/ConnectPanel';

const PANELS = ['home', 'connect', 'chat', 'handoffs', 'computers', 'terminal', 'files', 'browser', 'husks', 'doctor', 'events'] as const;
type PanelId = (typeof PANELS)[number];

const PANEL_LABELS: Record<PanelId, string> = {
  home: 'Home',
  chat: 'Chat',
  connect: 'Connect',
  handoffs: 'Handoffs',
  computers: 'Computers',
  terminal: 'Terminal',
  files: 'Files',
  browser: 'Browser',
  husks: 'Husks',
  doctor: 'Doctor',
  events: 'Events',
};

function panelFromHash(): PanelId {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return (PANELS as readonly string[]).includes(raw) ? (raw as PanelId) : 'home';
}

export default function App() {
  return (
    <ConnectionProvider>
      <ConnectionShell />
    </ConnectionProvider>
  );
}

function ConnectionShell() {
  const { health, status, token, error, retryNow } = useConnection();
  const { theme, toggle } = useTheme();
  const handoffId = linkedHandoffId();
  const computerId = handoffId ? null : linkedComputerId();
  if (health && health.mode !== 'starter' && !handoffId && !computerId) return <ComputersProvider><Shell /></ComputersProvider>;
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="starter-app">
      <header className="starter-header"><a className="starter-brand" href="#main"><img src="/favicon.svg" alt="" width="22" height="22" /> Husk</a><div className="btn-row"><StatusDot pill tone={status === 'connected' ? 'success' : status === 'disconnected' ? 'danger' : 'info'} label={status === 'connected' ? 'Connected' : status === 'disconnected' ? 'Disconnected' : 'Connecting'} /><ThemeToggle theme={theme} toggle={toggle} /></div></header>
      {status === 'disconnected' && !token ? <DisconnectedScreen /> : <main id="main" className="starter-main" tabIndex={-1}>{status === 'disconnected' ? <section className="workspace-welcome"><h1>Reconnect to your workspace</h1><p>{error?.message ?? 'Husk is not responding.'} Open the workspace again from your AI app to reconnect. Your saved files stay on this device.</p><Button onClick={retryNow}>Try again</Button></section> : health ? (handoffId ? <LinkedHandoff handoffId={handoffId} /> : computerId ? <LinkedComputer /> : <HomePanel />) : <p role="status">Opening your workspace…</p>}</main>}
    </div>
  </>;
}

function ThemeToggle({ theme, toggle }: { theme: 'dark' | 'light'; toggle: () => void }) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <Button variant="ghost" className="btn-icon" onClick={toggle} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </Button>
  );
}

function Shell() {
  const { status, health, baseUrl } = useConnection();
  const { list: rows } = useComputers();
  // A computer the person took themselves is not waiting on them.
  const waiting = useHandoffs().list.filter((h) => h.runId !== 'person');
  const { theme, toggle } = useTheme();

  const [panel, setPanel] = useState<PanelId>(() => panelFromHash());
  const [activeComputer, setActiveComputer] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => {
      const raw = window.location.hash.replace(/^#\/?/, '');
      if ((PANELS as readonly string[]).includes(raw)) setPanel(raw as PanelId);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((next: PanelId) => {
    window.location.hash = `#/${next}`;
    setPanel(next);
  }, []);

  useEffect(() => {
    if (rows.length === 0) {
      setActiveComputer(null);
      return;
    }
    setActiveComputer((prev) => (prev && rows.some((c) => c.id === prev) ? prev : (rows[0]?.id ?? null)));
  }, [rows]);

  const connTone = status === 'connected' ? 'success' : status === 'connecting' ? 'info' : 'danger';
  const connLabel =
    status === 'connected'
      ? `Connected · v${health?.version ?? '?'}`
      : status === 'connecting'
        ? 'Connecting'
        : 'Not connected';

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <div className="app">
        <div className="app-brand">
          <img src="/favicon.svg" alt="" />
          <strong>Husk</strong>
        </div>

        <header className="app-header">
          <span className="conn" title={baseUrl}>
            <StatusDot pill tone={connTone} label={connLabel} />
          </span>
          <ThemeToggle theme={theme} toggle={toggle} />
        </header>

        <nav className="app-nav" aria-label="Console sections">
          <div>
            <p className="nav-section-label" id="nav-label">
              Workspace
            </p>
            <button type="button" className="nav-item" aria-current={panel === 'home' ? 'page' : undefined} onClick={() => go('home')}>Home</button>
            <button type="button" className="nav-item" aria-current={panel === 'connect' ? 'page' : undefined} onClick={() => go('connect')}>Connect</button>
            <details className="nav-advanced" open={panel !== 'home' || undefined}>
              <summary>Advanced</summary>
            <ul className="nav-list" aria-label="Advanced console sections">
              {PANELS.filter((id) => id !== 'home' && id !== 'chat' && id !== 'connect').map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    className="nav-item"
                    aria-current={panel === id ? 'page' : undefined}
                    onClick={() => go(id)}
                  >
                    <span>{PANEL_LABELS[id]}</span>
                    {id === 'computers' && rows.length > 0 ? <span className="count">{rows.length}</span> : null}
                    {id === 'handoffs' && waiting.length > 0 ? (
                      <span className="count count-alert" aria-label={`${waiting.length} waiting on you`}>{waiting.length}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
            </details>
          </div>
        </nav>

        {status === 'disconnected' ? (
          <DisconnectedScreen />
        ) : (
          <main id="main" className="app-main" tabIndex={-1}>
            {panel === 'home' ? (
              <OverviewPanel
                onOpen={(target, id) => {
                  setActiveComputer(id);
                  go(target);
                }}
              />
            ) : null}
            {panel === 'connect' ? <ConnectPanel /> : null}
            {panel === 'chat' ? (
              <ChatPanel
                computerId={activeComputer}
                onOpen={(target, id) => {
                  setActiveComputer(id);
                  go(target);
                }}
              />
            ) : null}
            {panel === 'computers' ? (
              <ComputersPanel activeId={activeComputer} onSelect={setActiveComputer} />
            ) : null}
            {panel === 'terminal' ? (
              <TerminalPanel activeId={activeComputer} onSelect={setActiveComputer} theme={theme} />
            ) : null}
            {panel === 'files' ? <FilesPanel activeId={activeComputer} onSelect={setActiveComputer} /> : null}
            {panel === 'browser' ? <BrowserPanel activeId={activeComputer} onSelect={setActiveComputer} /> : null}
            {panel === 'handoffs' ? <HandoffsPanel /> : null}
            {panel === 'husks' ? <HusksPanel /> : null}
            {panel === 'doctor' ? <DoctorPanel /> : null}
            {panel === 'events' ? <EventsPanel /> : null}
          </main>
        )}
      </div>
    </>
  );
}
