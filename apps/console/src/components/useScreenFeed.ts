import { useEffect, useState } from 'react';
import type { ScreenMessage } from '../api/wire';
import { useConnection } from '../state/connection';
import type { Frame } from './Screen';

/**
 * A computer's browser, live, while this page is visible: the newest frame,
 * or what to say instead of one. The socket is closed whenever the page is
 * hidden, since a screen nobody is looking at is a frame stream for nothing.
 * `fps` below the server's 4 is for a small screen among many; `enabled: false`
 * opens nothing at all.
 */
export function useScreenFeed(id: string, { fps, enabled = true }: { fps?: number; enabled?: boolean } = {}) {
  const { api } = useConnection();
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [frame, setFrame] = useState<Frame | null>(null);
  const [note, setNote] = useState<string>('Connecting…');

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (!visible) {
      setNote('Paused while this tab is hidden.');
      return;
    }
    const ws = new WebSocket(api.socketUrl(`/v1/computers/${encodeURIComponent(id)}/screen${fps ? `?fps=${fps}` : ''}`));
    ws.onmessage = (ev) => {
      let msg: ScreenMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ScreenMessage;
      } catch {
        return;
      }
      if (msg.type === 'frame') {
        setFrame({ src: `data:image/jpeg;base64,${msg.data}`, width: msg.width, height: msg.height });
        setNote('');
      } else if (msg.type === 'idle') {
        setFrame(null);
        setNote('No browser open yet. It appears here when the chat opens a page.');
      } else {
        setNote(msg.message);
      }
    };
    ws.onclose = () => setNote((n) => n || 'The screen disconnected. It reconnects when you come back to this tab.');
    return () => ws.close();
  }, [api, id, visible, fps, enabled]);

  return { frame, note };
}
