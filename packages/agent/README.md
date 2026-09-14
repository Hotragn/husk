# @husk-ai/agent

The tool-calling loop at the heart of Husk, plus the built-in tools.

It streams tokens, runs a turn's tool calls in parallel while keeping their results in
the model's order, enforces every ceiling *before* it spends, and treats approval as a
control rather than a suggestion.

This package depends on `@husk-ai/core` and nothing else in the workspace. The model
router and the computer source are **injected** as structural interfaces, so the loop
runs in a test with no network, no Docker, and no build-order coupling.

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
- **Ceilings are never breached.** `Budget.check()` runs *before* each model call using
  a pre-call estimate. With a price table that is arithmetic; without one it uses the
  most expensive call observed so far.
- **One abort for everything.** `opts.signal` and the timeout feed a single
  `AbortController` whose signal is handed to the model request *and* to every tool, so
  an expired run actually cancels the in-flight request and the running `docker exec`.
- **Secrets never reach the model.** Every tool result is clamped to
  `spec.limits.maxOutputBytes` and then passed through `redact()`.
- **Lazy machines.** A tool asks for the computer with `ctx.acquireComputer()`. A husk
  that never touches the shell never pays for a container, and a parallel batch shares
  one machine rather than racing into four.
- **Loop breaker.** Three byte-identical consecutive tool turns get a system nudge that
  names the repetition; five end the run.

## Approval

| mode | behaviour |
| --- | --- |
| `auto` | dangerous tools run |
| `ask` | dangerous tools call `onApproval`; **no approver means denied** |
| `readonly` | dangerous tools are always denied, approver or not |

`shell`, `write_file`, `edit_file`, `move`, `delete`, `expose_port` and `http_request`
are `dangerous`. `read_file`, `list_dir`, `search_files`, `computer_info`, `fetch_url`
and `web_search` are not.

## Tools

`resolveTools(names, { spec, hasComputer, env })` expands bundle names and individual
tool names, skipping anything that cannot work here rather than registering a tool that
always fails.

| bundle | tools |
| --- | --- |
| `computer` | `shell`, `expose_port`, `computer_info` |
| `files` | `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`, `move`, `delete` |
| `web` | `fetch_url`, and `web_search` when `TAVILY_API_KEY` or `BRAVE_API_KEY` is set |
| `http` | `http_request` (opt-in, dangerous) |

- `edit_file` fails loudly when `oldString` is absent or ambiguous. It never silently
  no-ops, and it never writes on a failed match.
- `search_files` uses ripgrep inside the machine when it is there, and a bounded JS
  walk when it is not. Both are capped.
- `fetch_url` and `http_request` honour `spec.computer.network` through `isHostAllowed`
  in `src/net.ts`, re-implemented locally because `agent` may not import `runtime`.
  They also refuse loopback, link-local and RFC1918 addresses unless the operator named
  them in `computer.network.allow`, which keeps `mode: full` from meaning "and also the
  cloud metadata endpoint".

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

With `memory.enabled`, history is trimmed before each model call: the system prompt,
the opening user message and the last `windowTurns` survive; the middle is summarised
by `summaryModel` (or dropped with a marker when summarisation is unavailable). Cuts
land on turn boundaries and a final pass prunes orphans, so a `tool_call` is never
separated from its `tool_result` — the mistake every provider answers with a 400.

## Scripts

```
npm run typecheck --workspace=@husk-ai/agent
npm run build     --workspace=@husk-ai/agent
npm run test      --workspace=@husk-ai/agent
```
