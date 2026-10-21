/**
 * A computer's browser, as an image the person can take and use.
 *
 * Not held, a click on it offers Take over. Held, it is the person's mouse and
 * keyboard on the page: clicks, the wheel, keys and typed text go to the page,
 * a point on the image mapped to the frame's own width and height.
 *
 * What a person types here is usually a password or a one-time code. It lands
 * in a hidden password field that is emptied at once, waits in memory only
 * while a burst of keys is batched into one request, and is never logged,
 * stored or put in React state. Tab is left to the browser, so the keyboard can
 * always leave the screen; the Tab button sends one to the page.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { HandoffInput, HandoffKey } from '../api/wire';
import { Button } from './primitives';

export interface Frame {
  src: string;
  /** The page's CSS viewport, which a click maps back to. */
  width: number;
  height: number;
}

const KEYS = new Set<string>(['Enter', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
/** The server's limit on one text input. */
const TEXT_MAX = 2000;
/** Keys typed within this long of each other go as one request. */
const BATCH_MS = 40;

/**
 * Inputs reach the page in the order they were made, one request at a time,
 * with a burst of typing sent as one text. `send` reports its own errors.
 */
export function useInputQueue(send: (input: HandoffInput) => Promise<void>): (input: HandoffInput) => void {
  const chain = useRef<Promise<void>>(Promise.resolve());
  const text = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      text.current = '';
    },
    [send],
  );
  return useCallback(
    (input: HandoffInput) => {
      const push = (next: HandoffInput) => {
        chain.current = chain.current.then(() => send(next)).catch(() => undefined);
      };
      const flush = () => {
        clearTimeout(timer.current);
        while (text.current) {
          push({ type: 'text', text: text.current.slice(0, TEXT_MAX) });
          text.current = text.current.slice(TEXT_MAX);
        }
      };
      if (input.type === 'text') {
        text.current += input.text;
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, BATCH_MS);
        return;
      }
      flush();
      push(input);
    },
    [send],
  );
}

export function Screen({
  frame,
  alt,
  note,
  control,
  onTakeOver,
  taking = false,
  className,
}: {
  frame: Frame | null;
  alt: string;
  /** Said where there is no frame, or under one. */
  note?: string | undefined;
  /** Held: where the person's input goes. */
  control?: ((input: HandoffInput) => void) | undefined;
  /** Not held: Take over, offered when the screen is clicked. */
  onTakeOver?: (() => void) | undefined;
  taking?: boolean;
  className?: string;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const keysRef = useRef<HTMLInputElement | null>(null);
  const [offer, setOffer] = useState(false);
  // The wheel listener is attached once per image; it reads the latest of these.
  const latest = useRef({ frame, control });
  useEffect(() => {
    latest.current = { frame, control };
  });

  /** Where on the page a point on the image is, in the page's own CSS pixels. */
  const toPage = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const img = imgRef.current;
    const f = latest.current.frame;
    if (!img || !f || f.width <= 0 || f.height <= 0) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((clientX - rect.left) / rect.width) * f.width;
    const y = ((clientY - rect.top) / rect.height) * f.height;
    return { x: Math.min(f.width, Math.max(0, Math.round(x))), y: Math.min(f.height, Math.max(0, Math.round(y))) };
  }, []);

  const hasImage = Boolean(frame);
  const held = Boolean(control);
  // React's wheel listener is passive, so it cannot stop the console scrolling under the page. This one is not.
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !held) return;
    const onWheel = (e: WheelEvent) => {
      const at = toPage(e.clientX, e.clientY);
      const send = latest.current.control;
      if (!at || !send) return;
      e.preventDefault();
      send({ type: 'scroll', ...at, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
    };
    img.addEventListener('wheel', onWheel, { passive: false });
    return () => img.removeEventListener('wheel', onWheel);
  }, [hasImage, held, toPage]);

  const click = (e: ReactMouseEvent, extra: { button?: 'right'; double?: boolean } = {}) => {
    if (!control) return;
    const at = toPage(e.clientX, e.clientY);
    if (at) control({ type: 'click', ...at, ...extra });
    keysRef.current?.focus({ preventScroll: true });
  };
  const typed = (el: HTMLInputElement) => {
    const value = el.value;
    el.value = '';
    if (value && control) control({ type: 'text', text: value });
  };

  return (
    <figure className={['screen', held ? 'screen-held' : '', className ?? ''].filter(Boolean).join(' ')}>
      {frame ? (
        <img
          ref={imgRef}
          src={frame.src}
          width={frame.width || undefined}
          height={frame.height || undefined}
          alt={alt}
          draggable={false}
          onClick={(e) => click(e)}
          onDoubleClick={(e) => click(e, { double: true })}
          onContextMenu={(e) => {
            if (!control) return;
            e.preventDefault();
            click(e, { button: 'right' });
          }}
        />
      ) : (
        <div className="screen-empty" role="status">
          {note}
        </div>
      )}

      {control ? (
        <input
          ref={keysRef}
          className="screen-keys"
          type="password"
          aria-label="Type into the page"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.ctrlKey || e.metaKey || e.altKey || !KEYS.has(e.key)) return;
            e.preventDefault();
            control({ type: 'key', key: e.key as HandoffKey });
          }}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            if (!(e.nativeEvent as InputEvent).isComposing) typed(e.currentTarget);
          }}
          onCompositionEnd={(e) => typed(e.currentTarget)}
        />
      ) : null}

      {!control && onTakeOver && frame && !offer ? (
        <button type="button" className="screen-hit" aria-label="Take over this computer" onClick={() => setOffer(true)} />
      ) : null}

      {offer && !control && onTakeOver ? (
        <div
          className="screen-offer"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOffer(false);
          }}
        >
          <div className="screen-offer-card" role="group" aria-label="Take over">
            <strong>Take over this computer?</strong>
            <p>The chat pauses until you give it back.</p>
            <div className="btn-row">
              <Button
                variant="accent"
                loading={taking}
                onClick={() => {
                  setOffer(false);
                  onTakeOver();
                }}
                autoFocus
              >
                Take over
              </Button>
              <Button variant="ghost" onClick={() => setOffer(false)}>
                Not now
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </figure>
  );
}
