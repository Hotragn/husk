import type { ServerContext } from './context.js';

/** How long a chat's computer may sit unused before it is stopped. Its files stay. */
export const CHAT_IDLE_MS = 10 * 60_000;

/**
 * Stop the chats' computers nothing has used for a while; the chat's next call
 * starts one again. With a shared Husk this is the only place a chat's computer
 * is stopped: the chat's own process cannot see a person holding it, and once
 * stopped Chromium in the middle of a login (F-04).
 *
 * Use is one rule, the computer's last-use mark: every exec, every browser call
 * and a person's input set it, from whichever process made them. On top of
 * that, never while someone holds the computer, while the AI is working on it,
 * or while its chat runs it in its own process, where that process decides.
 */
export async function stopIdleChats(ctx: ServerContext, now = Date.now(), idleMs = CHAT_IDLE_MS): Promise<string[]> {
  const stopped: string[] = [];
  const { handoffs } = ctx.runner;
  for (const info of await ctx.deps.manager.list()) {
    if (info.state !== 'running' || info.spec.labels?.['husk.via'] !== 'mcp') continue;
    if (now - Date.parse(info.lastUsedAt || info.createdAt) < idleMs) continue;
    if (handoffs.list().some((h) => h.computerId === info.id) || handoffs.control.busy(info.id) || ctx.inChat.has(info.id)) continue;
    const computer = await ctx.deps.manager.get(info.id);
    if (!computer) continue;
    await computer.stop();
    stopped.push(info.id);
    ctx.deps.log.info(`computer ${info.id} idle, stopped`);
  }
  return stopped;
}

/** Sweep once a minute. The returned function stops sweeping. */
export function startChatIdleStop(ctx: ServerContext, everyMs = 60_000): () => void {
  const timer = setInterval(() => {
    void stopIdleChats(ctx).catch((err: unknown) => ctx.deps.log.warn(`idle stop failed: ${(err as Error).message}`));
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
