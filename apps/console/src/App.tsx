/**
 * The console shell.
 *
 * Sidebar 256px, content on the remainder, `--container-2xl` overall — the
 * console row of the layout table in UI-PRINCIPLES §1. Seven panels, each backed
 * by a real endpoint; there is nothing here that renders without a server
 * behind it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnectionProvider, useConnection } from './state/connection';
import { useTheme } from './state/theme';
import { useResource } from './state/useResource';
import type { ComputerInfo } from './api/wire';
import { Button, StatusDot } from './components/primitives';
import { ComputersPanel } from './panels/ComputersPanel';
import { TerminalPanel } from './panels/TerminalPanel';
import { FilesPanel } from './panels/FilesPanel';
import { BrowserPanel } from './panels/BrowserPanel';
import { HusksPanel } from './panels/HusksPanel';
import { DoctorPanel } from './panels/DoctorPanel';
import { EventsPanel } from './panels/EventsPanel';
import { DisconnectedScreen } from './panels/DisconnectedScreen';

const PANELS = ['computers', 'terminal', 'files', 'browser', 'husks', 'doctor', 'events'] as const;
type PanelId = (typeof PANELS)[number];

const PANEL_LABELS: Record<PanelId, string> = {
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
  return (PANELS as readonly string[]).includes(raw) ? (raw as PanelId) : 'computers';
}

export default function App() {
  return (
    <ConnectionProvider>
      <Shell />
    </ConnectionProvider>
  );
}

function Shell() {
  const { status, health, api, revision, baseUrl } = useConnection();
  const { theme, toggle } = useTheme();

  const [panel, setPanel] = useState<PanelId>(() => panelFromHash());
  const [activeComputer, setActiveComputer] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setPanel(panelFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((next: PanelId) => {
    window.location.hash = `#/${next}`;
    setPanel(next);
  }, []);

  // One list, shared by the panels that need a machine to point at. Fetched
  // here so switching panels does not refetch it, and refreshed by the event
  // bus rather than by polling.
  const computers = useResource<ComputerInfo[]>(
    (signal) => api.listComputers(signal),
    [api, revision],
    status === 'connected',
  );
  const rows = useMemo(() => computers.data ?? [], [computers.data]);

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
      ? `connected · v${health?.version ?? '?'}`
      : status === 'connecting'
        ? 'connecting'
        : 'not connected';

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <div className="app">
        <div className="app-brand">
          <strong>Husk</strong>
          <span>console</span>
        </div>

        <header className="app-header">
          <span className="conn">
            <StatusDot tone={connTone} label={connLabel} />
            <code className="mono field-note">{baseUrl}</code>
          </span>
          <Button
            onClick={toggle}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            aria-pressed={theme === 'light'}
          >
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </Button>
        </header>

        <nav className="app-nav" aria-label="Console sections">
          <div>
            <p className="nav-section-label" id="nav-label">
              Control plane
            </p>
            <ul className="nav-list" aria-labelledby="nav-label">
              {PANELS.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    className="nav-item"
                    aria-current={panel === id ? 'page' : undefined}
                    onClick={() => go(id)}
                  >
                    <span>{PANEL_LABELS[id]}</span>
                    {id === 'computers' && rows.length > 0 ? <span className="count">{rows.length}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        {status === 'disconnected' ? (
          <DisconnectedScreen />
        ) : (
          <main id="main" className="app-main" tabIndex={-1}>
            {panel === 'computers' ? (
              <ComputersPanel activeId={activeComputer} onSelect={setActiveComputer} />
            ) : null}
            {panel === 'terminal' ? (
              <TerminalPanel computers={rows} activeId={activeComputer} onSelect={setActiveComputer} theme={theme} />
            ) : null}
            {panel === 'files' ? (
              <FilesPanel computers={rows} activeId={activeComputer} onSelect={setActiveComputer} />
            ) : null}
            {panel === 'browser' ? (
              <BrowserPanel computers={rows} activeId={activeComputer} onSelect={setActiveComputer} />
            ) : null}
            {panel === 'husks' ? <HusksPanel /> : null}
            {panel === 'doctor' ? <DoctorPanel /> : null}
            {panel === 'events' ? <EventsPanel /> : null}
          </main>
        )}
      </div>
    </>
  );
}
