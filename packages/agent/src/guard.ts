import { HuskError } from '@husk/core';
import type { Guardrails } from '@husk/core';

export interface CommandDecision {
  allowed: boolean;
  reason?: string;
  rule?: string;
}

function test(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text);
  } catch {
    // A user who typed a literal rather than a regex still meant something.
    return text.includes(pattern);
  }
}

/**
 * Apply this husk's own command guardrails.
 *
 * `@husk/runtime` owns the universal deny list (fork bombs, `mkfs`, `rm -rf /`)
 * and applies it inside every provider. This function only enforces the
 * per-husk rules from `husk.yaml`, which the runtime never sees.
 *
 * `allow` beats `deny`: an explicit allow entry is the operator saying they know
 * better about their own machine, and they do.
 */
export function evaluateCommand(cmd: string, guardrails: Pick<Guardrails, 'allowCommands' | 'denyCommands'>): CommandDecision {
  for (const a of guardrails.allowCommands ?? []) {
    if (test(a, cmd)) return { allowed: true };
  }
  for (const d of guardrails.denyCommands ?? []) {
    if (test(d, cmd)) {
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
