# Spec — reach a husk from any chat surface (remote MCP)

**Status:** §1–§4 implemented, §5 option 1 implemented, §6.1–§6.4 fixed. See §7.
**Filed by:** QA session, 11 September 2026
**Why it exists:** the product goal is that a husk is usable *wherever the user already chats* — Claude, ChatGPT, Kimi — rather than behind a separate console at `husk serve`. Most of the machinery for that already works. This spec records what was verified, what blocks the rest, and the smallest change that unblocks it.

---

## 1. What already works (verified, not assumed)

The MCP server was exercised live from a real chat client (Claude Code) against the `husk` MCP server on this machine. All of the following was observed, not inferred:

| Behaviour | Result |
|---|---|
| `computer_info` | Ubuntu 26.04 LTS, kernel 6.18.33.2-microsoft-standard-WSL2, aarch64, 10 cpus, `git curl python3 make gcc` |
| `/work` persistence across *separate* MCP tool calls | **works** — wrote a token in one call, read it back in a later call |
| `browse` runs inside the computer | **confirmed** — reports `via python3`, and returns the same egress IP (`68.56.140.245`) as `curl` executed inside the same computer |
| `browse` on a real article | HTTP 200, correct title, clean article text, 40 extracted links |

So "the bot's own computer, driven from a chat" is a working capability today, not a future one. It needs no new concept — only a transport.

## 2. The blocker

```
packages/mcp/src/server.ts:126      new StdioServerTransport()    <- the only transport
packages/server/src/                no MCP endpoint at all
```

MCP is **stdio only**. The consequence divides cleanly:

- **Works now:** any client that spawns a local subprocess — Claude Code, Claude desktop, Cursor. This is how the verification above was done.
- **Cannot work:** `chatgpt.com`, `kimi.com`, `claude.ai` in a browser. A hosted chat surface cannot spawn a process on the user's laptop. It needs a URL.

`husk serve` is the control plane and already has an auth module (`packages/server/src/auth.ts`), so the gap is narrower than it looks.

## 3. Proposed change

### 3.1 Streamable-HTTP MCP transport on `husk serve`

Add an MCP endpoint to the existing server rather than a second daemon. Reuse `packages/server/src/auth.ts` — do not invent a parallel auth path.

- Mount the existing `TOOLS` / `callTool` from `packages/mcp/src/tools.ts` unchanged. The tool surface is already correct; only the transport is missing.
- Keep `husk mcp` (stdio) exactly as it is. Local desktop clients are the majority case today and they work.
- Default bind stays loopback. A remote endpoint must be opt-in and must refuse to start on a non-loopback host without auth configured — the current `--host` default comment ("loopback only unless you change it") is the right instinct; make it enforced for this endpoint.

### 3.2 Session-to-computer binding

Today the binding is `husk:<name>` in `~/.husk/computers/bindings.json`, keyed per husk. A remote endpoint serves many chat sessions, so binding must key on the authenticated session, not the husk name — otherwise two users' chats share one `/work`.

This is the same defect class as the known cooperative-sharing issue recorded in `docs/QA-SPROUT.md` §"Correction and follow-up": two concurrent runs of one husk share a computer with no refcounting. Remote multi-session use makes that a correctness bug rather than a footgun, so **fix binding before exposing the endpoint publicly.**

### 3.3 Provider implications (the part with teeth)

A WSL computer is bound to one laptop. It cannot back a cloud chat session when the laptop sleeps. Remote surfaces therefore imply `docker` / `fly`, not `local`.

That is also the only configuration with real isolation — `husk doctor` currently reports `local  not isolated` and warns that a prompt-injected model is closer to an adversary than an accident. Exposing an HTTP endpoint backed by the `local` provider would mean remote input driving unsandboxed shell commands on the user's own machine. **Do not ship the remote endpoint with `local` as an allowed provider.**

This is not a theoretical objection. See §6.5 — from inside one husk computer, a shell command can read every *other* computer's `/work`, and the whole Windows drive, through `/mnt/c`. Per-session binding (§3.2) does not fix that on its own: even with perfect binding, two sessions on the `local` provider can reach each other's disks.

## 4. Surface support — check before scoping

- **Claude (Code / desktop):** stdio, working today. Verified.
- **ChatGPT:** supports remote MCP servers. Worth confirming current transport and auth requirements against their live docs before building to them.
- **Kimi:** support unknown. **Unverified — do not scope work to it until someone checks.**

## 5. The interface gap — §1–§4 do not deliver a "live interface"

**This section corrects an error in the first draft of this spec.** The draft
put "a web UI" out of scope and stopped there. That conflated two different
things:

- **Driving** a computer from a chat — the model calls tools. §1–§4 deliver this,
  and it already works over stdio.
- **Watching** a computer from a chat — the user sees files, terminal output, a
  running app. **Nothing in §1–§4 delivers this, and husk cannot do it today.**

"Live interface" means the second one. Verified limits:

**a. MCP advertises tools only.** `packages/mcp/src/server.ts:59` declares
`capabilities: { tools: {} }` — no `resources`, no `prompts`, and no handlers for
either. So the only thing husk can put into a chat is tool-result *text*. It
cannot hand the client a file to render or download.

**b. `expose_port` returns a loopback URL on the `local` provider.**

```
packages/runtime/src/providers/local.ts:637
  const binding: PortBinding = { hostPort: port, url: `http://127.0.0.1:${port}` };
  // comment: "A local process binds the host's own network stack, so a port the
  //           agent opened is already reachable. There is nothing to forward."
```

Correct for a local client, useless for a hosted chat surface. Note
`PortBinding` already has a `publicUrl` field and `exposePort` in
`packages/mcp/src/tools.ts:266` prefers it — so the hook for a real tunnel
exists and is simply unpopulated by `local`.

**c. The console is disconnected from all of this.** `apps/console` has real
panels — Computers, Files, Terminal, Browser, Doctor, Events, Husks — served by
`husk serve` on loopback. Nothing links it to an MCP session, and a chat surface
cannot reach it.

### Options, ranked by value per unit of work

1. **Add MCP `resources`** (cheap, standard, works on Claude and ChatGPT).
   Expose `/work` files as resources so the client can render and download them.
   Closes "let me see what the bot produced" — the common case, and the one that
   would have made the Sprout output reviewable in-chat. Does **not** give a live
   terminal.

2. **Populate `publicUrl` with a real tunnel, then point it at the existing
   console** (best overall value). Reuses the UI already built instead of
   writing a second one, and turns `expose_port` into a genuine primitive — the
   bot can publish anything it runs. Requires the hosted provider from §3.3,
   which §1–§4 need regardless, so the marginal cost is mostly the tunnel.

3. **Inline app/widget per surface** (biggest job, most "live"). ChatGPT's Apps
   SDK and Claude's widget path can render an interactive component returned by a
   tool call, which is how the console panels would appear inline. Per-surface
   work, and it should not start until option 1 or 2 proves the plumbing.

### Still out of scope

A *new* web UI. The point is to connect the console that exists to the surfaces
users are in — not to build a second front end.

---

## 6. Bugs found during this verification (independent of the spec)

These are real and worth fixing regardless of whether the remote transport happens.

### 6.1 `browse` leaks raw JavaScript at small `maxBytes` — inverted failure

`maxBytes` caps the **HTML download before extraction**. A small budget truncates the document mid-`<script>`, so the non-greedy `</script>` match in `packages/core/src/browse.ts:124` cannot close, and raw JS lands in the model's context.

```
browse(url, maxBytes: 1200)    -> "var gform;gform||(document.addEventListener(..."
browse(url, maxBytes: 200000)  -> clean prose: full article + 40 links
```

Running that same regex by hand inside the computer strips all 54 `<script>` tags cleanly. The regex is correct; the **order** is wrong.

Why this matters more than it looks: the failure gets *worse as the budget gets smaller*, which is exactly backwards for the small local models husk is designed around. This is a plausible direct contributor to the fabrication failure documented in `docs/QA-SPROUT.md` §2 — a model fed JavaScript instead of an article will invent the article.

**Fix:** strip `script|style|noscript|template|svg` *then* apply the cap.

**Secondary:** even at a large budget, roughly 60% of the output is site navigation before the article begins. `browse` is described as a reader view but does no main-content extraction. For small-context models that matters more than the byte cap does.

### 6.2 The agent's `web` tool fetches from the host, contradicting the repo's own stated principle

`packages/core/src/browse.ts:11` states it plainly:

> A `fetch()` from the host process is a different machine with a different IP

And `packages/agent/src/tools/web.ts:38` then calls host `fetch()`. MCP's `browse` correctly uses `browseInComputer` → `computer.exec()`. The agent path does not.

So the two browsing paths disagree about the product's central claim. Note the tradeoff is currently split, and neither path has both halves:

- agent `web` tool — enforces `computer.network.allow`, but fetches from the host
- in-computer `curl` / `browse` — really runs in the computer, but bypasses the allowlist

**Fix:** route the agent's `web` tool through `browseInComputer` and apply `assertUrlAllowed` there, so one path has both.

### 6.3 A computer whose workspace is gone becomes an undeletable zombie

`resolve()` in `packages/cli/src/lib/computers.ts:42` produces an error that contradicts its own hint:

```
$ husk cp qafix1:/work/marker.txt ./out.txt
error no computer named "qafix1"
hint:  running now: qafix1
```

Cause: `mgr.get()` returns nothing once the workspace directory is missing, while `mgr.list()` still sees the registry record — and the fallthrough builds its hint from `list()`.

It also cannot be removed:

```
$ husk rm --all --yes --force
destroying 1 computers...
✓ destroyed 0 computers
$ husk ps --all
qafix1  cmp_azexmxnjdrtw  local  running  /work  2m
```

Reports "destroying 1", then "destroyed 0", then exits as success.

Related: 5 workspace directories currently exist on disk with no registry record (`~/.husk/workspaces/` vs `~/.husk/computers/`). Cleanup is non-transactional in **both** directions — record without workspace, and workspace without record.

**Note:** the `E_COMPUTER_NOT_FOUND: this computer's workspace no longer exists` message added for this case is correct and its tests pass — but it is unreachable from the CLI, because `resolve()` fails first. It only surfaces on the in-run agent file-tool path.

### 6.5 Cross-computer isolation does not exist on the `local` provider — `/mnt/c` is an open side door

Verified through the MCP surface, from inside computer `cmp_1asq0qn1gsrf`.

The `/work` jail constrains the **file tools** correctly:

```
read_file /etc/passwd
-> path is outside the machine's writable area: /etc/passwd
   hint: this computer exposes /work and /tmp; use a path under one of them
```

And the deny list and credential scrubbing both hold on the MCP path:

```
shell: sudo id           -> refused: privilege escalation
shell: echo $ANTHROPIC_API_KEY  -> empty; 0 vars matching key|token|secret|passw
```

But `shell` is not jailed, and WSL mounts the host drive at `/mnt/c`:

```
shell: ls /mnt/c/Users/hotra/.husk/workspaces
cmp_1asq0qn1gsrf  cmp_3vxq8rbk76gn  cmp_8c18f0c9cz24  cmp_ambm63xaedev
cmp_e7cgvd10ghsd  cmp_j0j90t83am2n  cmp_m2kwjgz8j7h6  cmp_msf4dpc0tem3

shell: ls -la /mnt/c/Users/hotra/.husk/workspaces/cmp_j0j90t83am2n/root
drwxrwxrwx 1 root root 4096 Sep 11 02:01 .
drwxrwxrwx 1 root root 4096 Sep 11 02:01 notes        <- another computer's /work
```

So one computer can enumerate and read every other computer's disk, plus the whole of `C:`. The mode bits are `drwxrwxrwx`, so writing would very likely succeed as well — **not tested**, because a cross-tenant write is destructive and was deliberately not attempted.

One mitigation does appear to be in place: although the shell runs as `uid=0(root)`, `/etc` is not writable (`touch /etc/qa-probe` → `Permission denied`), so the root filesystem has some protection. `/mnt/c` does not.

**Implication for this spec:** the `local` provider cannot host a remote endpoint under any binding scheme. It is also worth deciding whether `/mnt/c` should be mounted at all for husk computers on WSL — nothing in the product's model appears to need it, and it is the single largest hole in the local provider's story.

### 6.4 Symlink-escape test coverage does not execute on Windows

`packages/runtime/src/policy.test.ts` guards its symlink cases with an early `return` when symlink creation fails. On this host `symlink()` returns `EPERM` (no developer mode), so the "a genuine symlink escape still reports as a symlink escape" assertions never run. They pass vacuously.

**Fix:** mark those as explicitly skipped rather than silently returning, so the gap is visible in test output.

---

## 7. Implementation notes — what was built, and what was found doing it

**Filed by:** implementation session, 11 September 2026. Everything described as
verified below was executed, not reasoned about.

### 7.1 What landed

| Spec item | Where |
| --- | --- |
| §3.1 Streamable-HTTP transport | `packages/server/src/routes/mcp.ts` — `POST/GET/DELETE /mcp`, plus `GET /mcp/info` |
| §3.2 Session-keyed binding | `packages/server/src/mcp-session.ts` (`sessionBindingKey`), refcounting in `packages/runtime/src/manager.ts` |
| §3.3 No `local` behind the endpoint | `assertProviderMayServeRemote`, `assertMcpBindIsSafe` |
| §5 option 1 — MCP `resources` | `packages/mcp/src/resources.ts` |
| §6.1–§6.4 | see 7.6 |

`TOOLS` / `callTool` are mounted unchanged, auth is the existing `installAuth`
hook rather than a parallel path, and `husk mcp` (stdio) is untouched —
`node packages/mcp/dist/smoke.js` still passes end to end against a real WSL
computer, every tool, including the jail and deny-list refusals.

### 7.2 §3.3 is enforced on the isolation claim, not on the provider name

The gate refuses any provider whose `Availability.isolated` is not `true`,
rather than matching `name === 'local'`. Today those are the same set — `local`
is the only built-in that reports `isolated: false` — but a provider added later
is then governed by the rule without anyone remembering a constant, and it
matches what `husk doctor` already tells the user.

`ssh` reports `isolated: true, isolationKind: 'machine'` and is therefore
permitted. That is a judgement the spec did not make explicitly: the box is not
the user's laptop, which is the property §3.3 protects, even though the agent
holds your user's shell on the far end.

### 7.3 A defect found while building §3.2 — the binding key must be minted, not read

The obvious implementation derives the binding key from the request, and it is
wrong in a way that stays invisible until two sessions are tested together.

At the `initialize` request there is no `Mcp-Session-Id` yet — the transport
assigns it while handling that very request — and a fresh client sends no
`X-Husk-Session`. So every initialize looks identical, falls through to the
one-workspace-per-credential fallback, and two chats land on one `/work`. The
endpoint would have shipped with exactly the defect §3.2 exists to prevent, and
nothing about the code looks wrong when read.

The fix is to mint the session id in the route and hand it to the transport via
`sessionIdGenerator`, so the key can be derived before the computer is. The
regression test is "two sessions do not share one /work" in
`packages/server/src/routes/mcp.test.ts`. It failed against the first
implementation and passes now.

### 7.4 §3.2 could not rely on `Mcp-Session-Id` alone

Checked against the live specification: the current revision defines only stdio
and Streamable HTTP, and the 2026-07-28 revision removed protocol-level
sessions — request metadata now travels in `_meta` rather than in a
connection-scoped session. HTTP+SSE is gone as a transport.

A binding keyed on `Mcp-Session-Id` alone would therefore have degraded silently
into shared-workspace behaviour against a newer client: a loss of isolation
arriving as a client upgrade rather than as a code change. The key resolves
`explicit` then `mcp-session` then `principal`, always mixed with a digest of the
credential. The credential itself never reaches the key, because the key lands in
`bindings.json` and in the `husk.key` container label.

### 7.5 §4 surface support — corrected

- **Claude (Code / desktop):** stdio, working. Unchanged by this work.
- **ChatGPT:** not the single answer §4 assumed. OpenAI's deep-research MCP guide
  still documents an SSE URL ending in `/sse/` and requires two specific tools,
  `search` and `fetch`, against a compatibility schema. The broader connector
  path and the MCP specification itself have moved to Streamable HTTP. Practical
  consequence: the endpoint as built suits the connector path, and deep research
  specifically would additionally need a `search`/`fetch` shim husk does not
  have. That is separate work, not a transport change, and it should not be
  started on the strength of a documentation read — it needs someone to try it
  against a live account.
- **Kimi:** no longer unverified, but not the surface §4 assumed. Kimi *Code*
  (the CLI agent) supports remote MCP over streamable HTTP today, including
  bearer headers and OAuth:

  ```
  kimi mcp add --transport http husk https://host/mcp --header "Authorization: Bearer $HUSK_TOKEN"
  ```

  That is a real working target for this endpoint. What remains unverified is
  kimi.com, the consumer chat surface: every source found describes the CLI, and
  nothing documents custom connectors in the web chat. §4's framing of Kimi as a
  browser surface should not be scoped to until someone checks that.

### 7.6 §6 bugs

**6.1 — fixed, and confirmed by running it.** The download budget is now separate
from the text budget (`rawBudgetFor`: floor 1 MB, ceiling 4 MB), so the document
is stripped whole and the cap applies to the prose. Measured against
`https://en.wikipedia.org/wiki/Model_Context_Protocol`, same URL before and
after:

```
before  maxBytes=1200  downloaded=1200    links=0    text: "(function(){var className=\"client-js vector-…"
after   maxBytes=1200  downloaded=249726  links=300  text: "Model Context Protocol - Wikipedia \n\n Jump to content…"
```

`maxBytes=8000` was also leaking raw markup (`<link rel="canonical"…`) into the
text, which is the same bug one notch less obvious. `truncated` now distinguishes
`textTruncated` from `rawTruncated`, because a model told only "truncated"
retries with a larger budget when the download was what got cut, and vice versa.

Regression test: `packages/core/src/browse-script.test.ts` runs the real fetch
script against a real server rather than mocking its stdout — the ordering is not
observable any other way. It skips visibly where no python interpreter exists.

The §6.1 "secondary" point — no main-content extraction, so most of the output is
site navigation — is **not** fixed. It is different work (readability
heuristics), and it is now the larger of the two problems for a small-context
model. Left as a follow-up rather than done badly.

**6.2 — fixed.** `fetch_url` routes through `browseInComputer` with the husk's
declared policy passed explicitly, so one path both runs in the computer and
honours the allow-list. One consequence worth stating plainly: `fetch_url` is now
`needsComputer`, so a husk with no computer no longer gets it. That is the honest
outcome — a tool that fetched from the host while claiming to respect
`computer.network` was describing a machine it was not using. `web_search` still
works without a computer, because it is a call to a search API rather than a
claim about what this machine can reach. `http_request` is deliberately still a
host fetch: it exists for arbitrary methods and headers, and is already
`dangerous` and opt-in.

**6.3 — fixed, both directions.** `ComputerManager.destroy` now clears a registry
record whose machine is gone (`forget`), so `husk rm --all` counts what it
actually removed instead of printing "destroying 1 / destroyed 0" and exiting
zero. `resolve()` in the CLI reports `"X" is registered but its machine is gone`
with a hint that works, instead of `no computer named "X"` contradicted by
`running now: X`. `husk rm <name>` handles that case rather than being blocked by
its own resolver. For the other direction, `orphanWorkspaces` and
`pruneOrphanWorkspaces` find and remove workspace directories with no record, and
`husk rm --all` sweeps them and reports the count.

**6.4 — fixed.** The symlink-escape cases use `it.skipIf` against a real
`symlink()` probe, so the suite reports `2 skipped` on Windows without developer
mode instead of two silent passes. They run normally on Linux CI.

### 7.7 Known gaps — deliberate, not overlooked

- **§5 options 2 and 3 are not built.** A real tunnel populating `publicUrl`, and
  per-surface inline widgets, are both substantial and neither is a transport
  change. Option 1 (resources) is in, which closes "let me see what the bot
  produced". There is still no live terminal in a chat.
- **§6.5 is not fixed.** `/mnt/c` remains mounted on the `local` provider, so one
  computer can still read every other computer's `/work` and all of `C:`. §3.3
  means it cannot back the *remote* endpoint, which is the part that blocked this
  work — but a local stdio client is still exposed to it. Whether husk should
  mount `/mnt/c` at all is the open question §6.5 raises, and it deserves its own
  change.
- **Binding refcounts are serialised per process, not across processes.**
  `bindings.json` is written write-then-rename so it is never half-parsed, and
  in-process mutations are queued, but two husk processes racing a
  read-modify-write can still lose a decrement and strand a computer. The reaper
  and the idle-session sweep bound the damage. A lock file is the fix if this
  turns out to bite.
- **`resources/list` is capped** at 500 entries, depth 6, skipping `node_modules`
  and similar, with a single resource ceiling of 4 MB. A larger `/work` is listed
  partially — breadth-first, so what survives is the top of the tree, where a
  deliverable actually is.
- **No OAuth.** Auth is the control plane's bearer token. ChatGPT's connector path
  prefers OAuth 2.1 with dynamic client registration; a bearer token works for
  Kimi Code and for any client that can set a header, which is the set this
  endpoint was built for.
