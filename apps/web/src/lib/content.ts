/**
 * Every string in this file is quoted from the repository — README.md,
 * docs/ARCHITECTURE.md, docs/SECURITY-MODEL.md, brand/voice-examples.md or a
 * real session transcript. Nothing here is invented, and nothing here is a
 * claim the product cannot make. See BRAND.md §5.
 */

/**
 * `SITE_URL` is deliberately not here. It reads Vercel's `VERCEL_*` variables,
 * which are not `NEXT_PUBLIC_` and are therefore `undefined` in a client
 * bundle -- and this file is imported by client components. It lives in
 * `lib/site-url.ts`, which only server code may import.
 */
const stripTrailingSlash = (url: string) => url.replace(/\/+$/, "");

export const REPO_URL = "https://github.com/Hotragn/husk";
/**
 * Where the Docs link in the nav goes.
 *
 * Set NEXT_PUBLIC_DOCS_URL on this project to the docs deployment. It is a
 * second variable rather than a guess derived from SITE_URL, because the two
 * sites are two Vercel projects on unrelated hostnames today and only become
 * `example.com` and `docs.example.com` once a real domain exists -- deriving
 * one from the other would be right exactly once.
 *
 * The fallback is split on environment. In `next dev` the docs are on port
 * 3001 and running both at once is the normal case when a link crosses between
 * them, so a dev link to GitHub is a link never exercised locally. In
 * production an unset variable falls back to the README -- a page that answers,
 * rather than a hostname that may not.
 */
export const DOCS_URL = stripTrailingSlash(
  process.env.NEXT_PUBLIC_DOCS_URL ??
    (process.env.NODE_ENV === "production"
      ? `${REPO_URL}#readme`
      : "http://localhost:3001"),
);
export const LICENCE = "Apache-2.0";
export const WORKSPACE_GUIDE_URL = process.env.NEXT_PUBLIC_DOCS_URL
  ? `${stripTrailingSlash(process.env.NEXT_PUBLIC_DOCS_URL)}/start/workspaces`
  : `${REPO_URL}/blob/main/apps/docs/content/start/workspaces.mdx`;

export const SITE_DESCRIPTION =
  "Keep sources and AI results in local workspaces. Make a cited brief, compare options, and return to your work later. Optional computer tools for coding and automation. No Husk account required.";

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
    isolation: "kernel",
    mechanism:
      "namespaces, cgroups, seccomp, --cap-drop ALL, read-only root, uid 1000",
    cost: "free, local",
    when: "the default when the daemon is up",
  },
  {
    id: "podman",
    shell: "sealed",
    isolationKind: "kernel",
    isolation: "kernel",
    mechanism: "the same boundary, rootless",
    cost: "free, local",
    when: "Linux without a Docker daemon",
  },
  {
    id: "local",
    shell: "open",
    isolationKind: "none",
    isolation: "guardrails only",
    mechanism:
      "path jail through realpath, scrubbed credentials, deny list, output caps, process-tree kill",
    cost: "free, local",
    when: "nothing else is available",
  },
  {
    id: "ssh",
    shell: "partial",
    isolationKind: "unknown",
    isolation: "whatever the remote is",
    mechanism: "the box you pointed it at — Husk cannot know and does not guess",
    cost: "free if you own the box",
    when: "an Oracle Always Free ARM instance, a Pi, a VPS",
  },
  {
    id: "fly",
    shell: "sealed",
    isolationKind: "kernel",
    isolation: "microVM",
    mechanism: "a Firecracker machine, not a container on your kernel",
    cost: "metered",
    when: "bursty parallel work, no local resources",
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
 * `husk` with no arguments on a machine that has never run it — the twenty
 * lines where the free path either proves itself or does not. Quoted from
 * brand/voice-examples.md §2. The bad news sits in the same table as the good
 * news, in the same type, at the same weight.
 */
export const DOCTOR: TermLine[] = [
  { kind: "prompt", text: "$ npx -y @husk-ai/cli" },
  { kind: "blank", text: "" },
  { kind: "out", text: "husk 0.1.0 · first run · ~/.husk created" },
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
  { kind: "dim", text: "no telemetry. nothing left this machine." },
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
  { name: "shell", what: "run a command, get stdout, stderr and an exit code" },
  { name: "read_file", what: "read a path inside the workspace" },
  { name: "write_file", what: "write a path inside the workspace" },
  { name: "edit_file", what: "replace an exact string, and fail loudly if it is missing or ambiguous" },
  { name: "list_dir", what: "list a directory" },
  { name: "expose_port", what: "publish a port the agent started listening on" },
  { name: "computer_info", what: "kernel, cpus, memory, disk and network, so the model stops probing" },
];

/**
 * The browser, from `packages/mcp/src/browser-tools.ts`. Five of thirteen — the
 * five that make the shape obvious. A real Chromium inside the computer, driven
 * by structured page text rather than by pixels, which is why an agent can use
 * it without seeing.
 */
export const BROWSER_TOOLS: Array<{ name: string; what: string }> = [
  { name: "browser_goto", what: "open a URL in a real Chromium and return the rendered text" },
  { name: "browser_snapshot", what: "list everything readable or clickable, each with a ref" },
  { name: "browser_click", what: "click an element the snapshot named" },
  { name: "browser_type", what: "type into a field" },
  { name: "browser_screenshot", what: "take a PNG, for checking a layout or showing a human" },
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
    what: "It runs uname -sr in the machine and reads it back. The answer is Linux on a computer that did not exist a second ago, and it is not one the model could have guessed.",
  },
  {
    ask: "Write a note to /work/note.txt, then read it back next turn.",
    what: "The filesystem persists for the rest of the conversation. A stable key maps the chat to the same machine, so nothing is tracked by you.",
  },
  {
    ask: "Start a web server and give me the URL.",
    what: "expose_port publishes the port it started listening on and hands back a URL you can open. That is the moment the computer stops being an abstraction.",
  },
];
