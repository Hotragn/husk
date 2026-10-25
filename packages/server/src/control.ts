import { livePageFor } from '@husk-ai/browser';
import { refusalText, stoppedText } from './handoffs.js';
import type { HandoffRegistry, PageMark } from './handoffs.js';

/**
 * An AI call on a computer, under the person's control. Chats come through
 * here from the tool route and from their own process; a husk run's tools from
 * the runner. The control itself, and its rules, are in handoffs.ts.
 */

/** The page in a computer's browser, read without starting one; undefined when there is none or it does not answer. */
export async function pageMark(computerId: string): Promise<PageMark | undefined> {
  const page = livePageFor(computerId);
  if (!page) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), 5_000)));
  try {
    const raw = await Promise.race([page.evaluate('JSON.stringify([location.href, document.title])'), late]);
    if (typeof raw !== 'string') return undefined;
    const [url, title] = JSON.parse(raw) as unknown[];
    return { tab: page.targetId, url: String(url ?? ''), title: String(title ?? '') };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** A call let in, with the signal it runs under, or why it was not. */
export type Admitted =
  | { refused: string }
  | {
      signal: AbortSignal;
      done(): void;
      /** The text for a call a person's take-over cut off, with what it printed by then; undefined if none did. */
      stopped(printed?: string): string | undefined;
    };

/**
 * Let one AI call onto a computer: refused while someone holds it, or when it
 * acts on a page the person changed, and otherwise tracked, so a take-over
 * stops it part-way. Tracked before the first await, so no take-over misses it.
 */
export async function admitCall(registry: HandoffRegistry, computerId: string, tool: string, signal?: AbortSignal): Promise<Admitted> {
  const call = registry.control.start(computerId, tool, signal);
  const holder = () => registry.list().find((h) => h.computerId === computerId);
  const refuse = (text: string): Admitted => {
    call.done();
    return { refused: text };
  };
  // Taken after the caller looked: a take-over that did not see this call yet.
  const held = tool === 'computer_info' ? undefined : holder();
  if (held) return refuse(refusalText(held));
  const why = await registry.control.refusal(computerId, tool, () => pageMark(computerId));
  if (call.takenOver()) return refuse(stoppedText(holder()?.handoffId));
  if (why) return refuse(why);
  return {
    signal: call.signal,
    done: call.done,
    stopped: (printed) => (call.takenOver() ? stoppedText(holder()?.handoffId, printed) : undefined),
  };
}

type TextResult = { isError: true; content: Array<{ type: 'text'; text: string }> };
const refused = (text: string): TextResult => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * One chat call on a computer, under the person's control: a take-over stops
 * it part-way and says so, and after Give back a browser action meant for a
 * page the person changed is refused with what changed.
 */
export async function underControl<R extends { content: Array<{ type: string }>; isError?: boolean }>(
  registry: HandoffRegistry,
  computerId: string,
  tool: string,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<R>,
): Promise<R | TextResult> {
  const admitted = await admitCall(registry, computerId, tool, signal);
  if ('refused' in admitted) return refused(admitted.refused);
  try {
    const result = await run(admitted.signal);
    // A command's output up to the stop is worth keeping; a browser call's error is not.
    const printed = tool === 'shell' ? (result.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text : undefined;
    const stop = admitted.stopped(printed);
    return stop ? refused(stop) : result;
  } finally {
    admitted.done();
  }
}
