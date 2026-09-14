/**
 * Websocket plumbing.
 *
 * Two sockets, one policy: reconnect with capped exponential backoff, never
 * pretend a closed socket is an open one, and surface the delay so the UI can
 * say "retrying in 4s" instead of spinning.
 */

/** 1s, 2s, 4s, 8s, 16s, then 30s forever. Deterministic, so the UI can count it down. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}

export type SocketState = 'connecting' | 'open' | 'closed';

export interface ManagedSocketHandlers {
  onMessage(data: string): void;
  onOpen?(socket: WebSocket): void;
  onStateChange?(state: SocketState, nextRetryMs: number | null): void;
}

export interface ManagedSocket {
  send(data: string): boolean;
  /** Force an immediate reconnect attempt, cancelling any pending backoff. */
  retryNow(): void;
  close(): void;
  readonly state: SocketState;
}

/**
 * A websocket that reconnects.
 *
 * Deliberately not generic over the message type: both Husk sockets send JSON
 * text frames whose shape differs per route, and parsing belongs with the code
 * that knows which route it opened.
 */
export function openManagedSocket(url: string, handlers: ManagedSocketHandlers): ManagedSocket {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let state: SocketState = 'connecting';

  const setState = (next: SocketState, retryIn: number | null) => {
    state = next;
    handlers.onStateChange?.(next, retryIn);
  };

  const connect = () => {
    if (disposed) return;
    setState('connecting', null);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      schedule();
      return;
    }
    socket = ws;

    ws.addEventListener('open', () => {
      if (disposed) {
        ws.close();
        return;
      }
      attempt = 0;
      setState('open', null);
      handlers.onOpen?.(ws);
    });

    ws.addEventListener('message', (ev: MessageEvent<unknown>) => {
      if (typeof ev.data === 'string') handlers.onMessage(ev.data);
      else if (ev.data instanceof Blob) void ev.data.text().then(handlers.onMessage);
    });

    ws.addEventListener('close', () => {
      if (socket === ws) socket = null;
      if (disposed) return;
      schedule();
    });

    // `error` is always followed by `close`, so scheduling here would double up.
    ws.addEventListener('error', () => {});
  };

  const schedule = () => {
    if (disposed) return;
    const delay = backoffMs(attempt);
    attempt += 1;
    setState('closed', delay);
    timer = setTimeout(connect, delay);
  };

  connect();

  return {
    send(data: string): boolean {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(data);
        return true;
      }
      return false;
    },
    retryNow(): void {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      attempt = 0;
      if (socket) {
        socket.close();
        socket = null;
      }
      connect();
    },
    close(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      // Closing a socket that is still CONNECTING is legal but makes Chrome
      // log "WebSocket is closed before the connection is established". React
      // StrictMode's double-mount hits that path on every reload, so the
      // still-opening socket is left to the `open` handler, which sees
      // `disposed` and closes it cleanly.
      if (socket && socket.readyState === WebSocket.OPEN) socket.close();
      socket = null;
      state = 'closed';
    },
    get state(): SocketState {
      return state;
    },
  };
}
