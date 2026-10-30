import { describe, expect, it } from 'vitest';
import { MAX_BEHIND, sendTo } from './viewers.js';

/** A socket that is this many bytes behind, recording what it is sent and whether it is closed. */
function viewer(behind: number) {
  const sent: string[] = [];
  const closed: Array<{ code: number; reason: string }> = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: behind,
    send: (data: string) => void sent.push(data),
    close: (code: number, reason: string) => void closed.push({ code, reason }),
  };
  return { socket: socket as never, sent, closed, set: (n: number) => void (socket.bufferedAmount = n) };
}

describe('a viewer that falls behind', () => {
  it('gets everything while it keeps up', () => {
    const v = viewer(0);
    sendTo(v.socket, 'frame', { droppable: true });
    sendTo(v.socket, 'output', { droppable: false });
    expect(v.sent).toEqual(['frame', 'output']);
  });

  it('misses screen frames and events it is too far behind for, and stays connected', () => {
    const v = viewer(MAX_BEHIND + 1);
    sendTo(v.socket, 'frame', { droppable: true });
    expect(v.sent).toEqual([]);
    expect(v.closed).toEqual([]);
    v.set(0);
    sendTo(v.socket, 'newer frame', { droppable: true });
    expect(v.sent).toEqual(['newer frame']);
  });

  it('is disconnected, told to reconnect, rather than lose terminal output', () => {
    const v = viewer(MAX_BEHIND + 1);
    sendTo(v.socket, 'output', { droppable: false });
    expect(v.sent).toEqual([]);
    expect(v.closed).toEqual([{ code: 1013, reason: expect.stringContaining('reconnect') }]);
  });
});
