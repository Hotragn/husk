import type { GetPromptResult, Prompt } from '@modelcontextprotocol/sdk/types.js';

/**
 * One-click starters. Each is a short, visible template the user sends as their
 * own message -- not a hidden system prompt. Claude Code lists them as
 * `/husk:<name>` (https://code.claude.com/docs/en/mcp); claude.ai and Claude
 * Desktop show them under the connector in the "+" menu
 * (https://claude.com/docs/connectors/building).
 */
interface Starter extends Prompt {
  render(args: Record<string, string>): string;
}

const STARTERS: Starter[] = [
  {
    name: 'setup_project',
    title: 'Set up a project',
    description: 'Install and run a project on your Husk computer.',
    arguments: [{ name: 'what', description: 'What to set up, e.g. "a FastAPI hello world" or a repo URL.', required: true }],
    render: ({ what }) =>
      `Set up ${what} on my Husk computer. Check computer_info first, install what it needs in /work, ` +
      `run it once to show it works, and tell me how to run it again.`,
  },
  {
    name: 'research_topic',
    title: 'Research a topic with sources',
    description: 'Read real pages and answer with citations.',
    arguments: [{ name: 'topic', description: 'What to research.', required: true }],
    render: ({ topic }) =>
      `Research ${topic} using my Husk computer. Use browse for public pages and browser_goto for pages that need ` +
      `JavaScript. Give me a short answer that cites the URLs you actually read, and say what you could not find.`,
  },
  {
    name: 'fill_web_form',
    title: 'Fill out a web form with me',
    description: 'Fill a form together; you handle logins and anything sensitive.',
    arguments: [{ name: 'url', description: 'The page with the form.', required: true }],
    render: ({ url }) =>
      `Help me fill out the form at ${url}. Open it with browser_goto, take a browser_snapshot, and fill in what ` +
      `you can from what I tell you; ask me for anything missing. For a login, password, code, CAPTCHA or payment ` +
      `details, call hand_off and let me do it. Show me what you filled in, and submit only when I say so.`,
  },
];

export const PROMPTS: Prompt[] = STARTERS.map(({ render: _r, ...p }) => p);

export function getPrompt(name: string, args: Record<string, string> = {}): GetPromptResult {
  const starter = STARTERS.find((s) => s.name === name);
  if (!starter) throw new Error(`Unknown prompt "${name}".`);
  for (const a of starter.arguments ?? []) {
    if (a.required && !args[a.name]?.trim()) throw new Error(`The "${a.name}" argument is required.`);
  }
  // Arguments are the user's own text going into their own message; trimmed and capped, nothing more.
  const clean = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v).trim().slice(0, 2000)]));
  return {
    description: starter.description,
    messages: [{ role: 'user', content: { type: 'text', text: starter.render(clean) } }],
  };
}
