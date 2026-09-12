# Husk control-plane API — v1

Served by `@husk/server` (`husk serve`), consumed by `@husk/sdk`, `@husk/console`, and
anything else. Default bind `127.0.0.1:7377`.

This document is the contract. The server implements it; the SDK mirrors it; neither
invents endpoints the other does not know about.

## Conventions

- Base path `/v1`. JSON in, JSON out, unless noted.
- IDs are opaque strings. Never parse them.
- Timestamps are ISO 8601 UTC.
- Errors always take this shape, with a matching HTTP status:
  ```json
  { "error": { "code": "E_COMPUTER_NOT_FOUND", "message": "no computer with id cmp_x", "hint": "run `husk ps` to list computers" } }
  ```
  `code` is a `HuskErrorCode` from `@husk/core`. Status mapping: `E_*_NOT_FOUND` → 404,
  `E_*_DENIED` → 403, `E_SPEC_INVALID` → 422, `E_QUOTA` / `E_BUDGET_EXCEEDED` → 429,
  `E_NO_CREDENTIALS` → 401, `E_PROVIDER_UNAVAILABLE` / `E_MODEL_UNAVAILABLE` → 503,
  `E_NOT_IMPLEMENTED` → 501, `E_EXEC_TIMEOUT` → 504, everything else → 500.

  The two suffix rules are applied as rules, not as a table, so a new
  `E_<thing>_NOT_FOUND` lands on 404 without anyone editing the server.

  `E_EXEC_TIMEOUT` and `E_STEP_LIMIT` are declared in `HuskErrorCode` but husk never
  throws them: an exec that runs out of time is an `ExecResult` with
  `timedOut: true`, and a run that hits its step ceiling is a `RunResult` with
  `stopReason: "step_limit"`. Both keep the output a thrown error would discard.
  `E_EXEC_TIMEOUT` keeps its 504 so a gateway timeout still decodes into a
  sensible `HuskError`.
- Auth: when `HUSK_TOKEN` is set, every request needs `Authorization: Bearer <token>`.
  When it is not set the server binds loopback only, and **refuses to start on a
  non-loopback host without a token**. `/health` is always unauthenticated.
- Streaming endpoints are Server-Sent Events: `Content-Type: text/event-stream`, one
  `data:` line per event carrying a JSON object, a heartbeat comment every 15 s, and a
  terminating `event: done`.
- Every mutating endpoint accepts an optional `Idempotency-Key` header.

## Health and capability

```
GET /health     -> 200 { "ok": true, "version": "0.1.0", "uptimeSec": 812 }
GET /v1/doctor  -> 200 DoctorReport
```

`DoctorReport` is what `husk doctor` prints — the honest state of the machine:

This is one shape shared by three consumers: the server returns it, `@husk/sdk`
types it, and `husk doctor --json` prints it. Do not add a field to one without the
other two — the `selected` / `selection` split cost a release once.

```json
{
  "version": "0.1.0",
  "node": "v22.11.0",
  "platform": "win32-arm64",
  "huskHome": "C:\\Users\\me\\.husk",
  "firstRun": false,
  "providers": [
    { "name": "docker", "description": "Kernel-level isolation via Docker",
      "priority": 20, "available": false, "isolated": true, "isolationKind": "kernel",
      "reason": "docker is installed but the daemon is not reachable",
      "hint": "start Docker Desktop (or `sudo systemctl start docker`), then re-run `husk doctor`" },
    { "name": "local",
      "description": "A guarded working directory on this machine. Free, always available, not isolated.",
      "priority": 10, "available": true, "isolated": false, "isolationKind": "guardrails",
      "version": "WSL2 (Ubuntu)",
      "reason": "guarded working directory -- process guardrails, not a sandbox" }
  ],
  "models": [
    { "id": "ollama", "displayName": "Ollama", "priority": 40, "available": true,
      "envKey": "OLLAMA_HOST", "models": ["ollama/qwen2.5:7b", "ollama/llama3.2:latest"] },
    { "id": "anthropic", "displayName": "Anthropic", "priority": 95, "available": false,
      "envKey": "ANTHROPIC_API_KEY", "reason": "ANTHROPIC_API_KEY is not set",
      "hint": "set ANTHROPIC_API_KEY", "models": [] }
  ],
  "selection": {
    "provider": "local",
    "providerReason": "highest-priority available provider (10)",
    "isolated": false,
    "model": "ollama/qwen2.5:7b",
    "modelReason": "first reachable model on Ollama"
  },
  "warnings": [
    "the local provider gives process guardrails, not a sandbox -- do not run untrusted code on it"
  ]
}
```

`selection` carries the *reason* alongside the choice because "husk picked local"
is not actionable on its own, and the whole point of this endpoint is that a
confused user can read it and know what to do.

`priority` values above are the real ones. Computer providers: `docker` 20,
`podman` 18, `ssh` 16, `fly` 14, `local` 10. Model providers: `anthropic` 95,
`openai` 85, `google` 80, `groq` 60, and so on down to `ollama` 40. `isolated`
is `null` when the provider could not be probed at all; `isolationKind` is
`kernel`, `machine` or `guardrails` and is omitted when the probe returned none.

## Computers

```
GET    /v1/computers            -> { "computers": ComputerInfo[] }
POST   /v1/computers            body: ComputerSpec -> 201 ComputerInfo
GET    /v1/computers/:id        -> ComputerInfo
DELETE /v1/computers/:id        -> 204
POST   /v1/computers/:id/stop   -> ComputerInfo
POST   /v1/computers/:id/start  -> ComputerInfo
```

### Exec

```
POST /v1/computers/:id/exec
body: { cmd, cwd?, env?, timeoutSec?, stdin?, tty?, user?, maxOutputBytes? }
 ->  ExecResult
```

Streaming variant, same body, SSE out:

```
POST /v1/computers/:id/exec/stream
data: {"type":"stdout","data":"..."}
data: {"type":"stderr","data":"..."}
data: {"type":"exit","result":{...ExecResult}}
event: done
```

### Files

```
GET    /v1/computers/:id/fs?path=/work                  -> { "entries": DirEntry[] }
GET    /v1/computers/:id/fs/read?path=/work/a.txt       -> raw bytes
PUT    /v1/computers/:id/fs/write?path=/work/a.txt      body: raw bytes -> 204
DELETE /v1/computers/:id/fs?path=/work/a.txt&recursive=true -> 204

GET    /v1/computers/:id/fs/download?path=/work         -> application/gzip (a tar.gz)
POST   /v1/computers/:id/fs/upload?path=/work           body: a tar.gz -> { path, bytes, entries }
```

The archive is made and unmade by the computer's own `tar` and `gzip`; only bytes
cross the boundary, over the same path `fs/read` and `fs/write` use. That is also
why there is no multipart parser: the body *is* the archive, not a form wrapping
one. Paths inside a downloaded archive are relative to the directory asked for,
so it can be unpacked anywhere. Download refuses anything over 256 MB compressed.

### Browser

```
POST /v1/computers/:id/browse
body: { url, follow?, timeoutSec?, maxBytes? }
 ->  BrowsePage
```

Loads the page **from inside the computer**, not with a host `fetch()`. That is
the point: the console's Browser panel has to show the page the *agent* would
get -- same IP, same DNS, same egress -- or the two are looking at different
machines. It is also the one place a declared `network` policy becomes real on
the `local` provider, which cannot filter egress at the OS level.

```json
{ "url": "https://example.com/", "requestedUrl": "https://example.com",
  "status": 200, "contentType": "text/html; charset=utf-8",
  "title": "Example Domain", "text": "Example Domain

This domain is for use…",
  "links": [{ "text": "More information", "href": "https://iana.org/domains/example" }],
  "bytes": 559, "totalBytes": 1256, "truncated": false,
  "elapsedMs": 142, "via": "python3" }
```

`bytes` is what was read, after truncation; `totalBytes` is the server's
`Content-Length` when it sent one, and null otherwise. A refused host returns
**403** and, unusually, carries `details` -- because a UI needs to tell "not in
your allow-list" from "blocked by the built-in loopback rule":

```json
{ "error": { "code": "E_EXEC_DENIED",
  "message": "network policy refuses 169.254.169.254",
  "hint": "loopback, link-local and RFC1918 hosts must be named in computer.network.allow",
  "details": { "host": "169.254.169.254", "mode": "egress", "internal": true } } }
```

`internal: false` means the host is ordinary and simply not allowed; the hint
points at `mode: full` instead. `file://` and every other scheme are refused
before the fetch, so this endpoint cannot be turned into a host file reader.

### Ports and terminal

```
POST /v1/computers/:id/ports  body: { "port": 8000 } -> PortBinding
WS   /v1/computers/:id/terminal?cols=120&rows=32
```

The terminal socket carries raw bytes as stdin/stdout, with one JSON control frame for
resize: `{"type":"resize","cols":n,"rows":n}`.

## Husks

```
GET    /v1/husks           -> { "husks": HuskSummary[] }
POST   /v1/husks           body: { spec: HuskSpec } | { yaml: string } -> 201 HuskSummary
GET    /v1/husks/:name     -> { "spec": HuskSpec, "yaml": string }
PUT    /v1/husks/:name     body: { spec } | { yaml } -> HuskSummary
DELETE /v1/husks/:name     -> 204
POST   /v1/husks/validate  body: { spec } | { yaml } -> { ok, issues?: string[] }
```

`HuskSummary`: `{ name, displayName, description, model, version, tools, triggers,
computer: { enabled, flavor }, updatedAt, runCount }`.

## Running a husk

```
POST /v1/husks/:name/run
body: { input: string | ModelMessage[], history?, model?, vars?, maxSteps?,
        maxCostUsd?, approvalMode? }
 ->  RunResult
```

`input` is required and must be non-empty; anything else is `E_SPEC_INVALID`.
`maxCostUsd` is clamped down to the husk's own `limits.maxCostUsd` — a request
can lower the ceiling, never raise it.

Streaming, same body, SSE carrying `RunEvent` objects verbatim from `@husk/core`:

```
data: {"type":"run_start","runId":"run_x","husk":"triage","model":"anthropic/claude-sonnet-5"}
data: {"type":"text_delta","text":"Look"}
data: {"type":"tool_start","call":{...}}
data: {"type":"run_end","result":{...}}
event: done
```

### Approvals

When `approvalMode: "ask"` and a dangerous tool is called, the stream emits an
`approval_required` event and blocks. The event carries an `ApprovalRequest`
under `request` — not the raw tool call:

```
data: {"type":"approval_required","approvalId":"apr_x",
       "request":{"runId":"run_x","huskId":"triage","tool":"shell",
                  "callId":"call_1","args":{"cmd":"rm -rf /tmp/x"},
                  "prompt":"run `rm -rf /tmp/x`?","dangerous":true}}
```

```
GET  /v1/approvals              -> { "approvals": PendingApproval[] }
POST /v1/approvals/:approvalId  body: { "approve": true, "remember": false }
                                -> { approvalId, approved, remembered }
```

`PendingApproval` is `{ approvalId, runId, husk, call, createdAt, expiresAt }` —
the queue is keyed on a tool call, so a free-form `ctx.confirm` gets a synthetic
one. `GET /v1/approvals` exists so a client that reconnects mid-run can find the
question it missed.

An unanswered approval times out after 120 s and the call is denied. Absent
means no: approval is a security boundary.

### Runs

```
GET    /v1/runs?husk=&limit=50&cursor=  -> { "runs": RunSummary[], "nextCursor"? }
GET    /v1/runs/:runId                  -> { "result": RunResult | RunSummary,
                                              "events": RunEvent[] }
DELETE /v1/runs/:runId                  -> 204
POST   /v1/runs/:runId/cancel           -> 202 { runId, cancelled, status }
```

`result` is a `RunResult` once the run has finished. **While a run is still in
flight there is no result yet, and the `RunSummary` stands in** — so a poller
sees `status: "running"` without having to special-case a 404. Discriminate on
`stopReason`: a `RunResult` has one, a `RunSummary` has `status` instead.

`cancel` is idempotent: cancelling an already-finished run is still 202, with
`cancelled: false` and the run's final status.

## Sessions → husks

```
GET  /v1/sessions/discover?source=claude-code
  -> { "sessions": [{ id, source, title, messageCount, updatedAt, origin }] }

POST /v1/sessions/import
body: { path?: string, content?: string, source?: TranscriptSource }
  -> { "transcript": Transcript }

POST /v1/sessions/distill
body: { transcriptId?: string, transcript?: Transcript, useModel?: boolean, model?: string }
  -> { "distilled": DistilledAgent, "spec": HuskSpec, "yaml": string }
```

`/v1/sessions/distill/stream` emits `{"type":"progress","stage":"scanning|extracting|merging","pct":0.4}`
then one `{"type":"done","spec":{...},"distilled":{...},"yaml":"..."}`.

The mapping from `DistilledAgent` to `HuskSpec` is `toSpec` from `@husk/sessions`
— the same function `husk distill` uses, so the two produce the same file. It
records provenance in `origin` and writes `metadata.distilledConfidence` and
`metadata.distillerNotes`. Those two key names are the contract; nothing writes
`distillConfidence` or `distillNotes`.

## Triggers

A husk's `triggers:` are mounted on the running server. Editing a husk.yaml takes
effect without a restart.

```
GET  /v1/triggers  -> { "triggers": MountedTrigger[], "cron": CronBinding[] }
ALL  /v1/t/*       an `http` trigger. Body or `?input=`; SSE when the client asks.
POST /v1/w/*       a `webhook` trigger. HMAC-verified when the husk sets a secret.
```

`MountedTrigger` is `{ husk, type, at, detail? }`; `CronBinding` is
`{ jobId, husk, schedule, prompt, nextAt }`. A webhook with a secret must carry
`X-Husk-Signature: sha256=<hmac-sha256 hex>` over the exact bytes sent
(`X-Hub-Signature-256` and `X-Signature-256` are accepted too); a bad signature
is 403 `E_EXEC_DENIED`.

## Models

```
GET  /v1/models              -> { "models": ModelInfo[], "providers": [...] }
POST /v1/models/chat         body: ChatRequest -> ChatResponse
POST /v1/models/chat/stream  body: ChatRequest -> SSE of StreamEvent
```

## Events

```
WS /v1/events
```

A firehose of `{ type, at, payload }` for the console: computer state changes, run
lifecycle, reaper actions, provider availability flips. Send
`{"type":"subscribe","topics":["computers","runs"]}` to filter.

## Limits

More than `maxComputers` (default 8) live machines returns `E_QUOTA`. Request bodies cap
at 32 MB. `exec` output caps at `maxOutputBytes` (default 256 KiB). An SSE stream whose
client stops reading for 60 s is closed and its run aborted.

## Not implemented yet

Nothing, currently. This document is the contract, so what is *missing* from the
server belongs in it too -- and right now nothing named here is.

Three entries lived here and have since been built. Worth recording, because in
each case the stated reason was wrong rather than merely outdated:

- `GET /fs/download` and `POST /fs/upload` were blocked on "every usable tar on
  npm is a native module or a large dependency". True, and answering the wrong
  question -- the tar is already inside the machine. See [Files](#files).
- `computerId` on the run body was accepted and ignored, on the reasoning that
  honouring it meant widening a `@husk/agent` contract. `ComputerSource` has one
  method, and a source that answers every key with the same machine satisfies it
  exactly. It now pins the run, and an id that does not exist is a `404` raised
  before the model is called rather than a field that quietly does nothing.
