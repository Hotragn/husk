import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import * as ui from '../ui.js';

/**
 * Terminal prompts.
 *
 * Everything a prompt writes goes to stderr, so a command that also emits JSON
 * cannot be broken by asking a question. Nothing here ever runs when stdin is
 * not a terminal -- a CLI that blocks forever waiting for input inside CI is one
 * of the worst failure modes there is, so callers must pass a default instead.
 */
export function interactive(): boolean {
  return stdin.isTTY === true && stderr.isTTY === true;
}

interface Session {
  ask(question: string, fallback?: string): Promise<string>;
  close(): void;
}

export function session(): Session {
  const rl = createInterface({ input: stdin, output: stderr, terminal: true });
  return {
    async ask(question, fallback = '') {
      const suffix = fallback ? ui.dim(` (${fallback})`) : '';
      const answer = (await rl.question(`${ui.cyan('?')} ${question}${suffix} `)).trim();
      return answer || fallback;
    },
    close() {
      rl.close();
    },
  };
}

export async function ask(question: string, fallback = ''): Promise<string> {
  const s = session();
  try {
    return await s.ask(question, fallback);
  } finally {
    s.close();
  }
}

/**
 * A yes/no gate on something destructive.
 *
 * `assumeYes` short-circuits it, and a non-interactive stdin refuses rather than
 * assuming. Defaulting to yes in a script is how people lose data.
 */
export async function confirm(
  question: string,
  opts: { assumeYes?: boolean; defaultYes?: boolean } = {},
): Promise<boolean> {
  if (opts.assumeYes) return true;
  if (!interactive()) return false;
  const suffix = opts.defaultYes ? 'Y/n' : 'y/N';
  const answer = (await ask(`${question} ${ui.dim('[' + suffix + ']')}`)).toLowerCase();
  if (!answer) return opts.defaultYes === true;
  return answer === 'y' || answer === 'yes';
}

/** Pick one of a numbered list. Returns the index, or -1 when the user declines. */
export async function choose(prompt: string, count: number): Promise<number> {
  if (!interactive() || count === 0) return -1;
  const s = session();
  try {
    for (;;) {
      const raw = await s.ask(`${prompt} ${ui.dim(`[1-${count}, or q to quit]`)}`);
      if (!raw || raw.toLowerCase() === 'q') return -1;
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= count) return n - 1;
      ui.warn(`pick a number between 1 and ${count}`);
    }
  } finally {
    s.close();
  }
}

/** Read all of stdin when it is piped. Returns undefined on a terminal. */
export async function readPipedStdin(): Promise<string | undefined> {
  if (stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length ? text : undefined;
}

export { stdout };
