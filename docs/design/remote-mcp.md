# Design: remote access to Husk

Status: **proposal, not approved.** Nothing in here is built. Written October 2026;
every external rule is linked to the official page it comes from, checked on 20 October
2026.

## Summary

Local stays the default and does not change: chat apps start Husk on the user's
machine over stdio, with no sign-in and no network exposure. Remote access is opt-in,
off until switched on, and comes in two shapes Husk can support without running a
service:

1. **Local + tunnel.** `husk serve --remote` on the user's machine, published by a
   tunnel the user runs (Cloudflare Tunnel, ngrok, Tailscale Funnel).
2. **The user's own cloud.** The same control plane deployed to the user's Fly account
   (or a VPS), with computers on Fly machines (or that VPS).

A third shape, **a Husk-run relay**, is the only way Husk could be *listed* in ChatGPT.
It reverses the "no Husk-hosted service" rule, so it is written up as a decision for the
owner in [§9](#9-decision-a-husk-run-relay-for-a-chatgpt-listing), with its cost, and is
not part of the plan.

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

**Who may sign in: the owner, claimed once.**
- When remote access is first switched on, Husk prints a one-time **claim code** in the
  terminal (or the Fly logs), valid for 15 minutes.
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
| A stolen access token | Short-lived (1 h) and audience-bound. Refresh tokens rotate on every use, and reusing an old one revokes the whole family. One-click off revokes everything. |
| A second person claiming the instance | The claim code works once, expires in 15 minutes, and is shown only on the owner's machine. Later authorizations need the owner's passkey. |
| A remote client reaching the user's own files | The endpoint refuses providers that do not claim isolation, so the `local` provider cannot back it. Only Docker, Podman, Fly or SSH computers are used remotely. |
| A prompt-injected model running dangerous tools | Dangerous tools still go through approvals. Remotely, an approval is asked in the chat (elicitation) where the app supports it, otherwise in the console. It is never auto-approved. |
| Brute force, scanning, flooding | Rate limits per token and per IP on `/mcp`, `/authorize` and `/token`, and a cap on computers per owner (the existing quota). |
| Secrets in URLs or logs | Tokens only in `Authorization` headers; none in query strings or paths. The audit log records tool names and argument shapes, never tokens or typed text. |
| No TLS | `--remote` refuses to start without TLS unless bound to loopback, which is how every tunnel connects. |
| Cross-site requests to the consent page | A CSRF token on consent; `frame-ancestors 'none'`; strict CORS on `/mcp`. |
| Handoff text crossing the internet | The handoff viewer works remotely only over the same TLS, and typed text is never logged. |

Every call is audit-logged with the owner, the chat session, the tool, the computer and
the outcome. The log is visible in the console.

## 5. Token storage, rotation, revocation

- **At rest.** `~/.husk/remote/` holds hashes of refresh tokens (never the tokens), the
  owner's passkey public key, registered clients and the signing key. Mode 0600, or a Fly
  volume in the cloud setup.
- **Access tokens:** signed JWTs, 1 hour, `aud` set to the server's resource URL, checked
  on every request.
- **Refresh tokens:** opaque, 30 days, rotated on use. Reusing an old one revokes the
  family.
- **Revocation.** Per client from the console. **Remote access off** revokes every token,
  deletes the signing key, and makes `/mcp` answer 404 until it is switched on again.
- **Visible state.** The console and Husk Bar show "Remote access on" with the public URL
  and connected clients whenever it is on.

## 6. When the user's machine is off

- **Local + tunnel:** the chat app's calls fail with a connection error, and the model
  should tell the user Husk is unreachable. Computers keep their state: they are stopped,
  never destroyed, as today. When the machine is back, the same session ids find the same
  computers.
- **Own cloud:** unaffected. The control plane runs on Fly and computers are Fly
  machines that stop when idle and start on the next call.

## 7. Local + tunnel

`husk serve --remote` binds loopback, turns on OAuth, prints the claim code and prints
the exact next command for the tunnel the user picks. Husk never installs or starts a
tunnel without asking.

- **Cloudflare Tunnel:** `cloudflared tunnel --url http://127.0.0.1:7377`
  ([docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/))
- **ngrok:** `ngrok http 7377`
  ([docs](https://ngrok.com/docs/))
- **Tailscale Funnel:** `tailscale funnel 7377`
  ([docs](https://tailscale.com/kb/1223/funnel))

The guide must be checked against each tool's current docs when it is written, since
flags change. The public URL is then added as a custom connector in claude.ai or as a
developer-mode MCP server in ChatGPT. Neither needs a listing.

## 8. The user's own cloud (Fly first, VPS second)

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

## 9. Decision: a Husk-run relay for a ChatGPT listing

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

## 10. Done when (for the build, once approved)

- ChatGPT (developer mode) and claude.ai complete the five scripted tasks in
  `docs/evals/chat-model-tasks.md` against local + tunnel and against own cloud.
- Tests cover:
  - no token means no access;
  - an expired or revoked token is refused;
  - the owner claim can't be taken twice;
  - remote access is off until switched on, and off revokes everything;
  - two sessions never share a computer;
  - `local` cannot back the endpoint;
  - rate limits.
- Local stdio behaviour is unchanged: the existing test suites pass untouched.

## Open questions

- Passkeys on a tunnel domain that changes (ngrok's free URLs) would be lost each time
  the URL changes. Should a named tunnel be recommended, or should passkeys be optional,
  with a claim code each time?
- ChatGPT developer-mode plan limits (write actions on Pro versus Business) could not be
  confirmed: the help article was not readable. They need checking before the guide
  promises anything.
