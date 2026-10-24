# Design: remote access to Husk

Status: **proposal, not approved.** Nothing in here is built. Written October 2026,
revised after review on 20 October 2026; every external rule is linked to the official
page it comes from, checked on 20 October 2026.

## Summary

Local stays the default and does not change: chat apps start Husk on the user's
machine over stdio, with no sign-in and no network exposure. Remote access is opt-in,
off until switched on, and comes in two shapes Husk can support without running a
service:

1. **Local + tunnel.** `husk serve --remote --public-url https://…` on the user's
   machine, published by a tunnel the user runs. The guide recommends Tailscale Funnel,
   because it is the one option that keeps TLS on the user's machine by default
   ([§7](#7-local--tunnel)).
2. **The user's own cloud.** The same control plane deployed to the user's Fly account
   (or a VPS), with computers on Fly machines (or that VPS).

Remote access needs work that does not exist today. Two items are new since review:
approvals for MCP tool calls ([§5](#5-approvals-over-mcp)), and a check that refuses
to serve remotely from a version with a known security advisory
([§8](#8-security-updates)).

A third shape, **a Husk-run relay**, is the only way Husk could be *listed* in ChatGPT.
It reverses the "no Husk-hosted service" rule, so it is written up as a decision for the
owner in [§12](#12-decision-a-husk-run-relay-for-a-chatgpt-listing), with its cost, and
is not part of the plan.

## 1. What already exists

`origin/feat/remote-mcp` (commit `3599cbb`, 11 September 2026) built a first version on
the 0.1.0 tree. It cannot be merged as it is: it forks from 0.1.0 and predates the
per-chat computers, handoffs and cards. These parts are worth porting, with their tests:

| Reusable | Where | Note |
| --- | --- | --- |
| Streamable HTTP MCP at `POST/GET/DELETE /mcp` on `husk serve` | `packages/server/src/routes/mcp.ts` | Mounts the same tools; auth reuses `installAuth`. |
| Session-keyed bindings with a **minted** session id | `packages/server/src/mcp-session.ts` | At `initialize` there is no session id yet, so it must be minted in the route and handed to the transport. Its regression test, "two sessions do not share one /work", is the most valuable thing on the branch. |
| Refusing a provider that does not claim isolation | `assertProviderMayServeRemote` | Checks `Availability.isolated`, not the name `local`. |
| Refusing a non-loopback bind with no token | `assertMcpBindIsSafe` | |
| `/work` as MCP resources | `packages/mcp/src/resources.ts` | Lets a client show or download output. |

Not reusable: its auth is the control plane's static bearer token. Both chat apps that
matter need OAuth for a remote server ([§3](#3-authorization)).

What does **not** exist, and the first draft assumed did:
- **Approvals on the MCP path.** Only Husk's own agent has them (`approvalMode: "ask"`,
  `packages/server/src/approvals.ts`). MCP tool calls run directly. See §5.
- **HTTP rate limits.** The server has none; the only limiter is per chat user in the
  Slack, Discord and Telegram adapters (`packages/adapters/src/shared.ts`). See §4.

## 2. Transport and chat identity

- MCP over Streamable HTTP at `/mcp`, per the
  [transport spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
  SSE is not offered.
- Each MCP session gets a minted id, and that id becomes the chat identity: the same
  `identitySource: 'session'` that Claude Code's `CLAUDE_CODE_SESSION_ID` gives locally.
  One session, one computer, bound in `bindings.json` as today.
- The key is mixed with the signed-in owner, so one owner's sessions can never resolve
  to another owner's computer, and the access token itself never reaches the key (the
  key lands in `bindings.json` and container labels).
- Per the remote-mcp branch's own finding, newer protocol revisions move session data
  into `_meta`. The binding must not depend on `Mcp-Session-Id` alone; a client upgrade
  must never become a loss of isolation.

## 3. Authorization

Both chat apps require OAuth for a remote server, and both follow the
[MCP authorization spec, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization):

- **Protected resource metadata (RFC 9728).** On an unauthenticated request, `/mcp`
  answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, and serves
  `/.well-known/oauth-protected-resource`.
- **Authorization server metadata (RFC 8414)**, including
  `code_challenge_methods_supported: ["S256"]`. Without S256 listed, clients refuse to
  proceed.
- **PKCE with S256**, required.
- **Resource indicators (RFC 8707).** Clients send `resource`, and the server checks every
  token was issued for it (`aud`). It accepts no other tokens and passes none through.
- **Client registration.** Client ID metadata documents (CIMD) are preferred by the spec,
  by [ChatGPT](https://developers.openai.com/apps-sdk/build/auth) and by
  [Claude](https://claude.com/docs/connectors/building/authentication). Dynamic client
  registration is the fallback both still support.
- **Redirect URIs**, allowed exactly:
  - claude.ai: `https://claude.ai/api/mcp/auth_callback` (Claude Code adds loopback
    redirects);
  - ChatGPT: `https://chatgpt.com/connector_platform_oauth_redirect` or
    `https://chatgpt.com/connector/oauth/{callback_id}`.
- **Not supported by either:** machine-to-machine grants (`client_credentials`).
  claude.ai's static headers are beta for a few organizations only, and ChatGPT's public
  listing rejects bearer and custom-header auth. A static `HUSK_TOKEN` is therefore not
  enough on its own.

**Husk's own authorization server, built in.** `husk serve --remote` serves the metadata,
`/authorize`, `/token` and registration endpoints itself. No third-party identity
provider is needed.

**The public URL is required, and it is the identity of the server.**
`--remote` refuses to start without `--public-url https://<host>` (no path, `https`
only). That one value is used for everything that names the server:
- **The Host check.** Today `installAuth` (`packages/server/src/auth.ts`) answers only
  loopback names when no token is set, which closes DNS rebinding but would refuse
  every tunnelled request (`Host: <tunnel host>`). In remote mode the check allows
  loopback names and **exactly** the public URL's host; any other `Host` gets 421. No
  wildcard, no suffix match.
- **The OAuth issuer** (`issuer` in the metadata, `iss` in tokens).
- **The resource and audience:** `resource` in the protected resource metadata and
  `aud` in every access token are `<public-url>/mcp`. A token minted for another URL
  (an old tunnel name, another instance) fails the `aud` check.
- **The passkey relying party ID**: the public URL's host. This is why the URL has to
  be fixed (see §7).

Changing the public URL is a reset: every token and the passkey stop working, and a new
claim is needed.

**Who may sign in: the owner, claimed once.**
- When remote access is first switched on, Husk prints a one-time **claim code** in the
  terminal (or the Fly logs), valid for 15 minutes.
- **The code:** 16 characters of Crockford base32 from `crypto.randomBytes` (80 bits),
  printed in groups of four and compared without regard to case or dashes. Only its
  SHA-256 hash is stored, and the comparison is constant-time.
- **Wrong attempts:** 5 in total, counted per code, not per IP (behind a tunnel every
  request comes from loopback). The fifth wrong attempt kills the code; a new one needs
  `husk remote claim` on the machine. At 80 bits and five guesses, guessing is not a
  practical attack; the limit exists so that a scanner learns nothing and the owner
  notices (the console shows failed attempts).
- The first person to complete an authorization with that code becomes the owner and
  registers a passkey. The code then stops working; a second claim is refused.
- Every later authorization (a new chat app, a new device) needs the owner's passkey.
- There are no other users and no passwords.
- If the passkey is lost, `husk remote reset` on the machine wipes the owner and every
  token, and prints a new claim code.

## 4. Threat model

A remote endpoint puts shell execution on the internet. What it has to withstand:

| Threat | Control |
| --- | --- |
| Anyone on the internet calling `/mcp` | OAuth on every request; no anonymous tools. Remote access is off until switched on. |
| A request naming another host (DNS rebinding, a stale tunnel name) | The Host check allows loopback names and exactly the `--public-url` host (§3). |
| A stolen access token | Short-lived (1 h) and audience-bound. Refresh tokens rotate on every use, and reusing an old one revokes the whole family. One-click off revokes everything. |
| A forged or unsigned token | One algorithm, pinned (§6); `alg: none` and any other algorithm are refused before the signature is looked at. |
| A second person claiming the instance | The claim code has 80 bits, works once, expires in 15 minutes, dies after 5 wrong attempts, and is shown only on the owner's machine. Later authorizations need the owner's passkey. |
| A remote client reaching the user's own files | The endpoint refuses providers that do not claim isolation, so the `local` provider cannot back it. Only Docker, Podman, Fly or SSH computers are used remotely. |
| A prompt-injected model running dangerous tools | **New work (§5).** MCP calls have no approvals today. Remote mode adds them: in the chat where the app is known to show the prompt, otherwise in the console. Never auto-approved; no answer means no. |
| Brute force, scanning, flooding | Limits keyed on what a tunnel does not hide: per access token on `/mcp`, per client and per claim code on `/authorize` and `/token`, plus a global ceiling on each. Not per IP (see below). A cap on computers per owner (the existing quota). |
| Secrets in URLs or logs | Tokens only in `Authorization` headers. Today the server also accepts `?token=` for EventSource and WebSocket; remote mode turns that off, and the console's live views use a short-lived, single-use ticket instead. The audit log records tool names and argument shapes, never tokens or typed text. |
| No TLS | `--remote` refuses to start unless bound to loopback (how every tunnel connects) or given a certificate, and refuses a `--public-url` that is not `https`. |
| The tunnel provider reading traffic | Stated plainly in the guide (§7). Cloudflare Tunnel, ngrok's default HTTPS endpoints and Fly's default proxy end TLS on their servers and can see everything. The recommended tunnel, Tailscale Funnel, ends TLS on the user's machine. |
| The chat app reading results | Not a threat Husk can control, and not hidden: the chat app (ChatGPT, Claude) receives every tool result (§9). |
| Running a version with a known hole | Remote mode checks for security advisories at start and daily, and refuses to start on a high or critical one (§8). |
| Cross-site requests to the consent page | A CSRF token on consent; `frame-ancestors 'none'`; strict CORS on `/mcp`. |
| Handoff text crossing the internet | The handoff viewer works remotely only over the same TLS, and typed text is never logged. Where that TLS ends depends on the tunnel (§7). |

**Why not per IP.** The server runs with `trustProxy: false` (`packages/server/src/app.ts`),
correctly for a local daemon. Behind any tunnel, every request arrives from the tunnel's
local process on loopback, so a per-IP limit is one shared bucket: one scanner locks out
the owner. Trusting a forwarded-IP header does not fix that safely on a shared machine,
because any local process can connect to loopback and send that header. So the limits
are keyed on tokens, clients and claim codes. A per-IP limit is added only for the own
cloud setup behind a reverse proxy the user configures, and only when they name the
proxy's address (`--trust-proxy <ip>`), never by default.

Every call is audit-logged with the owner, the chat session, the tool, the computer and
the outcome. The log is visible in the console.

## 5. Approvals over MCP

**Today:** approvals exist only for Husk's own agent. `approvalMode: "ask"` parks a call
to a tool marked dangerous in an `ApprovalRegistry` that defaults to deny after 120
seconds. MCP tools (`shell`, `write_file`, `browser_type` and the rest) run as soon as
the chat app calls them. The first draft's "dangerous tools still go through approvals"
was wrong for the path remote access uses.

**Required for remote access:**
- **Which tools.** The tools Husk's agent already marks dangerous: `shell`,
  `expose_port`, `write_file`, `edit_file`, `move`, `delete`, `http_request`,
  `browser_click` and `browser_type`. One list, shared by both paths, so the two cannot
  drift.
- **In the chat** where the app is known to show a form-elicitation prompt. This reuses
  the handoff code's rule (`SHOWS_ELICITATION` in `packages/mcp/src/server.ts`): declaring
  the capability is not enough, because Claude Desktop is reported to declare it and
  never show the dialog. The prompt names the tool and a summary of its arguments, with
  Approve and Deny. Per the
  [elicitation spec](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation),
  it asks for a decision, never for a secret.
- **In the console otherwise** (and for claude.ai and ChatGPT until each is confirmed to
  show the prompt). The tool call returns at once with "approval needed", the approval
  id and the console link, so the chat app does not time out; the model tells the user,
  and calls again after approval. Husk Bar and the console show the pending approval.
- **Never auto-approved.** No answer within the timeout is a denial. There is no
  "approve all", and "remember this tool" lasts for one session at most and is off by
  default in remote mode. The app's own permission setting (for example a user telling
  their chat app to run tools without asking) does not count as approval: Husk asks
  independently.

**Local MCP: available, off by default.** Locally, the chat app already asks before each
tool call unless the user turned that off; the computer is usually a container; and the
person approving is at the same machine. Adding a second prompt by default would change
behaviour every local user relies on, which §13 rules out. So local gets the same
mechanism as an opt-in (`HUSK_MCP_APPROVALS=ask`), documented next to the `local`
provider, where it matters most because nothing isolates the shell. Revisit the default
if users ask for it.

## 6. Token storage, rotation, revocation

- **At rest.** `~/.husk/remote/` holds hashes of refresh tokens (never the tokens), the
  owner's passkey public key, registered clients and the signing key. Mode 0600, or a Fly
  volume in the cloud setup.
- **Access tokens:** signed JWTs, 1 hour, `iss` and `aud` from `--public-url`.
- **Signing algorithm pinned: EdDSA (Ed25519).** Verification passes an explicit
  allowlist of exactly that algorithm, so a token whose header says `alg: none`, `HS256`
  (the public key used as an HMAC secret) or anything else is refused before the
  signature is checked. `kid` must match the current key; `iss`, `aud`, `exp` and `nbf`
  are all required and checked. A test for each refusal.
- **Refresh tokens:** opaque, 30 days, rotated on use. Reusing an old one revokes the
  family.
- **Revocation.** Per client from the console. **Remote access off** revokes every token,
  deletes the signing key, and makes `/mcp` answer 404 until it is switched on again.
- **Visible state.** The console and Husk Bar show "Remote access on" with the public URL
  and connected clients whenever it is on.

## 7. Local + tunnel

`husk serve --remote --public-url https://<host>` binds loopback, turns on OAuth, prints
the claim code and prints the exact next command for the tunnel the user picks. Husk
never installs or starts a tunnel without asking.

**Who can read the traffic.** Where TLS ends decides who sees shell output, page
contents and anything typed during a handoff. The guide says this in plain words before
the commands:

| Tunnel | Where TLS ends | Can the provider read it? | Source |
| --- | --- | --- | --- |
| **Tailscale Funnel** (recommended) | On the user's machine: Tailscale on the device "terminates the TLS connection and passes the decrypted request" to Husk | No: "Funnel relay servers do not decrypt the traffic" | [Funnel](https://tailscale.com/kb/1223/funnel) |
| ngrok, default (`ngrok http`) | ngrok's cloud: "All HTTPS endpoints terminate TLS at ngrok's cloud service" | Yes | [TLS termination](https://ngrok.com/docs/universal-gateway/tls-termination/) |
| ngrok, agent termination | On the user's machine (`ngrok tls … --terminate-at agent --crt … --key …`) | No | Same page. TLS endpoints need a paid plan ([limits](https://ngrok.com/docs/pricing-limits/)), and the user supplies the certificate. |
| Cloudflare Tunnel | Cloudflare's network: "TLS terminates at Cloudflare's global network" | Yes. There is no documented passthrough for public HTTP hostnames. | [Proxy status](https://developers.cloudflare.com/dns/proxy-status/use-cases/) |
| Fly proxy, default `tls` handler (own cloud) | Fly's edge: it "terminates TLS using Fly.io-managed application certificates" | Yes | [Services](https://docs.fly.io/networking/services) |
| Fly, TCP service with no handlers | In the app, which must then hold its own certificate | No | Same page |

**Recommendation: Tailscale Funnel.** It ends TLS on the user's machine without a paid
plan step or a certificate to manage, and its name is fixed. Limits from the same page:
it only listens on ports 443, 8443 and 10000, and only uses names in the tailnet's
domain (`<machine>.<tailnet>.ts.net`). Plan availability and pricing are not quoted
here; the guide links Tailscale's pricing page. ngrok with agent termination is the
second choice. Cloudflare Tunnel stays in the guide for people who already use it, with
the sentence "Cloudflare can read everything Husk sends and receives" next to it.

**Own cloud on Fly** keeps the default `tls` handler. Fly runs the machines that hold the
computers, so moving TLS into the app would not take Fly out of the trust boundary; the
guide says that instead of implying otherwise.

**A fixed name, required.** The public URL is the passkey's relying party and the token
audience (§3), so a URL that changes each run (ngrok's or Cloudflare's temporary names)
would lose the passkey and every token each time. `--remote` therefore requires a fixed
name: Funnel's `ts.net` name, an ngrok domain the user has reserved, or a named
Cloudflare tunnel on the user's domain. This answers the first draft's open question:
a named tunnel, not optional passkeys. Optional passkeys would mean a claim code on
every restart, printed to a terminal or a log, which is a weaker owner check, for the
sake of a setup the guide does not need to support.

- **Tailscale Funnel:** `tailscale funnel 7377`
- **ngrok (agent termination):** `ngrok tls 7377 --terminate-at agent --url tls://<your domain> --crt cert.pem --key key.pem`
- **Cloudflare Tunnel (named):** per
  [Cloudflare's tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)

The guide must be checked against each tool's current docs when it is written, since
flags change. The public URL is then added as a custom connector in claude.ai or as a
developer-mode MCP server in ChatGPT. Neither needs a listing.

## 8. Security updates

A remote endpoint running a version with a published hole is the likeliest way this goes
wrong, so remote mode checks before it serves:
- **At start, and then daily**, Husk sends the installed `@husk-ai/*` versions and their
  resolved runtime dependencies (for example `@modelcontextprotocol/sdk`) to the npm
  registry's bulk advisory endpoint, the one `npm audit` uses. Only package names and
  versions are sent.
- **High or critical** advisory affecting the running version: `--remote` refuses to
  start, with the advisory link and the fixed version. If one appears while running,
  remote access switches itself off (as "Remote access off" does) and the console and
  Husk Bar say why. Local stdio is not affected.
- **Moderate or low:** starts, with a warning in the terminal, the console and Husk Bar.
- **Check not possible** (registry unreachable): starts with a warning, and retries; a
  remote server is online by definition, so this should be rare. Failing closed here
  would let a registry outage take every remote instance down.
- **Husk's side:** security fixes are published as GitHub security advisories on the
  repository, so that once reviewed they reach the GitHub Advisory Database that
  `npm audit` reads, and the changelog says which release fixes what.

There is deliberately no flag to override a high or critical refusal; the fix is to
upgrade.

## 9. What users are told

The setup guide and the console's "Remote access" screen say, in these words or close
to them:
- **The chat app sees everything the tools return.** Shell output, file contents, page
  text and screenshots go to ChatGPT or Claude as tool results, and are handled under
  that app's own policies. This is equally true locally, and it is the reason a handoff
  exists: what a person types during a handoff goes to the browser on their computer, not
  to the chat.
- **Your tunnel may see it too** (§7), unless it is Tailscale Funnel or ngrok with agent
  termination.
- **Remote access is on** whenever it is, with the URL and the connected apps.

The workspace tools' instructions already tell the model the first point ("Tool
results are shared with this AI host under its policies", `packages/mcp/src/workspace-tools.ts`);
the guide makes it visible to the person, not only to the model.

## 10. When the user's machine is off

- **Local + tunnel:** the chat app's calls fail with a connection error, and the model
  should tell the user Husk is unreachable. Computers keep their state: they are stopped,
  never destroyed, as today. When the machine is back, the same session ids find the same
  computers.
- **Own cloud:** unaffected. The control plane runs on Fly and computers are Fly
  machines that stop when idle and start on the next call.

## 11. The user's own cloud (Fly first, VPS second)

- A `Dockerfile` for the control plane and a `fly.toml` template with a volume for
  `~/.husk`.
- Computers come from the existing Fly provider (`packages/runtime/src/providers/fly.ts`):
  one per chat session, stopped when idle, and deleted only by the owner, the same rule
  as local. A "delete after N days unused" setting can be offered, off by default and
  shown in the console before it acts.
- The user pays Fly directly; the guide links
  [Fly's pricing page](https://fly.io/docs/about/pricing/) and quotes no prices.
- **VPS.** The same control plane runs on the VPS, and computers use the existing `ssh`
  provider (or Docker on the VPS). It needs TLS through a reverse proxy, or a tunnel to
  loopback.

## 12. Decision: a Husk-run relay for a ChatGPT listing

**Why it comes up.** A listed ChatGPT plugin connects to exactly one MCP server: "Only one
MCP server can be connected per plugin". It must be a "stable, publicly reachable HTTPS
endpoint", and "Do not use Secure MCP Tunnel alone, a temporary tunnel, or a local
endpoint for public submission"
([submission](https://developers.openai.com/apps-sdk/deploy/submission),
[MCP server](https://developers.openai.com/apps-sdk/build/mcp-server)). Each user's own
tunnel or Fly app can be added in developer mode, but cannot be the listed server. A
listing therefore means one Husk-run endpoint in front of everyone's computers: a relay
that each user's Husk connects out to, and that routes each signed-in ChatGPT user to
their own machine.

**What OpenAI requires of a listed plugin** (official docs only):
- Submission by a verified individual or organization, with privacy policy, terms of
  service, support and website URLs, a logo, test cases, a demo video, and a reviewer
  test account with no MFA or one-time codes
  ([submission](https://developers.openai.com/apps-sdk/deploy/submission),
  [guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines)).
- OAuth or no auth; bearer and custom-header auth are rejected for public submission
  ([submission](https://developers.openai.com/apps-sdk/deploy/submission)).
- Minimum data collection, and no collecting restricted data, which includes "Access
  credentials and authentication secrets (such as API keys, MFA/OTP codes, or passwords)"
  ([guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines)).
- Suitable for users aged 13 to 17; not aimed at under-13s
  ([guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines)).
- Daily rescans of the connected server after approval
  ([submission](https://developers.openai.com/apps-sdk/deploy/submission)).
- An app that executes code or controls a computer is **not a documented category** either
  way. That is a review risk to ask OpenAI about before building anything.

**What it would cost Husk:**

| Area | What it means |
| --- | --- |
| Accounts and sign-in | Husk accounts, with an OAuth server for ChatGPT in front of them, account recovery and deletion. |
| Legal | A legal entity to be the verified developer; a privacy policy and terms of service that are true and kept true; a data processing position (GDPR, CCPA) for traffic that passes through the relay. |
| Privacy | Tool calls and results, including page contents and anything typed during a handoff, cross Husk's infrastructure. End-to-end encryption between ChatGPT and the user's machine is not possible, because ChatGPT talks to the relay. The handoff design also sits awkwardly with the restricted-data rule: a person's typed password passes through the relay to their browser. |
| Operations | Uptime for an always-on service (it is the only path for every listed user), on-call, incident response, a status page, capacity and cost that grow with users. |
| Abuse | People using the relay to run scripts against third parties from their machines; handling reports, rate limits, account bans, legal requests. |
| Review | Keeping a reviewer test account working; daily rescans; re-review on every tool change. |

**Recommendation:** don't build the relay now. Ship local + tunnel and own cloud, which
reach ChatGPT through developer mode and claude.ai through custom connectors, without
Husk holding accounts or user traffic. Revisit a listing only if there is clear demand,
and only after asking OpenAI whether a computer-control app is in scope. This is the
owner's decision; nothing here assumes it.

## 13. Done when (for the build, once approved)

- ChatGPT (developer mode) and claude.ai complete the five scripted tasks in
  `docs/evals/chat-model-tasks.md` against local + tunnel and against own cloud.
- Tests cover:
  - no token means no access;
  - an expired or revoked token is refused;
  - a token with `alg: none`, `HS256`, a wrong `kid`, `iss` or `aud` is refused;
  - a `Host` other than loopback or the public URL's host is refused;
  - `--remote` without `--public-url`, or with a non-`https` one, refuses to start;
  - the owner claim can't be taken twice, and the fifth wrong claim code kills it;
  - remote access is off until switched on, and off revokes everything;
  - two sessions never share a computer;
  - `local` cannot back the endpoint;
  - each dangerous tool waits for approval over MCP, and no answer is a denial;
  - rate limits hold when every request comes from loopback;
  - a high or critical advisory stops remote mode from starting;
  - `?token=` is refused in remote mode.
- Local stdio behaviour is unchanged: the existing test suites pass untouched.

## Open questions

- ChatGPT developer-mode plan limits (write actions on Pro versus Business) could not be
  confirmed: the help article was not readable. They need checking before the guide
  promises anything.
- Whether claude.ai and ChatGPT show a form-elicitation prompt when they declare the
  capability. Until each is confirmed by observation, approvals for them go to the
  console (§5).
