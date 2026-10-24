/**
 * Every claim in this file is one the product can back up: the facts come from
 * README.md, docs/ARCHITECTURE.md, docs/SECURITY-MODEL.md or a real session
 * transcript, and the wording is plain English rather than the identifiers in
 * the code. Rewording is fine; inventing a capability is not. See BRAND.md §5.
 */

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, "");

export const REPO_URL = "https://github.com/Hotragn/husk";
export const PREVIEW_RELEASE_URL = `${REPO_URL}/releases/tag/preview-0.2.0`;
/**
 * Where the Docs link in the nav goes: docs.huskai.dev from a production build,
 * the docs dev server under `next dev` -- running both at once is the normal
 * case when a link crosses between them, and a production URL in dev is a link
 * never exercised locally. `NEXT_PUBLIC_DOCS_URL` overrides both.
 */
export const DOCS_URL = stripTrailingSlash(
  process.env.NEXT_PUBLIC_DOCS_URL ??
    (process.env.NODE_ENV === "production"
      ? "https://docs.huskai.dev"
      : "http://localhost:3001"),
);
export const LICENCE = "Apache-2.0";
export const WORKSPACE_GUIDE_URL = `${DOCS_URL}/start/workspaces`;

export const SITE_DESCRIPTION =
  "Husk gives your AI chat a computer: a terminal, files and a browser it can use to do the work. Keep what it finds in a workspace and pick it up later. Free and open source, no account needed.";

export const MCP_COMMAND = "claude mcp add husk -- npx -y @husk-ai/mcp";

/* -----------------------------------------------------------------------------
   Providers — docs/ARCHITECTURE.md "Provider selection" and README.md
   "Isolation: what you actually get". The isolation column is the whole point
   of the table, so it is a word plus a glyph plus a hue, never a hue alone.
-------------------------------------------------------------------------------- */

export type IsolationKind = "kernel" | "none" | "unknown";

export interface Provider {
  /** Value passed to `--provider`. */
  id: string;
  /** How the shell behaves in the isolation viewer. */
  shell: "sealed" | "open" | "partial";
  isolationKind: IsolationKind;
  /** Short label used in the table and the viewer readout. */
  isolation: string;
  /** The mechanism, named. "Isolated" on its own is meaningless. BRAND.md §5. */
  mechanism: string;
  cost: string;
  when: string;
}

export const PROVIDERS: Provider[] = [
  {
    id: "docker",
    shell: "sealed",
    isolationKind: "kernel",
    isolation: "isolated",
    mechanism:
      "its own container with no admin rights, read-only system files and a short list of allowed system calls",
    cost: "free, local",
    when: "the default when Docker is running",
  },
  {
    id: "podman",
    shell: "sealed",
    isolationKind: "kernel",
    isolation: "isolated",
    mechanism: "the same as Docker, without needing admin rights to run",
    cost: "free, local",
    when: "Linux machines without Docker",
  },
  {
    id: "local",
    shell: "open",
    isolationKind: "none",
    isolation: "guardrails only",
    mechanism:
      "a folder it can’t leave, API keys hidden from it, a short list of blocked commands, and a time limit",
    cost: "free, local",
    when: "when nothing else is available",
  },
  {
    id: "ssh",
    shell: "partial",
    isolationKind: "unknown",
    isolation: "depends on the machine",
    mechanism: "whatever machine you point it at; Husk can’t see how that one is set up, so it doesn’t guess",
    cost: "free if you own the box",
    when: "a free Oracle Cloud server, a Raspberry Pi, a VPS",
  },
  {
    id: "fly",
    shell: "sealed",
    isolationKind: "kernel",
    isolation: "isolated (VM)",
    mechanism: "a small virtual machine on Fly.io, not a container on your own computer",
    cost: "metered",
    when: "lots of work at once, without using your own machine",
  },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function providerById(id: string): Provider {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/* -----------------------------------------------------------------------------
   The verified transcript. This ran on a Windows laptop with no Docker daemon
   and no API key. It is replayed character by character because it genuinely
   arrived that way; the full text is in the DOM from first paint.
-------------------------------------------------------------------------------- */

export type LineKind =
  | "prompt"
  | "out"
  | "dim"
  | "ok"
  | "err"
  | "key"
  | "blank";

export interface TermLine {
  kind: LineKind;
  text: string;
  /** Characters per second for the replay. Input is typed, output arrives. */
  rate?: number;
}

export const TRANSCRIPT: TermLine[] = [
  { kind: "prompt", text: "$ husk up demo --provider local", rate: 42 },
  { kind: "ok", text: "✓ demo is up", rate: 260 },
  { kind: "dim", text: "  provider   local  (WSL2 (Ubuntu))", rate: 420 },
  { kind: "dim", text: "  isolation  guardrails only — not a sandbox", rate: 420 },
  { kind: "dim", text: "  workdir    /work", rate: 420 },
  { kind: "blank", text: "" },
  {
    kind: "prompt",
    text: "$ husk exec demo -- 'uname -sr; echo hello > /work/note.txt; cat /work/note.txt'",
    rate: 55,
  },
  { kind: "out", text: "Linux 6.18.33.2-microsoft-standard-WSL2", rate: 420 },
  { kind: "out", text: "hello", rate: 420 },
  { kind: "blank", text: "" },
  { kind: "prompt", text: "$ husk exec demo -- 'sudo rm -rf /'", rate: 42 },
  { kind: "err", text: "error refused: privilege escalation", rate: 300 },
  {
    kind: "dim",
    text: "hint:  add a pattern to guardrails.allowCommands in husk.yaml if this is intentional",
    rate: 420,
  },
];

export const TRANSCRIPT_TEXT = TRANSCRIPT.map((l) => l.text).join("\n");

/**
 * An illustrative provider report. The bad news sits in the same table as
 * the good news, in the same type, at the same weight. Do not present this as
 * literal current CLI output: providers and installed versions vary by device.
 */
export const DOCTOR: TermLine[] = [
  { kind: "prompt", text: "$ husk doctor" },
  { kind: "blank", text: "" },
  { kind: "out", text: "example report · your providers may differ" },
  { kind: "blank", text: "" },
  { kind: "out", text: "computer providers" },
  {
    kind: "dim",
    text: "  docker      unavailable   the daemon is not reachable",
  },
  { kind: "dim", text: "  podman      not found" },
  { kind: "out", text: "  local       ready         guarded working directory" },
  {
    kind: "dim",
    text: "                          ~/.husk/workspaces -- guardrails, not a sandbox",
  },
  { kind: "blank", text: "" },
  { kind: "out", text: "model providers" },
  { kind: "out", text: "  ollama      ready         gemma3, qwen2.5-coder" },
  { kind: "dim", text: "  anthropic   no key        set ANTHROPIC_API_KEY" },
  { kind: "blank", text: "" },
  {
    kind: "key",
    text: "selected      local + ollama/gemma3       free, on this machine, no account",
  },
  { kind: "blank", text: "" },
  { kind: "dim", text: "no product telemetry; tasks may contact the services they use." },
];

/** README.md, "Turn a chat into a bot". */
export const DISTILL: TermLine[] = [
  {
    kind: "prompt",
    text: "$ husk import                            # find your transcripts",
  },
  {
    kind: "prompt",
    text: "$ husk distill tr_01hxyz --out triage.yaml   # chat -> agent spec",
  },
  { kind: "prompt", text: '$ husk run triage.yaml "check the build"' },
  {
    kind: "prompt",
    text: "$ husk serve                             # http, discord, cron, cli",
  },
];

/* -----------------------------------------------------------------------------
   husk.yaml — examples/ci-triage.yaml, trimmed to one screen.
-------------------------------------------------------------------------------- */

export const HUSK_YAML = `# Distilled from a Claude Code session where I kept asking the same
# questions about red builds. Most of the persona is text I had already
# typed into the chat four separate times.
apiVersion: husk/v1
name: ci-triage
model: sonnet
# Falls through to a local model rather than failing when the key is
# rate limited.
fallbackModels: [flash, gemma]

persona: |
  You triage CI failures for a TypeScript monorepo.

  Always read the failing job's log before forming an opinion. Quote the
  first line that actually failed -- not the last line, which is usually
  the runner giving up.

  Never rerun a job more than once. If it fails twice the same way, it is
  not a flake.

tools: [computer, files]

computer:
  flavor: node
  network:
    mode: egress
    allow: ['*.github.com']
  idleTimeoutSec: 600

limits: { maxSteps: 24, maxCostUsd: 0.25 }

triggers:
  - { type: http }
  - { type: cron, schedule: '*/15 * * * *', prompt: 'any red builds?' }
`;

/* -----------------------------------------------------------------------------
   MCP tool surface — README.md "Give Claude Code a computer".
-------------------------------------------------------------------------------- */

/**
 * Keep in step with `packages/mcp` — this list is a promise, not a summary.
 *
 * It was a summary for a while, and that is why BROWSER_TOOLS exists below.
 * `packages/mcp/src/tools.ts` spreads `...BROWSER_TOOLS` into the same list the
 * model sees, so a reader who counted seven here and thirteen more there would
 * have caught the site short.
 */
export const MCP_TOOLS: Array<{ name: string; what: string }> = [
  { name: "shell", what: "run a command and get back what it printed" },
  { name: "read_file", what: "read a file in the workspace" },
  { name: "write_file", what: "write a file in the workspace" },
  { name: "edit_file", what: "change one exact piece of text, and stop if it isn’t there or appears twice" },
  { name: "list_dir", what: "list a directory" },
  { name: "expose_port", what: "open up a server your AI started, so you can visit it" },
  { name: "computer_info", what: "what the machine has: CPU, memory, disk and network, so your AI doesn’t have to poke around" },
];

/**
 * The browser, from `packages/mcp/src/browser-tools.ts`. Five of thirteen — the
 * five that make the shape obvious. A real Chromium inside the computer, driven
 * by structured page text rather than by pixels, which is why an agent can use
 * it without seeing.
 */
export const BROWSER_TOOLS: Array<{ name: string; what: string }> = [
  { name: "browser_goto", what: "open a page and get back its text" },
  { name: "browser_snapshot", what: "list what on the page can be read or clicked" },
  { name: "browser_click", what: "click something from that list" },
  { name: "browser_type", what: "type into a field" },
  { name: "browser_screenshot", what: "take a screenshot, to check a layout or show you" },
];

/** Thirteen ship; the list above is the first five. */
export const BROWSER_TOOL_COUNT = 13;

/**
 * The first three prompts, in the order that proves the most fastest.
 *
 * The install is one line and then the page stops talking, which is the gap
 * this fills: a reader who has just run `claude mcp add husk` has a computer
 * and no idea what changed. Each of these is answerable only by a machine that
 * really exists -- a kernel string the model cannot invent, a file that is
 * still there on the next turn, a port you can open in your own browser.
 */
export const ONBOARDING: Array<{ ask: string; what: string }> = [
  {
    ask: "What kernel are you on?",
    what: "It runs a command on the machine and reads the answer back. You get Linux, on a computer that didn’t exist a second ago, and not an answer your AI could have made up.",
  },
  {
    ask: "Write a note to /work/note.txt, then read it back next turn.",
    what: "The file is still there next turn, and for the rest of the conversation. You don’t have to keep track of anything.",
  },
  {
    ask: "Start a web server and give me the URL.",
    what: "It starts the server and hands you a link you can open in your own browser. That’s usually when it sinks in that there’s a real computer there.",
  },
];
