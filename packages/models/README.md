# @husk/models

One model surface over every provider Husk speaks to, with routing, fallback and cost
accounting. No vendor SDKs — the whole package depends on `@husk/core` and `fetch`.

Eleven providers, three wire formats:

| format | providers |
| --- | --- |
| Anthropic Messages | `anthropic` |
| Google Gemini `generateContent` | `google` |
| OpenAI `chat/completions` | `openai`, `groq`, `openrouter`, `together`, `deepseek`, `mistral`, `cerebras`, `lmstudio` |
| Ollama `/api/chat` (NDJSON) | `ollama` |

The eight OpenAI-compatible gateways are **configuration**, not code: a base URL, an
environment variable, a catalog slice and whatever single quirk that gateway has, in
`src/providers/compatible.ts`. One streaming parser serves all of them. Gemini gets
its own file because it is genuinely a different format — `contents` not `messages`,
`model` not `assistant`, function results keyed by name rather than call id, and an
OpenAPI schema subset that 400s on half of JSON Schema draft-07.

## Example

Save as `demo.mjs` and run with `node demo.mjs`, after
`npm run build --workspace=@husk/models`. It works with nothing configured, as long as
Ollama is running: `auto` picks the best model that is actually reachable.

```js
import { ModelRouter } from '@husk/models';

const router = new ModelRouter();

// Price the call before making it. `getModelInfo` resolves aliases.
const info = await router.getModelInfo('auto');
console.log(`using ${info.id} at $${info.pricing?.inputPerMTok ?? 0}/MTok in`);

for await (const event of router.stream({
  model: 'auto',
  fallbacks: ['free'],
  messages: [{ role: 'user', content: 'Name three uses for a husk. Be terse.' }],
})) {
  // A downgrade is never silent: if the first choice fails, this fires before any
  // token from the replacement model reaches you.
  if (event.type === 'warning') console.error(`\n[${event.code}] ${event.message}`);
  if (event.type === 'text_delta') process.stdout.write(event.text);
  if (event.type === 'done') {
    const { model, usage } = event.response;
    console.log(`\n\n${model} · ${usage.inputTokens}+${usage.outputTokens} tok · $${usage.costUsd}`);
  }
  if (event.type === 'error') console.error(`\n${event.error.code}: ${event.error.message}`);
}
```

To see what is reachable and what to do about what is not:

```bash
node packages/models/examples/doctor.mjs
```

## What the router guarantees

- **No silent downgrade.** Falling back to a different model emits a
  `{ type: 'warning', code: 'fallback', detail: { from, to } }` stream event first.
  A run that quietly finished on an 8B local model when it asked for Opus is worse
  than a run that failed.
- **A 400 is never retried**, anywhere. The request is malformed; shopping it around
  six providers wastes six round trips and six error messages.
- **A stream that has already produced tokens is never restarted** on another model.
  Once bytes have reached the caller there is nothing honest to do with a mid-stream
  failure except report it.
- **Budget is checked against the floor**, not an optimistic estimate: you pay for the
  prompt whatever happens, so `minimumCostUsd` is what a ceiling compares against.
- **No key reaches an error message.** `redact()` plus the literal secret, because
  half these providers mint key formats no pattern list knows about.

## Aliases

`opus`, `sonnet`, `haiku`, `gpt`, `gemini`, `flash`, `gemma`, `llama`, `qwen` resolve
from a fixed table. `local`, `free` and `auto` cannot — their answer depends on what
is running right now, so they resolve against `detect()`.

## Pricing

`src/catalog.ts` carries USD per million tokens for every hosted model. Numbers
flagged `estimatedPricing: true` are conservative estimates derived from the previous
generation of the same tier; they err high so a budget guard refuses early rather than
late. `husk models --json` prints the flag. This file is a budgeting aid, not a
billing source.

Free tiers are marked `free: true`: Groq, Cerebras, Gemini Flash, every OpenRouter
model whose id ends in `:free`, and everything local.
