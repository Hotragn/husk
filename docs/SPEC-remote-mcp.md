# Spec — reach a husk from any chat surface (remote MCP)

**Status:** proposed, not started
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
