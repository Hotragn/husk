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
  `code` is a `HuskErrorCode` from `@husk-ai/core`, or one of the nine the server adds
  (`packages/server/src/errors.ts`): `E_HUSK_NOT_FOUND`, `E_RUN_NOT_FOUND`,
  `E_APPROVAL_NOT_FOUND`, `E_HANDOFF_NOT_FOUND`, `E_BROWSER_NOT_FOUND`,
  `E_TRANSCRIPT_NOT_FOUND`, `E_ROUTE_NOT_FOUND`, `E_COMPUTER_HELD` and
  `E_COMPUTER_IN_CHAT`. The workspace routes have codes of their own
  ([Workspaces](#workspaces)). Status mapping: `E_*_NOT_FOUND` → 404,
  `E_*_DENIED` → 403, `E_SPEC_INVALID` → 422, `E_QUOTA` / `E_BUDGET_EXCEEDED` → 429,
  `E_NO_CREDENTIALS` → 401, `E_PROVIDER_UNAVAILABLE` / `E_MODEL_UNAVAILABLE` → 503,
  `E_NOT_IMPLEMENTED` → 501, `E_EXEC_TIMEOUT` → 504, `E_COMPUTER_HELD` / `E_COMPUTER_IN_CHAT` → 409, everything else → 500.

  The two suffix rules are applied as rules, not as a table, so a new
  `E_<thing>_NOT_FOUND` lands on 404 without anyone editing the server.

  A body the server cannot read keeps the HTTP status the parser gave it: JSON that does
  not parse is a 400 with `E_SPEC_INVALID`, and a body over its route's cap is a 413
  with `E_QUOTA`, whose hint names that cap.

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
  API route is under `/v1`. `/health` is always unauthenticated, and so is `/v1/a/*`,
  where a chat app such as Slack posts its events: the adapter checks that app's own
  signature. A browser's `EventSource` and `WebSocket` cannot set headers, so for those
  two transports alone the token may come as `?token=` or `?access_token=`.
- Streaming endpoints are Server-Sent Events: `Content-Type: text/event-stream`, one
  `data:` line per event carrying a JSON object, a heartbeat comment every 15 s, and a
  terminating `event: done`. A failure mid-stream is an `event: error` frame carrying the
  usual `{ "error": … }` body, then `event: done`.
- Every mutating endpoint accepts an optional `Idempotency-Key` header.

## Health and capability

```
GET /health     -> 200 { "ok": true, "version": "0.2.0", "protocol": 1, "uptimeSec": 812 }
GET /v1/doctor  -> 200 DoctorReport
```

`protocol` is what a chat's MCP process and the shared Husk must agree on. Releases
that speak the same one share a Husk, so a patch apart never splits a chat from the
console; `~/.husk/daemon.json` carries it too.

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
DELETE /v1/computers/:id        -> 204   (a chat's computer, or ?erase=true, needs ?confirm=<id>)
GET    /v1/computers/:id/disk   -> { "bytes": number | null, "note"?: string }
GET    /v1/computers/:id/stats  -> { cpuPercent, memoryBytes, memoryLimitBytes, diskBytes, notes? }
GET    /v1/computers/:id/thumbnail -> image/jpeg of an already-open browser, else 404
GET    /v1/overview             -> { computers: ComputerInfo[], activeRuns: ActiveRun[], handoffs: PendingHandoff[], activity: { [id]: ActivityEntry }, running: { [id]: { tool, since } }, inChat: string[], remote? }
GET    /v1/computers/:id/activity -> { "entries": ActivityEntry[] }   (oldest first, the last 200)
POST   /v1/computers/:id/bot    body: { "useModel"?: boolean, "engine"?: "claude-code" | "codex" | "builtin" } -> { transcriptId, spec, yaml, distilled, engines }
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
`DELETE` refuses one (422) unless `?confirm=` repeats its id. On docker and podman, a
chat's or bot's computer keeps its files, browser profile included, for its next
computer, as `husk rm` does; `?erase=true` (with `?confirm=`) takes them too, as the
console's Delete does. `GET .../disk` measures the
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
`/v1/husks/:name`. A Claude Code chat is read back by the session id Husk records
(`husk.session`), which Claude Code names the transcript after; a Codex chat by its
rollout under `~/.codex/sessions`, the newest written since the computer was that names
the computer. For any other computer it answers `E_IMPORT_FAILED`, and the hint says to
export the chat and use the console's Make a bot from a chat. The answer has `engines`,
as `distill` does below, and `engine` in the body picks one.

### Chat tools

```
POST /v1/computers/:id/tools/:name   body: { "args": {...}, "via"?: "mcp" | "bot" } -> ToolResult
```

Runs one of the MCP server's computer tools (`shell`, `read_file`, `browser_click`, …)
in this process, with the same code a chat's MCP process would run. `husk serve` is
the machine's one Husk: it writes `~/.husk/daemon.json` (`url`, a minted `token`,
`pid`, `version`; owner-only), and a chat's MCP process forwards its computer tools
here, starting `husk-mcp --daemon` if nothing answers. The Husk a chat starts mints a
token, since nobody is there to configure one; `husk serve` uses `HUSK_TOKEN` if set,
and is otherwise tokenless on loopback, as before. That is what lets the console show a
chat's browser and what it is doing. The result has the MCP shape,
`{ content: [...], isError? }`; a tool failure is a 200 with `isError: true`. While a
person holds the computer in a handoff, every tool but `computer_info` is refused.

A call still running after 20 s answers 200 at once, then sends a space every 20 s until
its JSON follows. So an hour-long command, or a bot waiting for its computer back,
outlasts a client's header and idle timeouts (Node's `fetch` gives up after 300 s of
either). JSON allows the leading spaces. An error after that point is the usual
`{ error }` body, with the 200.

```
POST /v1/shutdown   -> 202 { stopping: true }
```

Stops the process cleanly. It refuses (403) while a run or a handoff is in progress. A
newer Husk uses it to replace an older one after an upgrade.

### Remote access

Off unless the server was started with `husk serve --remote --public-url https://<host>`.
The setup, tunnels included, is in the guide (`apps/docs/content/guides/remote-access.mdx`).

- **Where it listens.** On a port of its own, which the tunnel publishes: `--remote-port`,
  by default the API's port plus one, on loopback (`--remote-host` for a container behind
  its own proxy). The API and the console stay on their own port, on loopback. The public
  URL is the tunnel's fixed name, with no path.
- **What that port serves.** Only the routes below that are not under `/v1`, and the
  links described under them. Anything else there is a 404, whatever `Host` the request
  carries: a tunnel passes `Host` on as the caller wrote it, so the port decides, not the
  name. The API's port serves none of these routes.
- **Computers.** Remote chats get them only from an isolated provider (`--provider`,
  Docker by default); the server refuses to start if it is not one. An `ssh` target that
  is this machine, by a loopback name such as `localhost` or `127.0.0.1`, is not one.
  They are bound apart from this machine's own chats, so neither side can reach the
  other's by id. A remote
  chat gets the computer tools alone: the workspace tools work on this machine's files.
- **Security advisories.** Before serving, and daily after, the server sends its Husk
  packages and every runtime dependency they resolve, by name and version only, to the
  npm registry's bulk advisory endpoint (`HUSK_ADVISORY_ENDPOINT` points elsewhere).
  - A high or critical advisory refuses to start, naming it, with no flag to serve anyway.
    One that appears while serving switches remote access off, with the reason.
  - A lesser one starts with a warning.
  - A registry that cannot be asked starts with a warning, and is asked again every hour.

```
POST|GET|DELETE /mcp                                 MCP over Streamable HTTP, both protocol eras
GET  /.well-known/oauth-protected-resource           RFC 9728 metadata (also at .../mcp)
GET  /.well-known/oauth-protected-resource/mcp
GET  /.well-known/oauth-authorization-server         RFC 8414 metadata
POST /oauth/register                                 RFC 7591 registration (public clients only)
GET  /oauth/authorize                                the sign-in page
POST /oauth/start | /oauth/claim | /oauth/passkey | /oauth/consent   the page's own steps
POST /oauth/token                                    authorization_code (PKCE S256) or refresh_token
GET  /oauth/approve                                  the page that approves one tool call (?id=)
POST /oauth/approve/start | /oauth/approve           its passkey, and the owner's answer
GET  /oauth/link                                     where a remote chat's links start: the owner's passkey
POST /oauth/link/start | /oauth/link                 its passkey, then an owner session for links
GET  /health                                         { ok: true } and nothing more
```

- **Approvals.** A remote chat's call that changes things runs only with the owner's
  word: `shell`, `write_file`, `edit_file`, `expose_port`, and in the browser
  `browser_click`, `browser_type`, `browser_select`, `browser_upload`, `browser_run`
  (several steps in one call) and `browser_script`.
  - The call answers at once, with a link to `/oauth/approve?id=…` for the model to
    relay. The owner approves there with their passkey, from anywhere, and the model
    calls again with the same arguments.
  - The page shows a line saying what the call does, then the computer it runs on and
    every argument it sends, exactly, with characters that could hide or reorder text
    shown as escapes. A call bigger than 20,000 characters shown is never put to the
    owner, and never runs.
  - An approval covers that one call, once: the same tool, computer and arguments, in any
    key order. Ten minutes unanswered is a no.
  - Saying no needs no passkey. Letting that app make any call of that tool, on any of its
    computers, unasked for an hour is a box the owner ticks, never the default.
- **Limits** are per minute and keyed on what a tunnel does not hide, never the address.
  Over a limit is a 429 with `Retry-After`.
  - What the owner already let in has budgets of its own: each signed-in app on `/mcp`
    and for tokens, each sign-in in flight, and each approval in flight, keyed on an id
    only whoever started it knows.
  - Everyone else shares one budget per route, so a flood holds up only the route it is
    aimed at: a new app's first sign-in, say. The page a link opens on (`/oauth/link`)
    has a budget of its own, so a flood of sign-ins does not keep the owner from a
    handoff; a flood aimed at that page itself still can.
- **The sign-in.** Nothing is sent back to an app before the owner has signed in: an
  authorization request in error is shown as a page, not redirected, since anyone can
  register an app. The page names where it sends the owner back, and says plainly when
  that is not claude.ai, ChatGPT, Perplexity or an app on the owner's own device. Every answer sent
  back carries `iss` (RFC 9207, advertised in the metadata).
- **Links a remote chat gives its person** are under the public URL: a handoff at
  `/oauth/link#handoff=…&token=…`, a look at a computer at
  `/oauth/link#computer=…&token=…`. The chat holds the link too, and so may whoever it
  was shown to, so it opens only after the owner's passkey:
  - `/oauth/link` asks for the passkey, then goes on to the console with an owner session
    in the fragment, which no server sees.
  - Under the public URL, only the console's page and files answer without both. They
    hold nothing.
  - The scoped routes behind the link (`/v1/handoffs/:id/…`, `/v1/scoped/…`) need the
    link's token in `Authorization` and the owner session in `X-Husk-Owner`. Without the
    session, the answer is a 401 with `details.passkey: true`.
  - Only a token minted for a remote chat counts: `{ "public": true, "holder": <app> }` on
    `POST /v1/computers/:id/link` or `/handoffs`. Never one made on this machine, never
    this machine's own token, and never a token in the URL.
  - Owner sessions last eight hours. Switching off or resetting ends every link and
    session, and signing an app out ends the links it was given.
- **What the public port takes.** Sign-in bodies are at most 64 KB, and a 413 names that
  cap, not the API's 32 MB. `/mcp` checks its token
  and budget before it reads a byte of the body. Nothing there is recorded for
  `Idempotency-Key`. App ids are looked up as registered, never through the object
  prototype.

- **`/mcp`.** It takes a bearer access token in `Authorization`, never in a URL. Without
  a good one it answers 401 with
  `WWW-Authenticate: Bearer resource_metadata="<public URL>/.well-known/oauth-protected-resource/mcp"`.
- **Access tokens.** EdDSA JWTs for one hour. Their `iss` is the public URL and their
  `aud` is `<public URL>/mcp`. Any other algorithm or key id is refused, and so is a
  token for another URL.
- **Refresh tokens.** They last 30 days and change on every use. Using one twice ends
  its whole family: the access tokens minted in it, and any token a request still in
  flight would have minted in it.
- **Who signs in.** Only the owner: whoever first types the claim code (80 bits, 15
  minutes, 5 tries), registering a passkey as they do. The code is printed on a terminal
  and never into a log; otherwise `husk remote claim` gives one. A new code ends any
  sign-in that typed the old one. Every later sign-in needs that passkey. A passkey whose
  counter does not go up is refused; one that keeps no count (zero every time) is fine.
- **Redirects.** Only ones the app registered, https or loopback http.
- **Registered apps.** At most 50. At the cap, apps that registered over an hour ago and
  never signed in make way; with none of those, registration is refused.
- **A new public URL.** The passkey and every token belong to the name they were made
  under, so starting with another `--public-url` forgets the owner, the apps and the
  tokens, says so, and prints a claim code.

On this machine, with the server's token:

```
GET    /v1/remote          -> RemoteStatus
POST   /v1/remote/claim    -> { code }   a new claim code, while there is no owner
POST   /v1/remote/off      -> RemoteStatus   every token revoked, the public URL a 404
POST   /v1/remote/on       -> RemoteStatus   refused while a high or critical advisory stands
DELETE /v1/remote/apps/:id -> RemoteStatus   that app signed out, its tokens with it
POST   /v1/remote/reset    -> { code }   no owner, no apps, no tokens; a code for a new owner
```

`RemoteStatus` is `{ on, offReason?, publicUrl, endpoint, owner, apps: [{ id, name,
createdAt }], advisories: [{ name, version, title, severity, url, vulnerable? }],
checkedAt?, checkError? }`. `apps` lists only apps the owner let in and that have not been
signed out since; `createdAt` is when they were let in. Off keeps the owner, so signing
back in is their passkey away. `GET /v1/overview` carries `remote: { on, publicUrl, apps,
offReason?, warning? }` while the server serves remote access, for Husk Bar; there `apps`
is how many apps are signed in, not the list.

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
GET    /v1/computers/:id/fs/read?path=/work/a.txt       -> raw bytes (at most 256 MiB; past that, E_QUOTA)
PUT    /v1/computers/:id/fs/write?path=/work/a.txt      body: raw bytes -> 204
DELETE /v1/computers/:id/fs?path=/work/a.txt&recursive=true -> 204

GET    /v1/computers/:id/fs/download?path=/work         -> application/gzip (a tar.gz)
POST   /v1/computers/:id/fs/upload?path=/work           body: a tar.gz -> { path, bytes, entries }
```

The archive is made and unmade by the computer's own `tar` and `gzip`; only bytes
cross the boundary, over the same path `fs/read` and `fs/write` use. That is also
why there is no multipart parser: the body *is* the archive, not a form wrapping
one. Entries in a downloaded archive start with the directory's own name (`src/…` for
`path=/work/src`), so it can be unpacked anywhere; upload it to the parent, `/work`, to
put it back, since uploading it to `/work/src` gives `/work/src/src`. `/work`'s own
archive goes back through `/` only on Docker, Podman and Fly: on `local` and `ssh`, `/`
is that machine's own root. Download stops at 256 MiB
compressed: the archive is cut off inside the computer as it passes that, so a path too
big fails with `E_QUOTA` without filling the computer's `/tmp`. A path that is not there,
and a file tar cannot read, are each said as such.

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
{ "url": "https://example.com/", "requestedUrl": "https://example.com/",
  "status": 200, "contentType": "text/html; charset=utf-8",
  "title": "Example Domain", "text": "Example Domain\n\nThis domain is for use…",
  "links": [{ "text": "More information", "href": "https://iana.org/domains/example" }],
  "bytes": 559, "totalBytes": 1256, "truncated": false,
  "elapsedMs": 142, "via": "python3" }
```

`requestedUrl` is the URL as Husk parsed it, so `https://example.com` comes back with
its slash; `url` is where the redirects ended. `bytes` is what was read, after
truncation; `totalBytes` is the server's `Content-Length` when it sent one, and null
otherwise. A computer without python3 fetches with curl (`via: "curl"`): the text is the
body with its tags stripped, `title` is `""`, `links` is `[]` and `totalBytes` is null.

A refused host returns **403** and, unusually, carries `details` -- because a UI needs
to tell "not in your allow-list" from "blocked by the built-in internal-address rule":

```json
{ "error": { "code": "E_EXEC_DENIED",
  "message": "network policy refuses 169.254.169.254",
  "hint": "link-local and RFC1918 hosts must be named in computer.network.allow",
  "details": { "host": "169.254.169.254", "mode": "egress", "internal": true, "loopback": false } } }
```

`mode` is `"unset"` when the computer has no network policy. The hint has three cases:
an internal address, as above; loopback where the computer shares its machine's network
(`local`, `ssh`), whose hint says to use an isolated provider or name the host in
`computer.network.allow`; and an ordinary host that is simply not allowed
(`internal: false`), whose hint points at `mode: full`. `file://` and every other scheme
are refused before the fetch, so this endpoint cannot be turned into a host file reader.

### Ports and terminal

```
POST /v1/computers/:id/ports  body: { "port": 8000 } -> PortBinding
WS   /v1/computers/:id/terminal
```

`PortBinding` is `{ hostPort, url, publicUrl?, reachable? }`: `reachable` says whether
anything answered on `url` when the binding was made, and is absent when the provider
did not check.

The terminal socket is not a pty: Husk ships no native modules, so there is none. Each
message is one command, run with `tty: true`: a raw string, or
`{"type":"exec","cmd":"ls -la"}`. Replies are JSON frames: `{"type":"ready","computerId":…,"workdir":…}`
on connect, then `{"type":"stdout","data":…}` and `{"type":"stderr","data":…}`, then
`{"type":"exit","exitCode":n,"durationMs":n}`, or `{"type":"error","error":…}`. A resize
frame, `{"type":"resize","cols":n,"rows":n}`, is accepted and ignored.

```
WS   /v1/computers/:id/screen?fps=1..4
```

The computer's browser, live, while the socket is open: `{"type":"frame","data":<base64 jpeg>,"width":n,"height":n}`
up to four times a second (or `fps`, for a small screen among many), or
`{"type":"idle","message":…}` once while no browser is open. It never launches one.
Frames are pushed: Chrome's own screencast, through the long-lived driver in the
computer, one cast for every viewer. Where the provider cannot keep a driver running,
it asks for one frame at a time instead. An unknown computer gets
`{"type":"error","code":"E_COMPUTER_NOT_FOUND",…}` and the socket closes.

## Setup

What the console's Connect page and `husk setup` use:

```
GET    /v1/setup               -> { apps: ChatApp[], computers: ProviderStatus[] }
POST   /v1/setup/apps/:app     body: { provider?, flavor? } -> ConnectResult
DELETE /v1/setup/apps/:app     -> ConnectResult
POST   /v1/setup/test          body: { provider?, flavor? } -> { ok, provider, output, ms }
POST   /v1/setup/follow        body: { launch } -> { moved: ConnectResult[] }
```

`:app` is one of `claude-desktop`, `claude-code`, `cursor`, `vscode`, `windsurf`, `zed`,
`codex`, `gemini`. A `ChatApp` is `{ id, name, found, connected, outdated, where, after }`:
whether it is on this machine, whether Husk is already in it, whether its `husk` entry
starts another Husk than this one (an older release, or another install), the file Husk
edits or the command it runs, and what to do next (usually restart the app). Connecting
writes this install's launch line, `npx -y @husk-ai/mcp@~0.2 [--provider p] [--flavor f]`
(the range is the release's own major and minor), or from the desktop app's Husk the
app's own copy, and moves an outdated entry to it, keeping its flags and env. For an app with a
JSON config, the file is backed up first (`ConnectResult.backup`), and only the `husk`
entry changes, in place: the rest of the file keeps its layout and comments. A file
that is not JSON as that app reads it is refused and left untouched: Zed's settings may
have comments, the other apps' files may not.
Claude Code and Codex are changed through their own `mcp add` / `mcp remove`
commands. `test` makes a throwaway computer, runs `uname -sr || ver`, and removes it.
Every `POST` here must be `Content-Type: application/json`, which a browser cannot send
to another site without asking first, so another website cannot connect Husk to your
apps.

`follow` is the desktop app's, after it updates or moves. Every chat app whose `husk`
entry starts a Husk desktop app's own copy by another line moves to this Husk's line,
keeping its own flags and env. An entry the person pointed elsewhere, such as `npx`,
stays as it is. It acts only while this Husk runs the line the app sends as `launch`.
That line is compared, never written: Husk writes its own.

## Husks

```
GET    /v1/husks           -> { "husks": HuskSummary[] }
POST   /v1/husks           body: { spec: HuskSpec } | { yaml: string } -> 201 HuskSummary
GET    /v1/husks/:name     -> { "spec": HuskSpec, "yaml": string }
PUT    /v1/husks/:name     body: { spec } | { yaml } -> HuskSummary
DELETE /v1/husks/:name     -> 204
POST   /v1/husks/validate  body: { spec } | { yaml } -> { ok, issues?: string[] }
```

`HuskSummary`: `{ name, displayName, description, model, engine, version, tools, triggers,
computer: { enabled, flavor }, updatedAt, runCount }`. `engine` is what runs it:
`builtin`, or the person's own `claude-code` or `codex`.

## Running a husk

```
POST /v1/husks/:name/run
body: { input: string | ModelMessage[], history?, model?, vars?, maxSteps?,
        maxCostUsd?, approvalMode?, computerId? }
 ->  RunResult
```

`input` is required and must be non-empty; anything else is `E_SPEC_INVALID`.
`maxSteps` and `maxCostUsd` are clamped down to the husk's own `limits.maxSteps` and
`limits.maxCostUsd`: a request can lower a limit, never raise it. `computerId` runs the
husk on a computer that already exists. The router gets the husk's `fallbackModels`.

Streaming, same body, SSE carrying `RunEvent` objects verbatim from `@husk-ai/core`:

```
data: {"type":"run_start","runId":"run_x","husk":"triage","model":"anthropic/claude-sonnet-5"}
data: {"type":"text_delta","text":"Look"}
data: {"type":"tool_start","call":{...}}
data: {"type":"run_end","result":{...}}
event: done
```

The other events are `step_start`, `thinking_delta`, `message` (after every step),
`tool_delta` (a command's output as it runs, with `callId` and `tool`), `tool_end`,
`tool_denied`, `approval_required`, `handoff_required`, `computer_ready`, `usage`,
`warning` and `error`; `RunEvent` in `@husk-ai/core` has every field.

### Approvals

When `approvalMode: "ask"` and a dangerous tool is called, the stream emits an
`approval_required` event and blocks. The event carries an `ApprovalRequest`
under `request` — not the raw tool call:

```
data: {"type":"approval_required","approvalId":"apr_x",
       "request":{"runId":"run_x","huskId":"triage","tool":"shell",
                  "callId":"call_1","args":{"command":"rm -rf /tmp/x"},
                  "prompt":"Allow shell?","details":{"command":"rm -rf /tmp/x"},
                  "dangerous":true}}
```

`runId` is the run's own, the one `run_start` gave, and `callId` is the id of the
`tool_start` the call will have once it is let through.

```
GET  /v1/approvals              -> { "approvals": PendingApproval[] }
POST /v1/approvals/:approvalId  body: { "approve": true, "remember": false }
                                -> { approvalId, approved, remembered }
```

`PendingApproval` is `{ approvalId, runId, husk, call, createdAt, expiresAt }` —
the queue is keyed on a tool call, so a free-form `ctx.confirm` gets a synthetic
one, named after the tool that asked. `GET /v1/approvals` lists what is waiting for
a client other than the one that started the run, such as the console, and for runs
no client is attached to: cron, webhooks and chat triggers. A run started over this API
lives as long as its client: when the client goes, the run stops, and its approval is
denied.

An unanswered approval times out after 120 s and the call is denied. Absent
means no: approval is a security boundary.

### Handoff to a person

A husk that names the `hand_off` tool can stop and wait for someone to sign in or
enter a 2FA code. The run is paused, not failed, and its stream says so while it waits:

```
data: {"type":"handoff_required","handoffId":"hnd_x",
       "request":{"runId":"run_x","huskId":"triage","reason":"Enter the 2FA code",
                  "computerId":"cmp_x"}}
```

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

The person takes the computer from its chat without being asked. Taking it stops the
AI's calls running on it first, browser scripts included, and answers once they have
ended, so the person never shares the screen with half-done work. Until then the
overview's `running` names the call it waits for, which the console and the desktop
app show. While it is held, a chat's call to `POST /v1/computers/:id/tools/:name`
waits up to 45 seconds for it to
come back, then runs; still held, it answers with an error telling the model it is
paused. A bot's call waits until Give back instead, with nobody to tell: a bot on the
person's own CLI sends `"via": "bot"`, and a husk run's tools pause in the runner, which
says so once in the run (`Paused: a person took over the computer…`). A cancel or the
run's `timeoutSec` still ends a paused run. After Give back, a browser action is refused only if the page is not the one
the AI left (another URL, title or tab, or a call of its own stopped part-way), with
what changed; a `browser_snapshot` or `browser_goto` clears that.

Only the person's Give back, `POST /v1/handoffs/:handoffId/done`, ends a take-over,
from the console or the desktop app (`X-Husk-As: person`), or from the link it was
taken with. There is no lease. A program's `done` (a chat's `hand_off_done`), the
model's own link and `DELETE /v1/handoffs/:handoffId` are refused with 409
`E_COMPUTER_HELD`. Taking over a computer whose chat or run asked for a person makes
that handoff the person's, on the same terms. A handoff the chat asked for, and nobody
took, still ends with the chat's `hand_off_done`.

The shared Husk keeps its take-overs and its chats' handoffs in `~/.husk/holds.json`
and holds them again when it restarts, before it serves anything. A chat's handoff gets
a fresh lease, which its chat's polling keeps. A file it cannot read fails closed: every
computer is held for the person until they give it back.

While any hold is open, a run's, a chat's or a take-over, its computer's browser stays
open, so the page the person is coming to use is still there however long they take.
The person's typing counts as use of the computer; watching it does not.

Every other route that changes a held computer (`exec`, `exec/stream`, `fs`,
`browser/*`, `ports`, `browse`, `stop`, `start`, `DELETE`) refuses a program with
409 `E_COMPUTER_HELD` until Give back, and stops one that was running. The console's
own buttons send `X-Husk-As: person` and go through, since they act as the person.
This is cooperation, not a security boundary: a client that sends the header is
believed.

#### A chat's handoffs

When a chat's own model calls `hand_off`, its MCP process opens the handoff here, so
the person takes over in the console that holds the chat's browser:

```
POST   /v1/computers/:id/handoffs  body: { "reason": "...", "label"?: "..." } -> 201 PendingHandoff & { token }
DELETE /v1/handoffs/:handoffId     -> PendingHandoff   (the chat went away; the computer is freed)
GET    /v1/handoffs/:handoffId/state -> { handoffId, state: "open"|"done"|"aborted"|"unknown" }
POST   /v1/computers/:id/link      -> { token }        (for a chat's card or plain link)
POST   /v1/computers/:id/in-chat   -> 204              (the chat runs this computer in its own process)
GET    /v1/scoped/computer         -> { computerId, label?, provider?, state, handoff: PendingHandoff | null }
GET    /v1/scoped/computer/screen  -> image/jpeg, read-only
POST   /v1/scoped/computer/takeover -> 201 PendingHandoff (runId "person"), or the handoff already open
```

A chat whose computer this Husk cannot reach (a provider that needs the chat's own
environment, such as `FLY_API_TOKEN`) runs it in its own process and says so with
`in-chat`. The overview lists it in `inChat`, and `/v1/computers/:id/takeover` refuses
it with 409 `E_COMPUTER_IN_CHAT`, pointing at the chat's own link instead.

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
body: { path?: string, content?: string, source?: TranscriptSource, pick?: string }
  -> { "transcript": Transcript }
   | { "source": TranscriptSource, "choices": [{ id, title, messages, updatedAt? }] }

POST /v1/sessions/distill
body: { transcriptId?: string, transcript?: Transcript, useModel?: boolean, model?: string,
        engine?: "claude-code" | "codex" | "builtin" }
  -> { "transcriptId", "distilled": DistilledAgent, "spec": HuskSpec, "yaml": string, "engines": [...], "continues": boolean }
```

`discover` looks where each app keeps its chats: Claude Code's projects, Codex's
`~/.codex/sessions` (`$CODEX_HOME`), Cursor's `state.vscdb` and Gemini CLI's
checkpoints. A file that holds many chats, such as a ChatGPT export or Cursor's
`state.vscdb`, makes `import` answer with `choices`, newest first and nothing kept; ask
again with `pick` set to a choice's `id`. `engines` lists what the draft can run on,
best first: the chat's own app's CLI when it is installed (a Claude Code chat goes on as
itself, with `engine.resume`), any other installed CLI, then Husk's own engine. `engine`
picks one of them, and `continues` says whether Claude Code would go on with the chat
rather than start from the draft.

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
ALL  /v1/t/*       an `http` trigger. `?input=`, `?text=` or `?q=`, else the body; SSE when the client asks.
POST /v1/w/*       a `webhook` trigger. HMAC-verified when the husk sets a secret.
```

In the shared Husk that chats start (`husk-mcp --daemon`), the triggers run in a
job host of their own, `husk-mcp --jobs`: the shared Husk starts it when a husk
has a trigger (anything but `cli`) and forwards these routes, and `/v1/a/*` for
chat apps, to it, so a trigger keeps the shared Husk's address and token. The
job host listens on a loopback port with a token of its own, recorded in
`~/.husk/jobs.json` and logging to `~/.husk/jobs.log`. It runs each bot by asking
the shared Husk (`POST /v1/husks/:name/run`, or `/run/stream`), starting it if
need be, so the bot's runs, computers and take-overs are the shared Husk's like
any chat's. It outlives the shared Husk, so a schedule does not wait for a chat,
and leaves once no husk has a trigger. `husk serve` mounts the triggers itself.

`MountedTrigger` is `{ husk, type, at, detail? }`; `CronBinding` is
`{ jobId, husk, schedule, prompt, nextAt }`. A webhook with a secret must carry
`X-Husk-Signature: sha256=<hmac-sha256 hex>` over the exact bytes sent
(`X-Hub-Signature-256` and `X-Signature-256` are accepted too); a bad signature
is 403 `E_EXEC_DENIED`. Its prompt comes from the signed body alone: the query string
is not signed, so `?input=` on a captured delivery would have run any prompt. There
is no replay window, so the same signed delivery sent again runs again.

## Workspaces

Saved local workspaces: the public sources a chat adds and the results it writes. The
same routes serve a chat's own workspace viewer (`workspace_open_ui`).

```
GET    /v1/workspaces                     -> { "workspaces": WorkspaceSummary[] }
POST   /v1/workspaces                     body: { "name" } -> 201 WorkspaceManifest
GET    /v1/workspaces/:id                 -> WorkspaceManifest
POST   /v1/workspaces/:id/sources         body: { "url" } -> { source: SourceRecord, content }
GET    /v1/workspaces/:id/files?path=     -> { path, content, sourceIds }
PUT    /v1/workspaces/:id/files           body: { "path", "content", "sourceIds"? } -> WorkspaceFile
GET    /v1/workspaces/:id/download?path=  -> the file, as an attachment
GET    /v1/workspaces/:id/export          -> application/zip
DELETE /v1/workspaces/:id                 body: { "confirmName": "<its name>" } -> { "ok": true }
```

A source is fetched from this machine, not from a computer. What the store accepts and
keeps is in `packages/workspaces/README.md`. These routes answer errors in the usual
shape, with no hint, and with codes of their own: `E_INPUT` (400) for a body or query
that does not fit; the store's `INVALID_INPUT` and `SOURCE_BLOCKED` (400), `NOT_FOUND`
(404), `CONFLICT` and `STORE_BUSY` (409), `LIMIT_EXCEEDED` (413), `SOURCE_FAILED` (502),
`SOURCE_TIMEOUT` (504) and `STORE_CORRUPT` (500); and `E_WORKSPACE` (500) for anything
else.

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

A firehose of `{ type, at, topic, payload }` for the console: computer state changes,
each AI call as it starts and once it ends (`tool_started`, `tool_called`), run
lifecycle, reaper actions, provider availability flips. The topics are `computers`,
`runs`, `providers`, `triggers`, `adapters` and `reaper`.

On connect the server sends `hello`, whose payload lists the topics and the active runs.
Send `{"type":"subscribe","topics":["computers","runs"]}` to filter: the answer is
`{ type: "subscribed", at, topics }`, then the buffered history for those topics, then
live traffic. `{"type":"ping"}` gets `{ type: "pong", at }`. A frame for a viewer that has
fallen far behind is dropped.

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
