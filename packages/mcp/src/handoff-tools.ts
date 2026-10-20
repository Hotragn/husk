import type { ToolDef } from './tools.js';

/** Long enough for a sentence a person can act on, short enough to read in a banner. Same as the agent tool. */
export const MAX_REASON = 500;

export const HANDOFF_TOOLS: ToolDef[] = [
  {
    name: 'hand_off',
    description:
      'Hand the computer to the user for something only they should do: a login, a 2FA code, a CAPTCHA, ' +
      'a payment or consent prompt. Never solve a CAPTCHA or type their credentials yourself. ' +
      'Give one sentence they can act on. The computer is theirs until they say they are done; ' +
      'until then every other computer tool refuses.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          maxLength: MAX_REASON,
          description: 'One sentence telling the user what to do, e.g. "Sign in to github.com and approve the prompt."',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'hand_off_done',
    description:
      'Take the computer back after a hand_off. Call it only once the user has told you in this chat that ' +
      'they are done -- never on your own, and never because time has passed.',
    inputSchema: {
      type: 'object',
      properties: { handoff: { type: 'string', description: 'The handoff id hand_off returned.' } },
      required: ['handoff'],
    },
  },
];

export const HANDOFF_TOOL_NAMES = new Set(HANDOFF_TOOLS.map((t) => t.name));

/** What the model reads back once the person has finished. */
export const HANDED_BACK =
  'The user says they are done and the computer is yours again. The page may have changed while they had it: ' +
  'take a browser_snapshot before you act.';

/** For a client with no in-chat prompt, or a prompt the user dismissed: the model relays the link and waits. */
export function relayText(handoffId: string, reason: string, link: string): string {
  return (
    `Handoff ${handoffId} is open and the computer is the user's until they finish.\n` +
    `Tell the user, in one message: "${reason} Open this link on this device to see and use the computer's ` +
    `browser: ${link} -- then tell me when you're done."\n` +
    `Then stop and wait for their reply. When they say they are done, call hand_off_done with handoff ` +
    `"${handoffId}". Do not call it on your own or because time has passed.`
  );
}

/** Who is holding the computer, for a tool call made while a handoff is open. */
export function heldText(handoffId: string, reason: string): string {
  return (
    `The user has the computer right now (handoff ${handoffId}: ${reason}). Wait for them to tell you they are ` +
    `done, then call hand_off_done with handoff "${handoffId}". Do not use the computer until then.`
  );
}
