# @husk-ai/agent

The tool-calling loop at the heart of Husk, plus the built-in tools.

It streams tokens, runs a turn's tool calls in parallel while keeping their results in
the model's order, checks every ceiling *before* it spends, and treats approval as a
control rather than a suggestion.

This package depends on `@husk-ai/core`, and on `@husk-ai/browser` for the browser tools.
The model router and the computer source are **injected** as structural interfaces, so
the loop runs in a test with no network, no Docker, and no build-order coupling.

```ts
export interface RouterLike {
  chat(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  /** Optional. When present the budget can price a call before making it. */
  getModelInfo?(model: string): Promise<ModelInfo | null>;
}

export interface ComputerSource {
  ensure(key: string, spec?: ComputerSpec): Promise<Computer>;
}
```

## Example

Save as `demo.mjs` and run with `node demo.mjs`. It needs a model provider the router
can reach (an `ANTHROPIC_API_KEY`, or a local Ollama), and Docker if you want a real
container — without Docker the runtime falls back to the guarded `local` provider.

```js
import { ComputerManager } from '@husk-ai/runtime';
import { ModelRouter } from '@husk-ai/models';
import { Agent } from '@husk-ai/agent';
import { parseSpec } from '@husk-ai/core';

const spec = parseSpec({
  name: 'release-notes',
  persona: 'You are a careful release engineer. Keep answers short.',
  model: 'sonnet',
  tools: ['computer', 'files'],
  limits: { maxSteps: 8, maxCostUsd: 0.25, timeoutSec: 120 },
  guardrails: { approvalMode: 'ask' },
});

const agent = new Agent({
  spec,
  router: new ModelRouter(),
  computers: new ComputerManager(),
});

const result = await agent.run({
  input: 'Create /work/notes.md with three bullet points about husks, then read it back.',

  // `ask` mode routes every dangerous tool through here. Return false, or omit this
  // callback entirely, and the call is denied -- the loop never defaults to allow.
  async onApproval(req) {
    console.log(`\n[approve] ${req.tool} ${JSON.stringify(req.args).slice(0, 120)}`);
    return true;
  },

  onEvent(event) {
    if (event.type === 'text_delta') process.stdout.write(event.text);
    if (event.type === 'tool_start') console.log(`\n[tool] ${event.call.name}`);
    if (event.type === 'tool_delta') process.stdout.write(event.text);
    if (event.type === 'computer_ready') console.log(`\n[computer] ${event.computerId}`);
    if (event.type === 'warning') console.warn(`\n[warn] ${event.message}`);
  },
});

console.log(`\n\n${result.stopReason} in ${result.steps} steps, $${(result.usage.costUsd ?? 0).toFixed(4)}`);
```

`run()` is `stream()` drained to completion, so there is one code path. Take the events
directly when you would rather push them at a websocket:

```js
for await (const event of agent.stream({ input: 'what is in /work?' })) {
  if (event.type === 'run_end') console.log(event.result.stopReason);
}
```

## What the loop guarantees

- **Text and tool calls travel together.** An assistant turn becomes one message whose
  `content` is a `ContentPart[]` holding thinking, text and every `tool_call`. Nothing
  is dropped because the model happened to narrate what it was doing.
- **Real streaming.** `text_delta` and `thinking_delta` come from `router.stream()` as
  the tokens arrive, not from replaying a finished response.
- **Deterministic parallelism.** Up to four tool calls run at once via `mapLimit`, and
  results are appended in the model's original order, so a run replays identically.
- **Ceilings are checked before the spend.** `Budget.check()` runs *before* each model
  call using a pre-call estimate. With a price table that is arithmetic; without one it
  uses the most expensive call observed so far, which is nothing on the first call. The
  estimate assumes a reply of 1024 tokens and the request does not cap the reply, so one
  long reply can carry a run past `maxCostUsd` or `maxTokens`; the next call is then
  refused. A memory summary is counted after it is made, and not checked before.
- **One abort for everything.** `opts.signal` and the timeout feed a single
  `AbortController` whose signal is handed to the model request *and* to every tool, so
  an expired run actually cancels the in-flight request and the running `docker exec`.
- **Known secret formats do not reach the model.** Every tool result is clamped to
  `spec.limits.maxOutputBytes` and then, while `guardrails.redactSecrets` is on (the
  default), passed through `redact()`, which masks the credential formats it knows and
  nothing else.
- **Lazy machines.** A tool asks for the computer with `ctx.acquireComputer()`. A husk
  that never touches the shell never pays for a container, and a parallel batch shares
  one machine rather than racing into four.
- **Loop breaker.** Three byte-identical consecutive tool turns get a nudge, sent as a
  user message marked `[husk]`, that names the repetition; five end the run.

## Approval

| mode | behaviour |
| --- | --- |
| `auto` | dangerous tools run |
| `ask` | dangerous tools call `onApproval`; **no approver means denied** |
| `readonly` | dangerous tools are always denied, approver or not |

`shell`, `write_file`, `edit_file`, `move`, `delete`, `expose_port`, `http_request`,
`browser_click` and `browser_type` are `dangerous`. `read_file`, `list_dir`,
`search_files`, `computer_info`, `fetch_url`, `web_search`, `browse`, `browser_goto`,
`browser_snapshot`, `browser_screenshot` and `hand_off` are not.

## Tools

`resolveTools(names, { spec, hasComputer, env })` expands bundle names and individual
tool names, skipping anything that cannot work here rather than registering a tool that
always fails.

| bundle | tools |
| --- | --- |
| `computer` | `shell`, `expose_port`, `computer_info` |
| `browser` | `browse`, and the real Chromium's `browser_goto`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot` |
| `files` | `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`, `move`, `delete` |
| `web` | `fetch_url`, and `web_search` when `TAVILY_API_KEY` or `BRAVE_API_KEY` is set |
| `http` | `http_request` (opt-in, dangerous) |

`hand_off`, which pauses the run until a person says they are done, is in no bundle: a
husk gets it only by naming it.

- `edit_file` fails loudly when `oldString` is absent or ambiguous. It never silently
  no-ops, and it never writes on a failed match.
- `search_files` uses ripgrep inside the machine when it is there, and a bounded JS
  walk when it is not. Both are capped.
- `fetch_url` and `http_request` honour `spec.computer.network` through `isHostAllowed`,
  which `src/net.ts` re-exports from `@husk-ai/core`: one floor, the one the runtime
  uses too. They refuse loopback, link-local and RFC1918 addresses unless the operator
  named them in `computer.network.allow`, which keeps `mode: full` from meaning "and also
  the cloud metadata endpoint", and they check each redirect before following it.

Write your own with `defineTool`, and hand it in as `tools: [...]`:

```ts
import { defineTool } from '@husk-ai/agent';

const wordCount = defineTool({
  name: 'word_count',
  description: 'Count the words in a file on the computer.',
  needsComputer: true,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Absolute path.' } },
    required: ['path'],
  },
  async handler(input, ctx) {
    const computer = await ctx.acquireComputer();
    const text = await computer.readTextFile(input.path, ctx.maxOutputBytes);
    return { path: input.path, words: text.split(/\s+/).filter(Boolean).length };
  },
  render: (out) => `${out.words} words in ${out.path}`,
});
```

## Memory

With `memory.enabled` and `backend: file` (the default), a bot keeps notes between runs:
plain files in `~/.husk/bots/<name>/memory/`, which it reads and changes with one `memory`
tool (Anthropic's memory-tool commands: `view`, `create`, `str_replace`, `insert`, `delete`,
`rename`). Each run is told which notes it has. The Claude Code and Codex engines get the
same tool, and the same notes, through Husk's MCP server. Paths stay inside the folder,
links are refused, secrets are masked, and a bot keeps at most 200 notes and 1 MB.

With `memory.enabled`, history is also trimmed before each model call: the system prompt,
the examples, the opening user message and the last `windowTurns` turns survive; the
middle is summarised by `summaryModel` (or dropped with a marker when summarisation is
unavailable). A turn is a user message with its answer, or one model step after its tool
results, so one long run is trimmed too. Cuts land on turn boundaries and a final pass
prunes orphans, so a `tool_call` is never separated from its `tool_result` — the mistake
every provider answers with a 400.

## Scripts

```
npm run typecheck --workspace=@husk-ai/agent
npm run build     --workspace=@husk-ai/agent
npm run test      --workspace=@husk-ai/agent
```
