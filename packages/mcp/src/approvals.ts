import { createHash } from 'node:crypto';
import { redact } from '@husk-ai/core';
import type { Verdict } from '@husk-ai/server';

/**
 * Which calls a remote chat makes only with the owner's word (J6-c), and how
 * each is put to them. The same tools Husk's own agent marks dangerous (its
 * shell, file writes, clicks and typing), plus what does the same through the
 * browser in bulk: a select, an upload, several steps, a script.
 */
export const DANGEROUS_TOOLS: ReadonlySet<string> = new Set([
  'shell',
  'write_file',
  'edit_file',
  'expose_port',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_upload',
  'browser_run',
  'browser_script',
]);

const text = (v: unknown, max = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return redact(s.length > max ? `${s.slice(0, max)}…` : s);
};

/** One line the owner can judge the call by. Never what it would type: that may be a secret. */
export function summarize(tool: string, args: Record<string, unknown>): string {
  const where = text(args.ref ?? args.selector ?? args.element ?? args.target ?? '', 120);
  switch (tool) {
    case 'shell':
      return `$ ${text(args.command)}`;
    case 'write_file':
      return `write ${text(args.path, 200)} (${String(args.content ?? '').length} characters${args.append === true ? ', appended' : ''})`;
    case 'edit_file':
      return `edit ${text(args.path, 200)}`;
    case 'expose_port':
      return `publish port ${text(args.port, 10)}`;
    case 'browser_type':
      return `type ${String(args.text ?? '').length} characters into ${where}`;
    case 'browser_click':
      return `click ${where}`;
    case 'browser_select':
      return `choose ${text(args.values ?? args.value, 120)} in ${where}`;
    case 'browser_upload':
      return `upload ${text(args.paths ?? args.path, 200)} to ${where}`;
    case 'browser_run':
      return `${Array.isArray(args.steps) ? args.steps.length : 'several'} browser steps`;
    case 'browser_script':
      return `a browser script of ${String(args.script ?? args.code ?? '').split('\n').length} lines`;
    default:
      return `${tool} ${text(args, 200)}`;
  }
}

/** The call itself, so an approval covers that call alone: the same tool on the same computer with the same arguments. */
export function digestOf(tool: string, computerId: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify([tool, computerId, args])).digest('hex');
}

/**
 * What the model is told when a call waits for the owner, or was refused by
 * them. It names the computer: a first call that said computer: "new" made it,
 * and asking for "new" again would make another, for a call nobody approved.
 */
export function approvalText(tool: string, verdict: Exclude<Verdict, { ok: true }>, computerId: string): string {
  if (verdict.state === 'denied') return `The owner did not approve this ${tool} call, and nothing ran. Do not try it again unless the user asks.`;
  if (!verdict.link) return 'Too many calls are waiting for the owner’s approval. Ask the user to answer the open ones, then try again.';
  const again = `once they say they have, call ${tool} again with exactly the same arguments and computer: "${computerId}".`;
  if (verdict.state === 'waiting') return `Still waiting for the owner’s approval at ${verdict.link} -- ${again}`;
  return `Nothing has run yet: ${tool} needs this Husk owner’s approval. Give the user this link to approve it with their passkey: ${verdict.link} -- then, ${again}`;
}
