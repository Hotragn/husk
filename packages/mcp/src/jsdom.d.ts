// Just enough of jsdom's API for card-view.test.ts, so the package does not need
// @types/jsdom for one test. jsdom itself is a dev dependency.
declare module 'jsdom' {
  interface CardWindow {
    document: { querySelector(selector: string): { textContent: string | null; click(): void } | null };
    dispatchEvent(event: unknown): boolean;
    MessageEvent: new (type: string, init: { data: unknown; source: unknown }) => unknown;
    close(): void;
  }
  export class JSDOM {
    constructor(html?: string, options?: { runScripts?: 'dangerously'; beforeParse?(window: object): void });
    readonly window: CardWindow;
  }
}
