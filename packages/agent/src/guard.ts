import { HuskError, matchesOutside } from '@husk-ai/core';
import type { Guardrails } from '@husk-ai/core';

export interface CommandDecision {
  allowed: boolean;
  reason?: string;
  rule?: string;
}

/**
 * Apply this husk's own command guardrails.
 *
 * `@husk-ai/runtime` owns the universal deny list (fork bombs, `mkfs`, `rm -rf /`)
 * and applies it inside every provider, with these same lists, which
 * `computerSpecFor` hands the computer when it is made. This check reads them
 * from today's `husk.yaml`, so a deny entry added since holds on a computer
 * made before it, too.
 *
 * `allow` beats `deny`: an explicit allow entry is the operator saying they know
 * better about their own machine, and they do. It beats it where it matches,
 * not over the whole line, as in the runtime.
 */
export function evaluateCommand(cmd: string, guardrails: Pick<Guardrails, 'allowCommands' | 'denyCommands'>): CommandDecision {
  for (const d of guardrails.denyCommands ?? []) {
    if (matchesOutside(d, cmd, guardrails.allowCommands ?? [])) {
      return { allowed: false, reason: 'matched a deny rule from this husk', rule: d };
    }
  }
  return { allowed: true };
}

export function assertCommandAllowed(
  cmd: string,
  guardrails: Pick<Guardrails, 'allowCommands' | 'denyCommands'>,
): void {
  const d = evaluateCommand(cmd, guardrails);
  if (d.allowed) return;
  throw new HuskError('E_EXEC_DENIED', `refused: ${d.reason}`, {
    hint: 'add a matching pattern to guardrails.allowCommands in husk.yaml if this is intentional',
    details: { rule: d.rule },
  });
}
