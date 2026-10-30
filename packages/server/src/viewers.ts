import type { WebSocket } from 'ws';

/** How far a viewer may fall behind, in bytes not yet sent, before it is treated as stuck. */
export const MAX_BEHIND = 4 * 1024 * 1024;

/**
 * Send to a viewer that is keeping up. A socket's unsent bytes wait in this
 * process's memory, and this process serves every chat: a viewer on a slow
 * link, or one that stopped reading, would grow it until it fell over.
 *
 * What the next message replaces -- a screen frame, an event the console also
 * polls for -- is dropped while the viewer catches up. What must not be lost,
 * a terminal's output, closes the socket instead (1013, try again later), and
 * the viewer reconnects. The bytes `ws` already holds are the only buffer.
 */
export function sendTo(socket: Pick<WebSocket, 'readyState' | 'OPEN' | 'bufferedAmount' | 'send' | 'close'>, data: string, opts: { droppable: boolean }): void {
  if (socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount > MAX_BEHIND) {
    if (!opts.droppable) socket.close(1013, 'the viewer fell too far behind; reconnect');
    return;
  }
  socket.send(data);
}
