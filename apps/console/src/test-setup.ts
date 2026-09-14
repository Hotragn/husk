/**
 * jsdom has no canvas, and xterm asks for one.
 *
 * The Terminal panel imports xterm, which calls `getContext('2d')` while
 * measuring a character cell. jsdom's `HTMLCanvasElement` throws "not
 * implemented" instead of returning a context, so any test that renders the
 * whole `<App />` -- the computer-list tests do -- fails inside a dependency
 * for a reason that has nothing to do with what it is asserting.
 *
 * The stub returns the small surface xterm touches during measurement. It is
 * deliberately not a canvas implementation: nothing here asserts on pixels, and
 * a fake that pretended to render would be worse than one that obviously does
 * not. Anything xterm calls beyond this should fail loudly rather than silently
 * return a plausible number.
 */
const context2d = {
  measureText: (text: string) => ({ width: text.length * 8 }),
  fillText: () => {},
  clearRect: () => {},
  fillRect: () => {},
  setTransform: () => {},
  scale: () => {},
  save: () => {},
  restore: () => {},
  translate: () => {},
  createLinearGradient: () => ({ addColorStop: () => {} }),
  getImageData: (_x: number, _y: number, w: number, h: number) => ({
    data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
    width: w,
    height: h,
  }),
  putImageData: () => {},
  drawImage: () => {},
  beginPath: () => {},
  closePath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  stroke: () => {},
  fill: () => {},
  canvas: null as unknown,
};

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null;
    return { ...context2d, canvas: this } as unknown as CanvasRenderingContext2D;
  } as HTMLCanvasElement['getContext'];
}

// xterm measures with this too, and jsdom returns zeroes for every box.
// Zero-width cells make it divide by zero and never settle.
if (typeof Element !== 'undefined') {
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    const r = realRect.call(this);
    if (r.width > 0 || r.height > 0) return r;
    return { ...r.toJSON?.(), x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 } as DOMRect;
  };
}
