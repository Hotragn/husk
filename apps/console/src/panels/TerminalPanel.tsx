/**
 * A real terminal over `WS /v1/computers/:id/terminal`, rendered with xterm.js.
 *
 * What the route actually is, so the UI does not lie about it:
 *
 * `docs/API.md` says the socket "carries raw bytes as stdin/stdout". It does
 * not. `packages/server/src/routes/computers.ts` sends JSON frames
 * (`ready` / `stdout` / `stderr` / `exit` / `error`) and treats each inbound
 * message as one whole command, run through `exec({ tty: true })`. There is no
 * persistent shell and no pty on the other end — the server's own comment says
 * so: "That is a real limitation and it is stated here rather than faked with a
 * half-working REPL."
 *
 * So: the transport is the documented websocket, the output is real bytes from
 * a real command with a real tty, and the line editing (echo, backspace,
 * history) happens here, because nothing upstream is echoing. The resize
 * control frame from `docs/API.md` is sent on every fit; the server logs it and
 * cannot apply it without a pty, and the status bar says exactly that rather
 * than implying the resize took effect.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useConnection } from '../state/connection';
import { useComputers } from '../state/computers';
import { computerGate } from './computerGate';
import { openManagedSocket } from '../api/sockets';
import type { ManagedSocket, SocketState } from '../api/sockets';
import { isTerminalFrame } from '../api/wire';
import type { TerminalResizeFrame } from '../api/wire';
import { Button, PanelHeader, StatusDot } from '../components/primitives';
import type { Theme } from '../state/theme';

// Control bytes, spelled out. Literal control characters in a source file
// survive exactly one careless editor.
const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const CTRL_L = String.fromCharCode(12);
const DEL = String.fromCharCode(127);
const BS = String.fromCharCode(8);

const dim = (s: string) => `${ESC}[38;5;244m${s}${ESC}[0m`;
const warn = (s: string) => `${ESC}[33m${s}${ESC}[0m`;
const fail = (s: string) => `${ESC}[31m${s}${ESC}[0m`;
const PROMPT = `${ESC}[38;5;180mhusk${ESC}[0m:${ESC}[38;5;44m/work${ESC}[0m$ `;
const CLEAR_LINE = `\r${ESC}[2K`;

/** Pull xterm's palette out of the tokens so there is no second source of colour. */
function themeFromTokens(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    background: v('--color-sunken'),
    foreground: v('--color-text-muted'),
    cursor: v('--color-text-accent'),
    cursorAccent: v('--color-sunken'),
    selectionBackground: v('--color-selection-bg'),
    selectionForeground: v('--color-selection-text'),
    black: v('--color-neutral-950'),
    red: v('--color-danger'),
    green: v('--color-success'),
    yellow: v('--color-warn'),
    blue: v('--color-info'),
    magenta: v('--color-primary-400'),
    cyan: v('--color-accent-400'),
    white: v('--color-neutral-200'),
    brightBlack: v('--color-neutral-700'),
    brightRed: v('--color-danger'),
    brightGreen: v('--color-success'),
    brightYellow: v('--color-warn'),
    brightBlue: v('--color-info'),
    brightMagenta: v('--color-primary-300'),
    brightCyan: v('--color-accent-300'),
    brightWhite: v('--color-text'),
  };
}

export function TerminalPanel({
  activeId,
  onSelect,
  theme,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
  theme: Theme;
}) {
  const { api } = useConnection();
  const computers = useComputers();
  const active = computers.list.find((c) => c.id === activeId) ?? null;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const socketRef = useRef<ManagedSocket | null>(null);
  const lineRef = useRef('');
  const historyRef = useRef<string[]>([]);
  const historyPosRef = useRef(-1);
  const busyRef = useRef(false);

  const [socketState, setSocketState] = useState<SocketState>('connecting');
  const [ready, setReady] = useState<{ workdir: string } | null>(null);
  const [dims, setDims] = useState<{ cols: number; rows: number } | null>(null);
  const [running, setRunning] = useState(false);

  const url = useMemo(
    () => (activeId ? api.socketUrl(`/v1/computers/${encodeURIComponent(activeId)}/terminal`) : null),
    [api, activeId],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !url) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const term = new Terminal({
      convertEol: true,
      // A blinking cursor is a loop, and §3 bans loops. Under reduced motion it
      // is a solid block instead; the cursor is still visible either way.
      cursorBlink: !reduced,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize: 13,
      theme: themeFromTokens(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;

    const send = (payload: string): boolean => socketRef.current?.send(payload) ?? false;

    const sendResize = () => {
      const frame: TerminalResizeFrame = { type: 'resize', cols: term.cols, rows: term.rows };
      send(JSON.stringify(frame));
      setDims({ cols: term.cols, rows: term.rows });
    };

    const socket = openManagedSocket(url, {
      onOpen() {
        sendResize();
      },
      onMessage(raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          // Not a frame we recognise. Show the bytes rather than swallow them.
          term.write(raw);
          return;
        }
        if (!isTerminalFrame(parsed)) return;

        switch (parsed.type) {
          case 'ready':
            setReady({ workdir: parsed.workdir });
            term.write(
              `${dim(`connected to ${parsed.computerId} — workdir ${parsed.workdir}`)}\r\n` +
                `${dim('one command per line; there is no persistent shell behind this socket')}\r\n` +
                PROMPT,
            );
            break;
          case 'stdout':
          case 'stderr':
            term.write(parsed.data);
            break;
          case 'exit':
            busyRef.current = false;
            setRunning(false);
            term.write(`${dim(`exit ${parsed.exitCode} · ${parsed.durationMs} ms`)}\r\n${PROMPT}`);
            break;
          case 'error':
            busyRef.current = false;
            setRunning(false);
            term.write(`\r\n${fail(parsed.error)}\r\n${PROMPT}`);
            break;
        }
      },
      onStateChange(state, retryIn) {
        setSocketState(state);
        if (state === 'closed') {
          busyRef.current = false;
          setRunning(false);
          setReady(null);
          term.write(
            `\r\n${warn(
              `terminal socket closed${retryIn ? ` — reconnecting in ${Math.round(retryIn / 1000)}s` : ''}`,
            )}\r\n`,
          );
        }
      },
    });
    socketRef.current = socket;

    // Escape and copy/paste are decided before xterm consumes the key.
    // Everything else, including pasted text, arrives through `onData`.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        term.blur();
        document.getElementById('term-escape-target')?.focus();
        return false;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c' && term.hasSelection()) return false;
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'v') return false;
      if (ev.key === 'Tab') return false; // a keyboard user must be able to leave
      return true;
    });

    const submitLine = () => {
      const line = lineRef.current;
      term.write('\r\n');
      lineRef.current = '';
      historyPosRef.current = -1;
      if (!line.trim()) {
        term.write(PROMPT);
        return;
      }
      historyRef.current = [line, ...historyRef.current].slice(0, 100);
      if (send(line)) {
        busyRef.current = true;
        setRunning(true);
      } else {
        term.write(`${warn('not connected — the command was not sent')}\r\n${PROMPT}`);
      }
    };

    const recallHistory = (direction: 1 | -1) => {
      const history = historyRef.current;
      if (history.length === 0) return;
      const next =
        direction === 1
          ? Math.min(historyPosRef.current + 1, history.length - 1)
          : Math.max(historyPosRef.current - 1, -1);
      historyPosRef.current = next;
      const replacement = next === -1 ? '' : (history[next] ?? '');
      term.write(`${CLEAR_LINE}${PROMPT}${replacement}`);
      lineRef.current = replacement;
    };

    const disposable = term.onData((data) => {
      // Ctrl-C clears the line the way a shell would. The socket gives us no
      // way to signal the child, so this does not claim to have killed it.
      if (data === CTRL_C) {
        term.write(`^C\r\n${PROMPT}`);
        lineRef.current = '';
        return;
      }
      if (data === CTRL_L) {
        term.clear();
        return;
      }
      if (busyRef.current) return;

      if (data === `${ESC}[A`) return recallHistory(1);
      if (data === `${ESC}[B`) return recallHistory(-1);
      // Append-only line editor: moving the cursor inside the line would
      // desynchronise the echo from the buffer, so those keys do nothing.
      if (data.startsWith(ESC)) return;

      for (const chunk of data.split(/(\r\n|\r|\n)/)) {
        if (chunk === '') continue;
        if (chunk === '\r' || chunk === '\n' || chunk === '\r\n') {
          submitLine();
          // A pasted block runs one line at a time; the socket is serial.
          if (busyRef.current) return;
          continue;
        }
        for (const ch of chunk) {
          if (ch === DEL || ch === BS) {
            if (lineRef.current.length > 0) {
              lineRef.current = lineRef.current.slice(0, -1);
              term.write(`${BS} ${BS}`);
            }
          } else if (ch >= ' ') {
            lineRef.current += ch;
            term.write(ch);
          }
        }
      }
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        sendResize();
      } catch {
        /* the host is detached mid-teardown */
      }
    });
    observer.observe(host);
    setDims({ cols: term.cols, rows: term.rows });

    return () => {
      observer.disconnect();
      disposable.dispose();
      socket.close();
      socketRef.current = null;
      term.dispose();
      termRef.current = null;
      busyRef.current = false;
    };
  }, [url]);

  // Theme is a runtime swap, not a remount: the scrollback survives it.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeFromTokens();
  }, [theme]);

  const reconnect = useCallback(() => socketRef.current?.retryNow(), []);

  const gate = computerGate({
    computers,
    title: 'Terminal',
    lede: 'WS /v1/computers/:id/terminal',
    emptyTitle: 'No computer to attach to.',
    emptyBody:
      "The terminal socket is per-machine, so there has to be a machine first. Create one on the Computers panel.",
  });
  if (gate) return <>{gate}</>;

  const socketTone = socketState === 'open' ? (ready ? 'success' : 'info') : socketState === 'connecting' ? 'info' : 'danger';
  const socketLabel =
    socketState === 'open' ? (ready ? 'connected' : 'handshaking') : socketState === 'connecting' ? 'connecting' : 'closed';

  return (
    <section className="panel" aria-labelledby="terminal-title">
      <PanelHeader
        title="Terminal"
        lede="A live websocket to the machine. Every byte below came back from a real command."
        actions={
          <>
            <label className="visually-hidden" htmlFor="term-computer">
              Computer
            </label>
            <select
              id="term-computer"
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
            <Button onClick={reconnect}>Reconnect</Button>
          </>
        }
      />
      <span id="terminal-title" className="visually-hidden">
        Terminal
      </span>

      {active && active.state !== 'running' ? (
        <div className="card warn-card" role="note" style={{ marginBottom: 'var(--space-4)' }}>
          <p>
            <strong>
              {active.id} is {active.state}.
            </strong>{' '}
            Commands will fail until it is started again.
          </p>
        </div>
      ) : null}

      <p className="narrow-only card warn-card" role="note">
        A terminal needs width. This one still works below 640px but wraps hard — open a wider window for real work.
      </p>

      <div className="term-frame">
        <div className="term-bar">
          <span className="inline-gap">
            <StatusDot tone={socketTone} label={socketLabel} />
            {running ? <span>running…</span> : null}
          </span>
          <span className="inline-gap">
            {dims ? (
              <span className="tnum">
                {dims.cols}×{dims.rows} — resize frame sent, logged not applied
              </span>
            ) : null}
            <span>Esc leaves the terminal</span>
          </span>
        </div>
        <div ref={hostRef} className="term-host" />
      </div>

      <p className="hint" id="term-escape-target" tabIndex={-1}>
        One command per line. Enter runs it; <kbd>Ctrl</kbd>+<kbd>C</kbd> clears the line; <kbd>Ctrl</kbd>+<kbd>L</kbd>{' '}
        clears the screen; <kbd>↑</kbd>/<kbd>↓</kbd> walk history; <kbd>Esc</kbd> returns focus to the page. There is no
        persistent shell behind this socket, so <code>cd</code> does not carry between commands — the server runs each
        line with <code>exec(tty: true)</code> in <code>{ready?.workdir ?? active?.workdir ?? '/work'}</code>. The{' '}
        <code>{'{"type":"resize"}'}</code> control frame is sent on every fit; the server records it and, having no pty,
        cannot act on it.
      </p>
    </section>
  );
}
