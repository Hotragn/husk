# @husk/sdk

Typed client for the Husk control plane.

Dependency-free: global `fetch` and `@husk/core` for the shared contracts. No
axios, no ws, no polyfills. Node >= 20.10.

```bash
npm install @husk/sdk
```

The contract is [`docs/API.md`](../../docs/API.md), and where that disagrees
with [`packages/server/src/routes/`](../server/src/routes) the routes win.
`src/contract.test.ts` boots the real server — `createApp` from `@husk/server`,
a real socket, real `provider: 'local'` computers — and drives every method
below against it, including the snippets on this page. This README describes
what runs, not what was planned.

## One real example

Create a computer, write a file to it, stream a command's output, and read the
file back.

```ts
import { HuskClient } from '@husk/sdk';

const husk = new HuskClient({ baseUrl: 'http://127.0.0.1:7377' });

const box = await husk.computers.create({ name: 'scratch' });
console.log(`${box.name} is up on ${box.provider}`); // scratch is up on local

await husk.computers.writeFile(box.id, '/work/greeting.txt', 'hello from husk\n');

for await (const ev of husk.computers.execStream(box.id, { cmd: 'echo hi' })) {
  if (ev.type === 'stdout') process.stdout.write(ev.data);
  if (ev.type === 'stderr') process.stderr.write(ev.data);
  if (ev.type === 'exit') console.log('exit code:', ev.result.exitCode);
}

console.log(await husk.computers.readTextFile(box.id, '/work/greeting.txt'));

await husk.computers.destroy(box.id);
```

The payload field on a stream frame is `data`, not `text`. Reading `ev.text`
prints `undefined` for every byte of output, silently, which is how the last
version of this example was wrong.

Start the control plane it talks to with `husk serve`.

## Configuration

```ts
new HuskClient({
  baseUrl: 'http://127.0.0.1:7377', // or $HUSK_URL
  token: 'secret',                   // or $HUSK_TOKEN
  timeoutMs: 30_000,                 // 0 disables; streams are never timed out
  headers: { 'x-trace': 'abc' },
  fetch: myFetch,                    // for tests, or a custom agent
  webSocket: MyWebSocket,            // only needed on Node 20; see "Events"
});
```

## The wire shape is the return type

Methods return exactly what the route returns, envelopes included. The server
answers `GET /v1/computers` with `{ computers: [...] }`, so does this client.
Unwrapping would be a second contract, and a second contract is what broke this
package the first time.

```ts
const { computers } = await husk.computers.list();
const { husks } = await husk.husks.list();
const { runs, nextCursor } = await husk.runs.list({ husk: 'triage', limit: 50 });
const { entries } = await husk.computers.listDir(box.id, '/work');
```

Routes that answer with a bare object — `computers.get`, `computers.create`,
`husks.run`, `models.chat` — are returned bare.

## Surface

Every method maps to exactly one route.

| method | route |
| --- | --- |
| `husk.health()` | `GET /health` (unversioned, never needs a token) |
| `husk.doctor()` | `GET /v1/doctor` |
| `husk.events()` | `WS /v1/events` |
| `husk.computers.list / create / get / destroy` | `GET`/`POST` `/v1/computers`, `GET`/`DELETE` `/v1/computers/:id` |
| `husk.computers.stop / start` | `POST /v1/computers/:id/stop` \| `/start` |
| `husk.computers.exec / execStream` | `POST /v1/computers/:id/exec` \| `/exec/stream` |
| `husk.computers.listDir` | `GET /v1/computers/:id/fs?path=` |
| `husk.computers.readFile / readTextFile` | `GET /v1/computers/:id/fs/read?path=` |
| `husk.computers.writeFile` | `PUT /v1/computers/:id/fs/write?path=` |
| `husk.computers.remove` | `DELETE /v1/computers/:id/fs?path=` |
| `husk.computers.exposePort` | `POST /v1/computers/:id/ports` |
| `husk.husks.list / get / create / update / delete` | `/v1/husks`, `/v1/husks/:name` |
| `husk.husks.validate` | `POST /v1/husks/validate` |
| `husk.husks.run / runStream` | `POST /v1/husks/:name/run` \| `/run/stream` |
| `husk.runs.list / get / cancel / delete` | `/v1/runs`, `/v1/runs/:id`, `/v1/runs/:id/cancel` |
| `husk.approvals.list / answer` | `GET /v1/approvals`, `POST /v1/approvals/:id` |
| `husk.sessions.discover / import / distill / distillStream` | `/v1/sessions/*` |
| `husk.models.list / chat / chatStream` | `/v1/models`, `/v1/models/chat` \| `/chat/stream` |

Files are bytes on the wire, not base64 in JSON:

```ts
await husk.computers.writeFile(box.id, '/work/a.bin', new Uint8Array([1, 2, 3]));
const bytes = await husk.computers.readFile(box.id, '/work/a.bin');    // Uint8Array
const text = await husk.computers.readTextFile(box.id, '/work/a.txt'); // string
```

Husks are created from a spec **or** from YAML, always in an envelope:

```ts
await husk.husks.create({ spec: { name: 'triage', persona: 'You triage bugs.' } });
await husk.husks.create({ yaml: 'name: triage\npersona: You triage bugs.\n' });

const check = await husk.husks.validate({ spec: { persona: 'no name' } });
if (!check.ok) console.error(check.issues); // 200 with the verdict, not a throw
```

`validate` is the one endpoint that reports failure with a 200: the question is
"is this spec valid", and "no, here is why" is a successful answer to it.

## Errors

Failures come back as the same `HuskError` the server threw — code, message and
hint intact — so a caller handles them identically over HTTP and in-process.

```ts
import { isHuskError } from '@husk/sdk';

try {
  await husk.computers.create();
} catch (err) {
  if (isHuskError(err)) {
    console.error(err.code);    // 'E_QUOTA'
    console.error(err.message); // 'already running 8 computers (limit 8)'
    console.error(err.hint);    // 'destroy one with `husk rm <name>`, or raise maxComputers'
  }
}
```

The code round-trips exactly, including the five the server declares beyond
`HuskErrorCode` — `E_HUSK_NOT_FOUND`, `E_RUN_NOT_FOUND`, `E_APPROVAL_NOT_FOUND`,
`E_TRANSCRIPT_NOT_FOUND`, `E_ROUTE_NOT_FOUND`. A missing husk is not reported as
a missing computer.

A code this SDK has never heard of is passed through verbatim with
`err.details.unrecognizedCode === true`, rather than mapped onto a
familiar-looking code the caller would then branch on. When the response carried
no code at all — a proxy, a crash, the wrong port — one is inferred from the
status and marked `err.details.inferredFromStatus`.

A dead control plane is `E_INTERNAL` with a hint that names `husk serve`, not an
opaque `TypeError: fetch failed`. An aborted request is `E_ABORTED`, so a
cancellation is never mistaken for a network fault.

## Streaming

Every SSE endpoint returns an `AsyncIterable` of the typed event. The stream
ends on the server's `event: done` frame, which is consumed rather than yielded.
An `event: error` frame throws from the iterator, so `try`/`catch` around
`for await` works the way it would for a non-streaming call.

```ts
for await (const ev of husk.husks.runStream('support-bot', { input: 'hello' })) {
  if (ev.type === 'text_delta') process.stdout.write(ev.text);
  if (ev.type === 'tool_start') console.error('→', ev.call.name);
}
```

Pass an `AbortSignal` to stop one:

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 5_000);
for await (const ev of husk.husks.runStream('bot', { input: 'hi' }, { signal: ac.signal })) {
  // ...
}
```

There is no automatic reconnect. Reconnecting mid-run would silently replay tool
calls, which is worse than surfacing the disconnect.

## Events

`husk.events()` opens the `WS /v1/events` firehose: computer state changes, run
lifecycle, trigger and reaper activity.

```ts
const stream = husk.events({ topics: ['computers', 'runs'] });
for await (const frame of stream) {
  if (frame.type === 'computer_created') console.log('new box', frame.payload);
}
```

Subscribing also replays the matching backlog, so a UI that reconnects does not
start on an empty screen. `stream.close()` ends the iteration; an `AbortSignal`
does the same.

This uses the platform `WebSocket` — browsers, Deno, Bun and Node >= 22.4. On
Node 20 there is no global, so pass one rather than have this package take a
dependency that most callers do not need:

```ts
new HuskClient({ webSocket: (await import('ws')).WebSocket });
```

Without one, `events()` throws `E_NOT_IMPLEMENTED` and says exactly that.

## Approvals

When a husk runs with `approvalMode: 'ask'` and calls a dangerous tool, the run
blocks. Poll for it and answer:

```ts
const { approvals } = await husk.approvals.list();
for (const a of approvals) {
  await husk.approvals.answer(a.approvalId, { approve: false });
}
```

An unanswered approval is denied after 120 s. The default is deny, on purpose.

## Not here

- `POST /v1/computers/:id/fs/upload` and `GET .../fs/download` appear in
  `docs/API.md` but are **not registered by the server** — there is no multipart
  parser and no tar implementation behind them. There are no SDK methods for
  them: a method that exists only to throw is a worse lie than an absent one.
- `WS /v1/computers/:id/terminal` exists on the server and has no typed client
  here yet. Drive it with a raw WebSocket against `client.http.wsUrl(...)`.

## Notes

- No client-side retry. A retried run bills twice; wrap it yourself if you want
  one, and only where it is safe.
- No telemetry. The client talks to the `baseUrl` you gave it and nowhere else.
