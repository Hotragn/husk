# Husk control-plane API — v1

Served by `@husk-ai/server` (`husk serve`), consumed by `@husk-ai/sdk`, `@husk-ai/console`, and
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
  `code` is a `HuskErrorCode` from `@husk-ai/core`. Status mapping: `E_*_NOT_FOUND` → 404,
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
  non-loopback host without a token**. On a loopback bind, token or not, it answers
  only requests whose `Host` is `localhost`, `127.x` or `[::1]`, so a web page cannot
  reach it through DNS rebinding. A request carrying an `Origin` that is not one of
  those names is refused (403), WebSockets included: a web page cannot drive it. The
  console's own page and assets (`GET` outside `/v1`) load without the token; every
  API route is under `/v1`. `/health` is always unauthenticated.
- Streaming endpoints are Server-Sent Events: `Content-Type: text/event-stream`, one
  `data:` line per event carrying a JSON object, a heartbeat comment every 15 s, and a
  terminating `event: done`.
- Every mutating endpoint accepts an optional `Idempotency-Key` header.

## Health and capability

```
GET /health     -> 200 { "ok": true, "version": "0.2.0", "uptimeSec": 812 }
GET /v1/doctor  -> 200 DoctorReport
```

`DoctorReport` is what `husk doctor` prints — the honest state of the machine:

This is one shape shared by three consumers: the server returns it, `@husk-ai/sdk`
types it, and `husk doctor --json` prints it. Do not add a field to one without the
other two — the `selected` / `selection` split cost a release once.

```json
{
  "version": "0.2.0",
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
DELETE /v1/computers/:id        -> 204   (a chat's computer needs ?confirm=<id>)
GET    /v1/computers/:id/disk   -> { "bytes": number | null, "note"?: string }
GET    /v1/computers/:id/stats  -> { cpuPercent, memoryBytes, memoryLimitBytes, diskBytes, notes? }
GET    /v1/computers/:id/thumbnail -> image/jpeg of an already-open browser, else 404
GET    /v1/overview             -> { computers: ComputerInfo[], activeRuns: ActiveRun[], handoffs: PendingHandoff[], activity: { [id]: ActivityEntry } }
GET    /v1/computers/:id/activity -> { "entries": ActivityEntry[] }   (oldest first, the last 200)
POST   /v1/computers/:id/bot    body: { "useModel"?: boolean } -> { transcriptId, spec, yaml, distilled }
POST   /v1/computers/:id/stop   -> ComputerInfo
POST   /v1/computers/:id/start  -> ComputerInfo
GET    /v1/computers/:id/browser/status     -> whether a browser can run here (never installs one)
GET    /v1/computers/:id/browser/tabs       -> { "tabs": [...] } of an already-open browser (never launches one)
POST   /v1/computers/:id/browser/goto       body: { "url", "timeoutSec"? } -> { url, loaded, title }
POST   /v1/computers/:id/browser/snapshot   body: { "limit"? } -> { url, nodes }
POST   /v1/computers/:id/browser/click      body: { "ref" } -> { url, nodes }
POST   /v1/computers/:id/browser/type       body: { "ref", "text", "submit"? } -> { url, nodes }
GET    /v1/computers/:id/browser/screenshot ?fullPage=1 -> image/png
DELETE /v1/computers/:id/browser            -> 204, and the browser is closed
```

A computer made from a chat app carries `platform` ("Claude Desktop", "Cursor",
"Claude Code"), `chatLabel` ("Claude Desktop · chat started 10:42") and
`identitySource`: `session` when the host gave the server process a session id,
`named` for `--session`, or `first-call` when the chat carries the computer id itself.
They come from the client's own name and the start time, never from chat titles or
chat content.

Husk never deletes a chat's computer on its own: it has no idle or lifetime limit, and
`DELETE` refuses one (422) unless `?confirm=` repeats its id. `GET .../disk` measures the
workspace from the host, so it works on a stopped computer and does not count as use.
Local computers report bytes; for other providers, or a workspace inside WSL, `bytes` is
null and `note` says why.

`stats` reports CPU and memory from `docker stats` / `podman stats` while a container
computer runs, and disk as `disk` does. Anything not measured is `null`, with a note;
nothing is estimated. `thumbnail` never launches a browser: with none open it answers
`E_BROWSER_NOT_FOUND`. `overview` is what the console's Home shows: every computer, each
active run with its `computerId`, `step` and current `tool`, the open handoffs, and the
last tool call on each computer.

An `ActivityEntry` is `{ at, tool, ok, ms, via, summary? }`: one tool call, from a husk
run or a chat (`via: "mcp"`). `summary` is a short, redacted look at the call's target,
taken from an allowlist of arguments (a shell command, a path, a URL, an element ref).
Tools that carry typed text, such as `browser_type`, never have one. The log is in
memory and starts empty when the server restarts.

`bot` distills the chat that owns a computer into a husk draft, for the console's "Make
this a bot". It is a draft: nothing is saved until the caller `PUT`s the YAML to
`/v1/husks/:name`. Only a Claude Code chat can be read back, because Husk records its
session id (`husk.session`) and Claude Code names the transcript after it; for any
other computer it answers `E_IMPORT_FAILED`, and the hint says to export the chat and
import it.

### Chat tools

```
POST /v1/computers/:id/tools/:name   body: { "args": {...}, "via"?: "mcp" } -> ToolResult
```

Runs one of the MCP server's computer tools (`shell`, `read_file`, `browser_click`, …)
in this process, with the same code a chat's MCP process would run. `husk serve` is
the machine's one Husk: it writes `~/.husk/daemon.json` (`url`, a minted `token`,
`pid`, `version`; owner-only), and a chat's MCP process forwards its computer tools
here, starting `husk-mcp --daemon` if nothing answers. The Husk a chat starts mints a
token, since nobody is there to configure one; `husk serve` uses `HUSK_TOKEN` if set,
and is otherwise tokenless on loopback, as before.

```
POST /v1/shutdown   -> 202 { stopping: true }
```

Stops the process cleanly. It refuses (403) while a run or a handoff is in progress. A
newer Husk uses it to replace an older one after an upgrade. That is what lets the console
show a chat's browser and what it is doing. The result has the MCP shape,
`{ content: [...], isError? }`; a tool failure is a 200 with `isError: true`. While a
person holds the computer in a handoff, every tool but `computer_info` is refused.

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

```
WS   /v1/computers/:id/screen?fps=1..4
```

The computer's browser, live, while the socket is open: `{"type":"frame","data":<base64 jpeg>,"width":n,"height":n}`
up to four times a second (or `fps`, for a small screen among many), or `{"type":"idle"}` once while no browser is open. It never
launches one. The driver answers one request at a time from inside the computer, so this
asks for each frame rather than subscribing to Chrome's own screencast.

## Setup

What the console's Connect page and `husk setup` use:

```
GET    /v1/setup               -> { apps: ChatApp[], computers: ProviderStatus[] }
POST   /v1/setup/apps/:app     body: { provider?, flavor? } -> ConnectResult
DELETE /v1/setup/apps/:app     -> ConnectResult
POST   /v1/setup/test          body: { provider?, flavor? } -> { ok, provider, output, ms }
```

`:app` is one of `claude-desktop`, `claude-code`, `cursor`, `vscode`, `windsurf`,
`codex`, `gemini`. A `ChatApp` is `{ id, name, found, connected, where, after }`:
whether it is on this machine, whether Husk is already in it, the file Husk edits or
the command it runs, and what to do next (usually restart the app). Connecting writes
the launch line `npx -y @husk-ai/mcp [--provider p] [--flavor f]`. For an app with a
JSON config, the file is backed up first (`ConnectResult.backup`), only the `husk`
entry changes, and a file that is not plain JSON is refused and left untouched.
Claude Code and Codex are changed through their own `mcp add` / `mcp remove`
commands. `test` makes a throwaway computer, runs `uname -sr`, and removes it.

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

Streaming, same body, SSE carrying `RunEvent` objects verbatim from `@husk-ai/core`:

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

### Handoff to a person

A husk that names the `hand_off` tool can stop and wait for someone to sign in or
enter a 2FA code. The run is paused, not failed:

```
GET  /v1/handoffs                    -> { "handoffs": PendingHandoff[] }
GET  /v1/handoffs/:handoffId         -> PendingHandoff
GET  /v1/handoffs/:handoffId/screen  -> image/jpeg, header x-husk-viewport: <w>x<h>
POST /v1/handoffs/:handoffId/input   body: one of
       { "type": "click",  "x": 0, "y": 0, "button"?: "left"|"right", "double"?: true }
       { "type": "scroll", "x": 0, "y": 0, "dx"?: 0, "dy": 300 }
       { "type": "text",   "text": "up to 2000 chars" }
       { "type": "key",    "key": "Enter"|"Tab"|"Escape"|"Backspace"|"Delete"|"Arrow*"|"Home"|"End"|"PageUp"|"PageDown" }
                                     -> 204
POST /v1/handoffs/:handoffId/done    -> { handoffId, outcome: "done" }
```

The screen and input endpoints work only while that handoff is open, on that run's
own browser. They never launch one: with no browser up, they answer
`E_BROWSER_NOT_FOUND`. Input is a closed list of mouse and keyboard events sent as
`Input.*` commands by the driver inside the computer. There is no navigate, no script
and no raw CDP, and the debug port is never exposed, so this works the same on Windows
as on Linux. Coordinates are CSS pixels of the viewport the screen header reports.
Typed text is not logged and not put on the event bus. The console's **Handoffs**
panel is a client for these four endpoints.

Only `POST .../done` resumes the run. There is no timeout and a dropped connection
does not count, so a tunnel that falls over mid-login leaves the run waiting. The run's
`timeoutSec` stops counting while the person holds it. Cancelling the run ends the wait.
A run with nobody to take the handoff refuses it at once rather than waiting.

#### Taking a computer at any moment

```
POST   /v1/computers/:id/takeover  -> 201 PendingHandoff (runId "person"), or the handoff already open
```

The person takes the computer from its chat without being asked. While it is held, a
chat's call to `POST /v1/computers/:id/tools/:name` waits up to 45 seconds for it to
come back, then runs; still held, it answers with an error telling the model it is
paused. Only `POST /v1/handoffs/:handoffId/done` (Give back) ends it: there is no lease,
and a chat's `hand_off_done` cannot, since the chat never opened it.

#### A chat's handoffs

When a chat's own model calls `hand_off`, its MCP process opens the handoff here, so
the person takes over in the console that holds the chat's browser:

```
POST   /v1/computers/:id/handoffs  body: { "reason": "...", "label"?: "..." } -> 201 PendingHandoff & { token }
DELETE /v1/handoffs/:handoffId     -> PendingHandoff   (the chat went away; the computer is freed)
GET    /v1/handoffs/:handoffId/state -> { handoffId, state: "open"|"done"|"aborted"|"unknown" }
POST   /v1/computers/:id/link      -> { token }        (for a chat's card or plain link)
GET    /v1/scoped/computer         -> { computerId, label?, state, handoff: PendingHandoff | null }
GET    /v1/scoped/computer/screen  -> image/jpeg, read-only
POST   /v1/scoped/computer/takeover -> 201 PendingHandoff (runId "person"), or the handoff already open
```

One handoff per computer at a time. The chat polls `state`, which also keeps the
handoff alive: a chat that stops polling for a minute has gone, and its handoff is
cancelled (never marked done), so the computer is free again. `state` says how a
handoff ended, so a chat is never told "done" for one that was cancelled. `token` is short-lived and scoped to that computer
(`computer:<id>`): it opens the `/v1/scoped/` routes and that computer's
`/v1/handoffs/:handoffId` routes, and nothing else. Not the handoff list, not the
computers, not the routes that mint tokens. It rides in the link's `#fragment` and is
sent back as a bearer token. It dies after 10 minutes unused, stays alive while the
console uses it, and never outlives 8 hours. `scoped/computer/takeover` is Take over
for the link's own computer, the same as `/v1/computers/:id/takeover`; the person then
uses and gives back that handoff with the same token, which keeps working after Give
back. A chat's own handoff ending revokes its token; a person's take-over ending does not.

With no shared Husk (`HUSK_DAEMON=off`, or none could be started), the MCP server
serves the same per-handoff and `/v1/scoped/` routes on its own loopback viewer, as it
did before, with the same token rules, plus `handoff:<id>` tokens for a computer-less
handoff. Neither the viewer's own token nor the server token opens them there, and a
scoped token does not open the workspace API.

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

The mapping from `DistilledAgent` to `HuskSpec` is `toSpec` from `@husk-ai/sessions`
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
  honouring it meant widening a `@husk-ai/agent` contract. `ComputerSource` has one
  method, and a source that answers every key with the same machine satisfies it
  exactly. It now pins the run, and an id that does not exist is a `404` raised
  before the model is called rather than a field that quietly does nothing.
