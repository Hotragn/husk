import { randomBytes, randomUUID } from 'node:crypto';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  Server,
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
} from '@modelcontextprotocol/server';
import type { CallToolResult, ClientCapabilities, Implementation, InputRequiredResult, ServerContext, Tool } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { HUSK_VERSION, IDENTITY_LABELS, chatClient, chatLabel, createLogger, networkEnforcement, platformName, quiet, redact } from '@husk-ai/core';
import type { IdentitySource } from '@husk-ai/core';
import type { Computer, ComputerInfo, ComputerSpec, Logger } from '@husk-ai/core';
import { ComputerManager, ensureRunning } from '@husk-ai/runtime';
import { audited } from '@husk-ai/core';
import { callTool, toolsFor } from './tools.js';
import type { ToolDef, ToolResult } from './tools.js';
import { DaemonUnreachable, HandoffGone, RunLocally, connectDaemon } from './daemon.js';
import type { DaemonClient } from './daemon.js';
import { WorkspaceStore } from '@husk-ai/workspaces';
import { HandoffRegistry, PERSON_RUN, ScopedTokens, computerLink, handoffLink, refusalText, startWorkspaceViewer, takenText, underControl } from '@husk-ai/server/workspace-viewer';
import { CARD_APP_TOOLS, CARD_APP_TOOL_NAMES, CARD_HTML, CARD_MIME, CARD_URI, OPEN_UI_TOOL, UI_EXTENSION } from './card.js';
import type { CardState } from './card.js';
import type { WorkspaceProfile } from '@husk-ai/server/workspace-viewer';
import { PROMPTS, getPrompt } from './prompts.js';
import { HANDED_BACK, HANDOFF_TOOLS, HANDOFF_TOOL_NAMES, MAX_REASON, heldText, relayText } from './handoff-tools.js';
import { WORKSPACE_TOOLS, WORKSPACE_TOOL_NAMES, WORKSPACE_INSTRUCTIONS, WorkspaceTools } from './workspace-tools.js';
import { DANGEROUS_TOOLS, MAX_SHOWN, approvalText, digestOf, exactly, summarize, tooBigText } from './approvals.js';
import type { RemoteApp } from '@husk-ai/server';

export interface HuskMcpOptions {
  /**
   * Stable key for the machine. Every tool call in one session reuses it, which is
   * what makes `cd`, installed packages and written files survive across calls.
   */
  sessionKey?: string;
  spec?: ComputerSpec;
  manager?: ComputerManager;
  /**
   * Stop the machine when the client disconnects. Default true. A chat's
   * computer is never destroyed by Husk: only the user deletes it.
   */
  ephemeral?: boolean;
  /** Forward computer tools to the shared Husk, starting it if needed. Default true; HUSK_DAEMON=off also disables it. */
  daemon?: boolean;
  /** Use this client for the shared Husk instead of finding one. For tests. */
  shared?: DaemonClient;
  /** How the shared Husk is found, or started again once it is lost. For tests. */
  connect?: () => Promise<DaemonClient | undefined>;
  /** Stop a computer after this long with no tool call. Default 10 minutes. */
  idleStopMs?: number;
  /** Answer "still running" after this long, instead of the chat app's own wait. For tests. */
  callWaitMs?: number;
  logger?: Logger;
  profile?: WorkspaceProfile;
  workspaceStore?: WorkspaceStore;
  /**
   * A signed-in app over remote access (remote.ts): its chats carry their
   * computer ids, its computers are bound under the owner, and it can reach
   * no computer a chat on this machine made, nor they its. `approve` is the
   * owner's word on a call that changes things (approvals.ts).
   */
  remote?: {
    owner: string;
    platform: string;
    approve?: RemoteApp['approve'];
    /** The public URL, for the links its person opens. */
    origin?: string;
    /** The app, whose sign-out ends the links it was given. */
    client?: string;
  };
}

/** Where a remote chat's links open: the owner's passkey first, since the chat holds the link too. */
const REMOTE_LINK_PAGE = '/oauth/link';

/**
 * Husk as an MCP server.
 *
 * This is the product's shortest path to value: one `claude mcp add` and a model
 * that had no computer has one. So the constraints here are unusual --
 *
 *  - Nothing is created until the first tool call. Adding the server must cost
 *    nothing, or people will not leave it installed.
 *  - stdout belongs to the JSON-RPC protocol. Every log line goes to stderr; a
 *    stray console.log corrupts the stream and the client silently dies.
 *  - The first tool result carries an honest one-line note about what kind of
 *    machine this is, because a model that believes it is sandboxed when it is
 *    not will make worse decisions than one that knows.
 */
/**
 * Sent once at initialize, on every chat, and some hosts truncate long ones:
 * kept with the workspace text under 300 words (instructions.test.ts).
 */
export const COMPUTER_INSTRUCTIONS =
  'Husk gives you a computer, usually a Linux container; /work persists for this session. Call ' +
  '`computer_info` once before assuming a runtime or even a POSIX shell: on Windows without WSL it is cmd.exe.\n' +
  'Pick the tool: `browse` to read a public page fast; `browser_*` for logins, pages that need JavaScript, ' +
  'forms and anything that needs a session; `shell` for everything else. Take a `browser_snapshot` before ' +
  'you click or type, and act on its refs; never guess.\n' +
  'On an error, read its hint and retry once with a fix. If it fails again, explain to the user instead of looping.\n' +
  'For a login, 2FA, CAPTCHA or payment prompt, call `hand_off` and let the user do it. Never try to solve ' +
  "a CAPTCHA, and never type the user's credentials yourself.";

/** Binding keys of computers made for a chat that carries its own id. */
const CHAT_KEY_PREFIX = 'chat:';

/** How long a tool call waits on the in-chat "Done?" before handing the model the link instead. */
const ELICIT_WAIT_MS = 200_000;

/**
 * Whether a handoff asks "Done?" in the chat, or gives a link at once: the
 * client declares form elicitation (`elicitation: {}` means form mode; one
 * that lists only `url` has no form) and is one known to show it (`chatClient`
 * in @husk-ai/core). Declaring it is not enough: Claude Desktop has been seen
 * to declare it and never show the dialog, which would leave the person
 * waiting minutes for a link.
 * https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
 */
export function asksInChat(clientName: string, elicitation: { form?: unknown; url?: unknown } | undefined): boolean {
  if (!elicitation || (elicitation.form === undefined && elicitation.url !== undefined)) return false;
  return chatClient(clientName).asksInChat;
}

/** The tool a chat collects a call with when the call outlasted its app's wait. */
export const JOB_WAIT_TOOL: ToolDef = {
  name: 'job_wait',
  description:
    'Get the result of a Husk call that answered "still running". It waits as long as this chat ' +
    'app allows a call, then says again if the job is not done yet. The job goes on in the computer ' +
    'either way, so call this rather than running the work again.',
  inputSchema: {
    type: 'object',
    properties: { job: { type: 'string', description: 'The job id the call gave.' } },
    required: ['job'],
  },
};

/**
 * A 2026-07-28 request's own `_meta` envelope, empty on the older protocol.
 * Keyed by the SDK's constants, which its published type leaves out.
 */
function envelopeOf(ctx: ServerContext): Record<string, unknown> {
  return (ctx.mcpReq.envelope ?? {}) as Record<string, unknown>;
}

/** A call that outlasted its app's wait, still running or not yet collected. */
interface Job {
  tool: string;
  started: number;
  result: Promise<CallToolResult>;
}

/** How often a chat checks whether the person finished in the console. */
const MIRROR_POLL_MS = 2_000;

export class HuskMcpServer {
  private readonly mcp: Server;
  private readonly manager: ComputerManager;
  private readonly sessionKey: string;
  private readonly namedSession: boolean;
  private readonly spec: ComputerSpec;
  private readonly ephemeral: boolean;
  private readonly log: Logger;
  /** How this process tells its chats apart. Fixed at startup. */
  private readonly identity: IdentitySource;
  /** A bot that continues a Claude Code chat names that chat, and gets its computer, files and logins (HUSK_CHAT_SESSION). */
  private readonly hostSessionId = process.env.HUSK_CHAT_SESSION || process.env.CLAUDE_CODE_SESSION_ID;
  /** This process's computers. One for a session; one per chat when chats share the process. */
  private readonly computers = new Map<string, Computer>();
  private creating: Promise<Computer> | undefined;
  /** Computers whose first tool result has gone out with the isolation note. */
  private readonly announced = new Set<string>();
  private readonly idleStopMs: number;
  /** Per computer: tool calls in flight, and the timer that stops it once there are none. */
  private readonly inFlight = new Map<string, number>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Idle stops in progress. A call that arrives mid-stop waits for it, then starts the computer. */
  private readonly stopping = new Map<string, Promise<void>>();
  /** Set once a computer exists and turns out not to be Linux. */
  private degraded = false;
  private profile: WorkspaceProfile;
  private readonly workspaceStore: WorkspaceStore;
  private readonly workspaceTools: WorkspaceTools;
  private viewer?: Promise<{ url: string; origin: string; close: () => Promise<void> }>;
  /** The shared Husk, found on the first computer tool call. */
  private daemon?: Promise<DaemonClient | undefined>;
  /** Starting the shared Husk again after it went away mid-handoff; one at a time. */
  private reviving?: Promise<unknown>;
  /** Why this chat's calls run here rather than in the shared Husk, when connecting left them here. */
  private localReason: string | undefined;
  /** Computers this chat has told the model it runs itself, so it is said once. */
  private readonly toldLocal = new Set<string>();
  /** Why the shared Husk could not reach a computer this chat now runs itself. */
  private readonly inChatReason = new Map<string, string>();
  /**
   * Computers the shared Husk served this chat's last call on. It owns their
   * lifecycle, so this process stops none of them: it cannot see a person
   * holding one, and would stop Chromium in the middle of their login.
   */
  private readonly viaShared = new Set<string>();
  /**
   * Handoffs this chat opened in the shared Husk, by the local id the model
   * sees. The local registry mirrors each one, so every check that asks "is a
   * person holding this computer?" keeps working unchanged.
   */
  private readonly remoteHandoffs = new Map<string, string>();
  /** Computers the shared Husk cannot see, so their tools -- and browser -- stay in this process. */
  private readonly localComputers = new Set<string>();
  private readonly useDaemon: boolean;
  private readonly connect: () => Promise<DaemonClient | undefined>;
  /** Handoffs open in this session. A person ends one; closing the session ends them all. */
  private readonly handoffs = new HandoffRegistry();
  private readonly closing = new AbortController();
  /** Calls that outlasted their app's wait, by the id the chat collects them with. */
  private readonly jobs = new Map<string, Job>();
  private readonly callWaitMs: number | undefined;
  /** Short-lived links, each scoped to one computer or one computer-less handoff. */
  private readonly tokens = new ScopedTokens();
  /** Ended from the viewer, so a later hand_off_done for one is an answer, not an error. */
  private readonly handedBack = new Set<string>();
  private confirmedProvider?: string;
  /** Who the app says it is and what it shows: each request's own on 2026-07-28, its `initialize` before. */
  private clientInfo?: Implementation;
  private clientCaps?: ClientCapabilities;
  /**
   * The handoff an in-chat "Done?" is about, sealed into the request state the
   * app echoes back with its answer (2026-07-28). Signed with a key of this
   * process's own: only it holds the handoff, so only it can finish one.
   */
  private readonly asked = createRequestStateCodec<{ handoff: string }>({
    key: randomBytes(32),
    // A login can take a while, and an answer to an expired "Done?" is refused.
    ttlSeconds: 86_400,
    bind: (ctx) => ctx.mcpReq.method,
  });
  /** Each open handoff's link, to give again when the person answers "not yet". */
  private readonly handoffLinks = new Map<string, string>();
  private stdio?: StdioServerHandle;
  private readonly remote: HuskMcpOptions['remote'];

  constructor(opts: HuskMcpOptions = {}) {
    this.manager = opts.manager ?? new ComputerManager();
    this.namedSession = opts.sessionKey !== undefined || process.env.HUSK_SESSION !== undefined;
    this.sessionKey = opts.sessionKey ?? process.env.HUSK_SESSION ?? `mcp-${randomUUID()}`;
    // Claude Code runs one server process per session and says which, in
    // CLAUDE_CODE_SESSION_ID (https://code.claude.com/docs/en/env-vars). Other
    // hosts may share one process across every chat, so there the chat itself
    // carries its computer id forward.
    this.remote = opts.remote;
    this.identity = opts.remote ? 'first-call' : this.namedSession ? 'named' : this.hostSessionId ? 'session' : 'first-call';
    this.spec = opts.spec ?? {};
    this.ephemeral = opts.ephemeral ?? true;
    this.useDaemon = opts.daemon ?? true;
    if (opts.shared) this.daemon = Promise.resolve(opts.shared);
    this.connect = opts.connect ?? (() => connectDaemon({ log: this.log, onLocal: (why) => (this.localReason = why) }));
    this.idleStopMs = opts.idleStopMs ?? 10 * 60 * 1000;
    this.callWaitMs = opts.callWaitMs;
    this.profile = opts.profile ?? 'computer';
    this.workspaceStore = opts.workspaceStore ?? new WorkspaceStore();
    this.workspaceTools = new WorkspaceTools(this.workspaceStore, () => this.openViewer());
    // stderr only: stdout is the protocol.
    this.log = opts.logger ?? createLogger({ scope: 'mcp' });

    this.mcp = this.newServer();
  }

  /**
   * A protocol instance over this Husk's state: the one stdio serves, or one
   * for each request when remote access serves an app over HTTP (remote.ts).
   */
  newServer(): Server {
    const server = new Server(
      { name: 'husk', version: HUSK_VERSION },
      {
        // `listChanged` is declared because the tool descriptions are not final
        // at this point: see `announceDegradation`.
        capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
        instructions: this.remote
          ? COMPUTER_INSTRUCTIONS
          : WORKSPACE_INSTRUCTIONS + '\n' + (this.profile === 'starter'
            ? 'This session starts with workspace tools only. The user can enable computer tools in the viewer Advanced settings after reviewing the environment.'
            :
            COMPUTER_INSTRUCTIONS),
        requestState: { verify: this.asked.verify },
      },
    );
    this.registerHandlers(server);
    return server;
  }

  private registerHandlers(server: Server): void {
    server.setRequestHandler('tools/list', async (_request, ctx) => {
      this.noteClient(ctx);
      // Plain JSON Schema objects, each with `type: 'object'`, which ToolDef does not spell out.
      // Workspaces live on the machine Husk runs on, and fetch from its network: never a remote chat's.
      const workspace = this.remote ? [] : WORKSPACE_TOOLS;
      return { tools: [...workspace, ...(this.profile === 'computer' ? this.computerTools() : [])] as Tool[] };
    });

    // The computer card, for clients that render MCP Apps. CSP is left empty on
    // purpose: the card makes no network requests, so the host's restrictive default fits.
    server.setRequestHandler('resources/list', async () => ({
      resources: [{ uri: CARD_URI, name: 'Husk computer card', mimeType: CARD_MIME }],
    }));
    server.setRequestHandler('resources/read', async (request) => {
      if (request.params.uri !== CARD_URI) throw new Error(`Unknown resource ${request.params.uri}`);
      return { contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: CARD_HTML, _meta: { ui: { csp: {} } } }] };
    });

    server.setRequestHandler('prompts/list', async () => ({ prompts: this.profile === 'computer' ? PROMPTS : [] }));
    server.setRequestHandler('prompts/get', async (request) => getPrompt(request.params.name, request.params.arguments));

    server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult | InputRequiredResult> => {
      this.noteClient(ctx);
      const extra = ctx.mcpReq;
      const { name, arguments: args } = request.params;
      if (WORKSPACE_TOOL_NAMES.has(name)) {
        if (this.remote) return { isError: true, content: [{ type: 'text', text: 'Workspace tools are not offered remotely: they work on the files of the machine Husk runs on.' }] };
        return this.workspaceTools.call(name, (args ?? {}) as Record<string, unknown>);
      }
      if (this.profile !== 'computer') return { isError: true, content: [{ type: 'text', text: 'Computer tools are disabled. The user can enable them from Advanced in the workspace viewer after reviewing the environment.' }] };
      if (CARD_APP_TOOL_NAMES.has(name)) return this.cardTool(name, (args ?? {}) as Record<string, unknown>);
      if (name === OPEN_UI_TOOL.name) return this.openUi((args ?? {}) as Record<string, unknown>);
      if (HANDOFF_TOOL_NAMES.has(name)) {
        const a = (args ?? {}) as Record<string, unknown>;
        try {
          if (name === 'hand_off_done') return await this.handOffDone(a);
          // A handoff with no computer is still a handoff ("approve it on your phone"),
          // and "new" means this chat has none yet: nothing is created just to hand it off.
          const wanted = a.computer === 'new' ? undefined : a.computer;
          const target = wanted !== undefined || this.computers.size === 1 ? await this.resolve(wanted) : undefined;
          if (typeof target === 'string') return { isError: true, content: [{ type: 'text', text: target }] };
          return await this.handOff(a, extra.signal, target, ctx);
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: redact((err as Error).message) }] };
        }
      }
      if (name === JOB_WAIT_TOOL.name) return this.jobWait((args ?? {}) as Record<string, unknown>);
      // An app that gives up on a call after a while is answered before it does:
      // the call goes on, and the chat collects it with job_wait. So it stops when
      // the chat cancels it before that answer, or this process closes, and not
      // because the request it came in on was answered.
      const signal = AbortSignal.any([extra.signal, this.closing.signal]);
      return this.answered({ tool: name, started: Date.now(), result: this.computerCall(name, (args ?? {}) as Record<string, unknown>, signal) });
    });
  }

  private async computerCall(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    const { computer: requested, ...toolArgs } = args;
    let computer: Computer;
    try {
      const resolved = await this.resolve(requested);
      if (typeof resolved === 'string') return { isError: true, content: [{ type: 'text', text: resolved }] };
      computer = resolved;
    } catch (err) {
      const error = err as Error & { hint?: string };
      const text = `Computer unavailable: ${error.message}\n${error.hint ?? 'Run husk doctor to check the provider, then retry.'}`;
      return { isError: true, content: [{ type: 'text', text: redact(text) }] };
    }
    // The person holds the computer until they say done. The model must not
    // type into the page they are signing in on, or run commands under them.
    const held = this.handoffs.list().find((h) => !h.computerId || h.computerId === computer.id);
    if (held && name !== 'computer_info') {
      // Taken from a link, not handed off by the model: only the person's Give back ends it.
      return { isError: true, content: [{ type: 'text', text: refusalText(held) }] };
    }
    // Remotely, a call that changes things waits for the owner's word, every
    // time, on a page that shows all of it; one too big to show never runs.
    if (this.remote?.approve && DANGEROUS_TOOLS.has(name)) {
      const detail = exactly(toolArgs);
      if (detail.length > MAX_SHOWN) return { isError: true, content: [{ type: 'text', text: tooBigText(name, detail.length) }] };
      const verdict = this.remote.approve({ tool: name, summary: summarize(name, toolArgs), detail, digest: digestOf(name, computer.id, toolArgs) });
      if (!verdict.ok) return { content: [{ type: 'text', text: approvalText(name, verdict, computer.id) }], ...(verdict.state === 'denied' ? { isError: true } : {}) };
    }

    // Every call, at the one place they all pass through. An audit log that
    // has to be remembered at each new tool is an audit log with holes -- and
    // this path had no log at all until now, which is the more embarrassing
    // version of the same problem.
    this.busy(computer.id, +1);
    let result: Awaited<ReturnType<typeof callTool>>;
    try {
      result = await this.runTool(computer, name, toolArgs, signal);
    } finally {
      this.busy(computer.id, -1);
    }

    const content = [...result.content];
    if (!this.announced.has(computer.id)) {
      this.announced.add(computer.id);
      const carry =
        this.identity === 'first-call'
          ? ` Your computer id is ${computer.id}: pass computer: "${computer.id}" on every later Husk call in this conversation.`
          : '';
      // A client that renders no card (Claude Code, most terminals) shows nothing
      // of the computer unless the model passes a link on.
      const link = this.rendersCards() ? '' : await this.announceLink(computer.id);
      // Kept on another provider than asked -- made while that one was down -- is said, not silent.
      const asked = this.spec.provider;
      const elsewhere =
        asked && computer.info.provider !== asked
          ? ` It runs on ${computer.info.provider}, not the ${asked} this chat asked for: it was made when ${asked} ` +
            `was not available, and a chat keeps its computer. Tell the user; a new chat gets one on ${asked}.`
          : '';
      content.unshift({ type: 'text', text: `${this.isolationNote(computer)}${elsewhere}${carry}${link}\n` });
    }
    // computer_info is where a chat's card first appears; it needs the state, never a token.
    const card = name === 'computer_info' && this.rendersCards() ? { structuredContent: { ...(await this.cardState(computer.id)) } } : {};
    return { content, ...card, ...(result.isError ? { isError: true } : {}) };
  }

  /** How long a call is held before it answers "still running"; 0 where the app waits as long as a call takes. */
  private waitMs(): number {
    return this.callWaitMs ?? (chatClient(this.clientName()).waitSec ?? 0) * 1000;
  }

  /**
   * Keep what a 2026-07-28 request says of the app sending it: that revision has
   * no `initialize`, so each request carries it. One stdio process serves one
   * app, so the latest word holds for the calls that follow.
   */
  private noteClient(ctx: ServerContext): void {
    const envelope = envelopeOf(ctx);
    const info = envelope[CLIENT_INFO_META_KEY] as Implementation | undefined;
    const caps = envelope[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
    if (info) this.clientInfo = info;
    if (caps) this.clientCaps = caps;
  }

  private clientName(): string {
    // Its `initialize` on a 2025-era connection, which the SDK still keeps.
    return (this.clientInfo ?? this.mcp.getClientVersion())?.name ?? '';
  }

  private clientCapabilities(): ClientCapabilities | undefined {
    return this.clientCaps ?? this.mcp.getClientCapabilities();
  }

  /**
   * A call's result if it ends within the app's wait. Otherwise the call goes
   * on as job `id` (a new one the first time), and the answer says how to
   * collect it. ponytail: a job nobody collects keeps its result until this
   * process ends; expire them if chats start leaving many behind.
   */
  private async answered(job: Job, id?: string): Promise<CallToolResult> {
    const ms = this.waitMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolveLate) => {
      if (ms) timer = setTimeout(() => resolveLate(undefined), ms);
    });
    const done = await Promise.race([job.result, late]).finally(() => clearTimeout(timer));
    if (done) {
      if (id) this.jobs.delete(id);
      return done;
    }
    if (!id) this.jobs.set((id = randomUUID().slice(0, 8)), job);
    const secs = Math.round((Date.now() - job.started) / 1000);
    return { content: [{ type: 'text', text: `${job.tool} is still running after ${secs}s, and goes on in the computer. Call job_wait with job "${id}" for its result.` }] };
  }

  private jobWait(args: Record<string, unknown>): Promise<CallToolResult> | CallToolResult {
    const id = String(args.job ?? '');
    const job = this.jobs.get(id);
    if (!job) {
      return { isError: true, content: [{ type: 'text', text: `There is no job "${id}" here: its result was already given, or this chat's Husk has restarted since and lost it.` }] };
    }
    return this.answered(job, id);
  }

  /**
   * Run a computer tool in the shared Husk when there is one, so it owns this
   * chat's browser and the console sees the call; otherwise here, as before.
   * The shared Husk audits the calls it runs, so they are audited once either way.
   */
  private async runTool(computer: Computer, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    let daemon = this.localComputers.has(computer.id) ? undefined : await this.shared();
    let why = this.localComputers.has(computer.id) ? this.inChatReason.get(computer.id) : daemon ? undefined : this.localReason;
    for (let tries = 0; daemon; tries++) {
      try {
        const result = await daemon.callTool(computer.id, name, args, signal);
        // Back on the shared Husk: a later fall-back is worth saying again.
        this.toldLocal.delete(computer.id);
        this.viaShared.add(computer.id);
        return result;
      } catch (err) {
        if (err instanceof RunLocally) {
          this.log.info(`${err.message}; its tools run in this process`);
          this.localComputers.add(computer.id);
          this.inChatReason.set(computer.id, (why = err.message));
          void daemon.markInChat(computer.id).catch(() => undefined);
          daemon = undefined;
        } else if (err instanceof DaemonUnreachable) {
          // Nothing ran there. Start it again and retry once: only then does the
          // call run here, where the console cannot see or take over the computer.
          this.daemon = undefined;
          daemon = tries === 0 ? await this.shared() : undefined;
          this.log.warn(`${err.message}; ${daemon ? 'started it again, retrying there' : 'running this call in this process'}`);
          if (!daemon) why = this.localReason ?? err.message;
        } else {
          return { isError: true, content: [{ type: 'text', text: redact(`the shared husk did not answer: ${(err as Error).message}`) }] };
        }
      }
    }
    this.viaShared.delete(computer.id);
    return this.toldOnce(computer.id, why, await this.runHere(computer, name, args, signal));
  }

  /**
   * The first call this chat runs itself, while a shared Husk was expected,
   * says so: the model passes it on, and nobody wonders why the console
   * shows nothing.
   */
  private toldOnce(computerId: string, why: string | undefined, result: ToolResult): ToolResult {
    if (!why || this.toldLocal.has(computerId)) return result;
    this.toldLocal.add(computerId);
    const note =
      `[husk] This computer is running in this chat's own process (${why}), so the Husk console cannot show it ` +
      'or take it over; its link from computer_open_ui still can. Tell the user.';
    return { ...result, content: [{ type: 'text', text: note }, ...result.content] };
  }

  private runHere(computer: Computer, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    // Its own computer: the take-over from this chat's viewer stops it, as the shared Husk's does.
    return underControl(this.handoffs, computer.id, name, signal, (stop) =>
      audited(
        { computerId: computer.id, via: 'mcp', tool: name, args },
        () => callTool(computer, name, args, stop),
        // MCP tools report failure in the result rather than by throwing, so
        // the wrapper is told how to recognise one.
        (r) => (r.isError ? firstText(r.content) : undefined),
      ),
    );
  }

  /** The shared Husk, found (or started) once per process. */
  private shared(): Promise<DaemonClient | undefined> {
    return (this.daemon ??= this.useDaemon ? this.connect() : Promise.resolve(undefined));
  }

  /**
   * The shared Husk went away while a handoff waits on it: start it again. Its
   * clients find the new one by its record, so the handoff's own polling goes on.
   */
  private revive(): void {
    this.reviving ??= (async () => {
      this.daemon = undefined;
      await this.shared();
    })().finally(() => {
      this.reviving = undefined;
    });
  }

  /** One honest line about what this machine actually is. */
  private isolationNote(computer: Computer): string {
    return isolationNote(computer.info);
  }

  /**
   * Correct the tool descriptions once the machine turns out not to be Linux.
   *
   * The descriptions and the server instructions are fixed before any computer
   * exists -- nothing is created until the first tool call, and that is a
   * constraint worth keeping: probing the host at construction would put a
   * `wsl.exe` spawn into the cost of merely having the server installed.
   *
   * So the list starts optimistic and is corrected here, which is what
   * `notifications/tools/list_changed` is for. A client that ignores it is
   * exactly as well off as it was before this existed; a client that honours
   * it re-reads a `shell` description that no longer says "your Linux
   * computer" or "run with sh -c" on a machine where both are false.
   *
   * The instructions cannot be corrected the same way -- they are sent once at
   * initialize -- so they no longer promise Linux in the first place.
   */
  private async announceDegradation(computer: Computer): Promise<void> {
    if (this.degraded) return;
    if (!computer.info.spec.labels?.['husk.degradation']) return;
    this.degraded = true;
    // Never fatal: a client that does not support the notification must not
    // take down the tool call that happened to create the machine.
    await quiet(() => this.mcp.sendToolListChanged());
  }

  /**
   * The computer a call is for. A string is a refusal to hand back to the model:
   * an id this process does not own, or no id when more than one would fit.
   * Nothing is guessed and nothing is created on an ambiguous call.
   */
  private async resolve(requested: unknown): Promise<Computer | string> {
    const id = typeof requested === 'string' ? requested.trim() : '';
    if (id && id !== 'new') {
      const own = this.computers.get(id) ?? (await this.wake(id));
      if (own) return this.ready(own);
      return (
        `There is no Husk computer "${id}" for this conversation. Use the id an earlier Husk result in this ` +
        'conversation gave you, or pass computer: "new" if this conversation has none yet.'
      );
    }
    // One process, one chat: there is only ever this one computer.
    if (this.identity !== 'first-call') return this.single();
    if (id === 'new') return this.createComputer();
    // No id from a host that may share this process across chats. Creating is
    // safe only while nothing exists: then the computer can only be this chat's.
    // Reusing one could hand this chat another chat's computer, so never.
    if (this.computers.size === 0) return this.single();
    return (
      'Pass computer: "<id>" with the Husk computer id an earlier Husk result in this conversation gave you, ' +
      'or computer: "new" if this conversation has none yet. Husk does not guess, because this app may run ' +
      'other chats through the same Husk.'
    );
  }

  /**
   * A chat's computer from an earlier process: the app restarted, or the PC did.
   * Only an id bound as a chat computer is woken -- never another session's,
   * a named one, or anything made outside MCP -- and its /work comes back with it.
   */
  private async wake(id: string): Promise<Computer | undefined> {
    if (this.identity !== 'first-call') return undefined;
    const key = await this.manager.keyFor(id);
    if (!key?.startsWith(this.keyPrefix())) return undefined;
    const found = await this.manager.get(id);
    if (!found || found.info.state === 'destroyed') return undefined;
    this.computers.set(found.id, found);
    return found;
  }

  /** Count a call in or out, and stop the computer once it has been idle for a while. */
  private busy(id: string, delta: 1 | -1): void {
    const n = (this.inFlight.get(id) ?? 0) + delta;
    this.inFlight.set(id, n);
    const timer = this.idleTimers.get(id);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(id);
    if (n === 0 && !this.viaShared.has(id)) this.arm(id);
  }

  private arm(id: string): void {
    const t = setTimeout(() => void this.idleStop(id), this.idleStopMs);
    t.unref?.();
    this.idleTimers.set(id, t);
  }

  /**
   * Idle: stop it so it uses no CPU or memory. Its files stay, and the chat's
   * next call starts it again. Not while the person holds it in a handoff.
   */
  private async idleStop(id: string): Promise<void> {
    this.idleTimers.delete(id);
    const c = this.computers.get(id);
    if (!c || (this.inFlight.get(id) ?? 0) > 0) return;
    if (this.handoffs.list().some((h) => h.computerId === id)) return this.arm(id);
    const stop = quiet(() => c.stop()).then(() => undefined);
    this.stopping.set(id, stop);
    try {
      await stop;
      this.log.info(`computer ${id} idle, stopped`);
    } finally {
      this.stopping.delete(id);
    }
  }

  /**
   * Running and ready for a call. If an idle stop is under way, wait for it to
   * finish first: `docker stop` takes seconds, and inspect says "running" until
   * it is done, so starting a call in the middle would exec into a dying container.
   */
  private async ready(c: Computer): Promise<Computer> {
    await this.stopping.get(c.id);
    return ensureRunning(c);
  }

  /** The only computer, created once even under concurrent calls. */
  private async single(): Promise<Computer> {
    const only = [...this.computers.values()][0];
    if (only) return this.ready(only);
    this.creating ??= this.createComputer();
    try {
      return await this.creating;
    } finally {
      this.creating = undefined;
    }
  }

  private async createComputer(): Promise<Computer> {
    const platform = this.remote?.platform ?? platformName(this.clientName());
    const n = this.computers.size;
    const spec = {
      name: n === 0 ? `mcp-${this.sessionKey}` : `mcp-${this.sessionKey}-${n + 1}`,
      persist: true,
      ...this.spec,
      // Never reaped: an idle or lifetime limit would destroy it, and a chat's
      // computer goes only when the user deletes it. Idle means stopped instead.
      idleTimeoutSec: 0,
      maxLifetimeSec: 0,
      labels: {
        ...(this.spec.labels ?? {}),
        'husk.via': 'mcp',
        [IDENTITY_LABELS.platform]: platform,
        [IDENTITY_LABELS.chat]: chatLabel(platform, this.identity),
        [IDENTITY_LABELS.identity]: this.identity,
        // Claude Code names its transcript after this id, so "Make this a bot"
        // can read the chat back. An id, never the chat's content.
        ...(this.identity === 'session' && this.hostSessionId ? { 'husk.session': this.hostSessionId } : {}),
      },
    };
    // Every chat's computer is bound, so a later process can wake it by id.
    const c = await this.manager.ensure(this.bindingKey(), spec);
    this.log.info(`computer ready: ${c.id} (${c.info.provider})`);
    this.computers.set(c.id, c);
    await this.announceDegradation(c);
    return c;
  }

  private bindingKey(): string {
    if (this.identity === 'named') return this.sessionKey;
    if (this.identity === 'session') return `claude-code:${this.hostSessionId}`;
    return `${this.keyPrefix()}${randomUUID()}`;
  }

  /** What this process's chat computers are bound under: a remote owner's apart from this machine's chats. */
  private keyPrefix(): string {
    return this.remote ? `remote:${this.remote.owner}:` : CHAT_KEY_PREFIX;
  }

  /**
   * Where chats share this process, every computer tool takes the computer's
   * id. Each chat's own history carries its own id, which is the only signal
   * that is valid on every host.
   */
  private withComputerArg(tools: ToolDef[]): ToolDef[] {
    if (this.identity !== 'first-call') return tools;
    return tools.map((t) =>
      t.name === 'hand_off_done'
        ? t
        : {
            ...t,
            inputSchema: {
              ...t.inputSchema,
              properties: {
                ...((t.inputSchema.properties ?? {}) as Record<string, unknown>),
                computer: {
                  type: 'string',
                  description:
                    'Which Husk computer: the id an earlier Husk result in this conversation gave you. ' +
                    'If this conversation has none yet, pass "new".',
                },
              },
            },
          },
    );
  }

  async connectStdio(): Promise<void> {
    // Both protocol eras, one instance for the connection: an app that opens with
    // `initialize` (2025-11-25 and before), or with 2026-07-28's per-request envelope.
    this.stdio = serveStdio(() => this.mcp, { onerror: (err) => this.log.warn(`mcp: ${err.message}`) });
    this.log.info(`husk mcp ready (session "${this.sessionKey}")`);
  }

  /** For embedding in an existing HTTP server. */
  get server(): Server {
    return this.mcp;
  }

  /**
   * Give the computer to the person, and wait for them only where the client
   * can ask them in-chat. Nothing here resumes on a timeout: a prompt that times
   * out, errors or is dismissed leaves the handoff open, and the model is told
   * to wait for the person's own word.
   */
  private async handOff(
    args: Record<string, unknown>,
    callSignal: AbortSignal,
    computer?: Computer,
    ctx?: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult> {
    // 2026-07-28: the app asked "Done?" and calls again with the person's answer.
    const asked = ctx?.mcpReq.requestState<{ handoff: string }>();
    if (asked?.handoff) return this.answeredInChat(asked.handoff, ctx!);
    const text = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (!text) throw new Error('hand_off needs a reason the user can read.');
    if (text.length > MAX_REASON) throw new Error(`hand_off reason is over ${MAX_REASON} characters.`);
    // Model text, headed for a person's screen.
    const reason = redact(text);

    const open = this.handoffs.list().find((h) => !h.computerId || !computer || h.computerId === computer.id);
    if (open) throw new Error(open.runId === PERSON_RUN ? takenText(open.handoffId) : heldText(open.handoffId, open.reason));

    // In the shared Husk when there is one: it holds this chat's browser, and its
    // console, the overview and Husk Bar show the person what is waiting.
    // Only where its browser is: a computer whose tools run here hands off here.
    const daemon = computer && !this.localComputers.has(computer.id) ? await this.shared() : undefined;
    let remote: { handoffId: string; token: string } | undefined;
    if (daemon && computer) {
      try {
        // A remote chat's person opens it under the public URL, which takes only links minted for its app.
        remote = await daemon.openHandoff(computer.id, reason, computer.info.spec.labels?.[IDENTITY_LABELS.chat], this.remote?.client);
      } catch (err) {
        if (err instanceof RunLocally) this.localComputers.add(computer.id);
        this.log.warn(`handing off in this process: ${(err as Error).message}`);
      }
    }
    // Before the handoff opens: if the viewer cannot start, nothing is left
    // holding the computer with no link to finish it.
    const origin = remote && daemon ? (this.remote?.origin ?? daemon.url) : (await this.openViewerServer()).origin;
    let handoffId = '';
    const finished = this.handoffs.request(
      {
        runId: this.sessionKey,
        husk: 'chat',
        reason,
        ...(computer ? { computerId: computer.id } : {}),
        signal: this.closing.signal,
      },
      (pending) => {
        handoffId = pending.handoffId;
      },
    );
    if (daemon && remote) this.mirror(daemon, handoffId, remote.handoffId, finished);
    void finished.then((outcome) => {
      if (outcome === 'done') this.handedBack.add(handoffId);
      // A link minted for this handoff alone dies with it.
      this.tokens.revoke(`handoff:${handoffId}`);
      this.handoffLinks.delete(handoffId);
    });
    const link = remote
      ? handoffLink(origin, remote.handoffId, remote.token, this.remote ? REMOTE_LINK_PAGE : '/')
      : handoffLink(origin, handoffId, this.tokens.mint(computer ? `computer:${computer.id}` : `handoff:${handoffId}`));
    this.handoffLinks.set(handoffId, link);

    // In-chat "Done?" where the client shows it; a link everywhere else.
    if (asksInChat(this.clientName(), this.clientCapabilities()?.elicitation)) {
      const done = {
        mode: 'form' as const,
        message: `${reason}\n\nOpen ${link} on this device to see and use the computer's browser. Answer here when you are done.`,
        requestedSchema: {
          type: 'object' as const,
          properties: { done: { type: 'boolean' as const, title: "I'm done", description: 'Hand the computer back to the AI.' } },
          required: ['done'],
        },
      };
      // 2026-07-28 has no server-to-client request: the app asks, then calls again with the answer.
      if (ctx && envelopeOf(ctx)[PROTOCOL_VERSION_META_KEY]) {
        return inputRequired({ inputRequests: { done: inputRequired.elicit(done) }, requestState: await this.asked.mint({ handoff: handoffId }, ctx) });
      }
      const stop = new AbortController();
      const onCallAbort = (): void => stop.abort();
      callSignal.addEventListener('abort', onCallAbort, { once: true });
      try {
        // On the instance that served this call: over HTTP that is not the stdio one.
        const elicit = ctx ? ctx.mcpReq.elicitInput : this.mcp.elicitInput.bind(this.mcp);
        const asked = Promise.resolve()
          .then(() => elicit(
            done,
            // Under the app's own limit on a call, so the model still gets the
            // link back. When this fires the handoff stays open.
            { signal: stop.signal, timeout: Math.min(ELICIT_WAIT_MS, this.waitMs() || ELICIT_WAIT_MS) },
          ))
          .then((r) => (r.action === 'accept' && r.content?.done === true ? 'done' : 'not-yet'))
          .catch(() => 'not-yet' as const);
        // The person may press Done in the viewer before answering the prompt.
        const answer = await Promise.race([asked, finished.then((o) => (o === 'done' ? 'done' : 'not-yet'))]);
        if (answer === 'done') {
          await this.completeHandoff(handoffId);
          return { content: [{ type: 'text', text: HANDED_BACK }] };
        }
      } finally {
        stop.abort();
        callSignal.removeEventListener('abort', onCallAbort);
      }
    }
    const card = computer && this.rendersCards() ? { structuredContent: { ...(await this.cardState(computer.id)) } } : {};
    return { content: [{ type: 'text', text: relayText(handoffId, reason, link) }], ...card };
  }

  /**
   * The person's answer to the in-chat "Done?" (2026-07-28). Done hands the
   * computer back; anything else leaves the handoff open and gives the model
   * the link to relay, as a dismissed prompt does on the older protocol.
   */
  private async answeredInChat(handoffId: string, ctx: ServerContext): Promise<CallToolResult> {
    // Done in the viewer while the prompt was up.
    if (this.handedBack.has(handoffId)) return { content: [{ type: 'text', text: HANDED_BACK }] };
    const open = this.handoffs.list().find((h) => h.handoffId === handoffId);
    if (!open) return { isError: true, content: [{ type: 'text', text: `There is no open handoff "${handoffId}".` }] };
    if (acceptedContent(ctx.mcpReq.inputResponses, 'done')?.done === true) {
      await this.completeHandoff(handoffId);
      return { content: [{ type: 'text', text: HANDED_BACK }] };
    }
    return { content: [{ type: 'text', text: relayText(handoffId, open.reason, this.handoffLinks.get(handoffId) ?? '') }] };
  }

  /** Whether the client renders MCP Apps cards: it lists the UI extension with our MIME type. */
  private rendersCards(): boolean {
    const caps = this.clientCapabilities() as { extensions?: Record<string, { mimeTypes?: unknown }> } | undefined;
    const mimeTypes = caps?.extensions?.[UI_EXTENSION]?.mimeTypes;
    return Array.isArray(mimeTypes) && mimeTypes.includes(CARD_MIME);
  }

  /**
   * The computer tools this client sees. Card-capable clients get the card on
   * computer_info and hand_off, plus the two app-only tools the card calls;
   * other clients never see those, since they would show them to the model.
   * job_wait is for apps that give up on a call, so only they see it.
   */
  private computerTools(): ToolDef[] {
    const base = [...toolsFor(this.degraded), ...HANDOFF_TOOLS, OPEN_UI_TOOL];
    const jobs = this.waitMs() ? [JOB_WAIT_TOOL] : [];
    if (!this.rendersCards()) return [...this.withComputerArg(base), ...jobs];
    const withCard = base.map((t) =>
      t.name === 'computer_info' || t.name === 'hand_off' ? { ...t, _meta: { ui: { resourceUri: CARD_URI } } } : t,
    );
    return [...this.withComputerArg(withCard), ...CARD_APP_TOOLS, ...jobs];
  }

  /** A computer this process owns, or a chat's computer from an earlier process. Never creates one. */
  private async known(id: unknown): Promise<Computer | undefined> {
    if (typeof id !== 'string' || !id) return undefined;
    return this.computers.get(id) ?? (await this.wake(id));
  }

  private async describe(computerId: string): Promise<{ computerId: string; label?: string; state: string } | undefined> {
    const c = this.computers.get(computerId);
    if (!c) return undefined;
    const label = c.info.spec.labels?.[IDENTITY_LABELS.chat];
    let state = c.info.state;
    try {
      state = (await c.refresh()).state;
    } catch {
      // the last known state will do for a status card
    }
    return { computerId, ...(label ? { label } : {}), state };
  }

  private async cardState(computerId: string): Promise<CardState> {
    const described = (await this.describe(computerId)) ?? { computerId, state: 'unknown' };
    // In the shared Husk the person may have taken it from the console: that hold is the one to show.
    const daemon = this.localComputers.has(computerId) ? undefined : await this.shared();
    const remote = daemon?.holdOn ? await daemon.holdOn(computerId).catch(() => undefined) : undefined;
    const hold = remote ?? this.handoffs.list().find((h) => h.computerId === computerId);
    if (!hold) return described;
    return {
      ...described,
      ...(hold.runId === PERSON_RUN ? { held: { handoffId: hold.handoffId } } : { waiting: { handoffId: hold.handoffId, reason: hold.reason } }),
    };
  }

  /** A fresh link for one computer: its handoff if one is waiting, otherwise a look at it. */
  private async linkFor(computerId: string): Promise<string> {
    // A computer whose tools run here is not in the shared Husk: its link is this process's viewer.
    const daemon = this.localComputers.has(computerId) ? undefined : await this.shared();
    if (daemon) {
      try {
        const token = await daemon.linkToken(computerId, this.remote?.client);
        const held = this.handoffs.list().find((h) => h.computerId === computerId);
        const remoteId = held ? this.remoteHandoffs.get(held.handoffId) : undefined;
        // A remote chat's person is wherever they are: the link is under the public URL, behind their passkey.
        const base = this.remote?.origin ?? daemon.url;
        const page = this.remote ? REMOTE_LINK_PAGE : '/';
        return remoteId ? handoffLink(base, remoteId, token, page) : computerLink(base, computerId, token, page);
      } catch (err) {
        // The shared Husk has no such computer: this process's viewer can still open it.
        if (!(err instanceof RunLocally)) throw err;
      }
    }
    const { origin } = await this.openViewerServer();
    const token = this.tokens.mint(`computer:${computerId}`);
    const held = this.handoffs.list().find((h) => h.computerId === computerId);
    return held ? handoffLink(origin, held.handoffId, token) : computerLink(origin, computerId, token);
  }

  /**
   * The card's two tools. Neither creates, starts or counts as using a
   * computer: a status card polling every few seconds must not keep one awake.
   */
  private async cardTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const c = await this.known(args.computer);
    if (!c) return { isError: true, content: [{ type: 'text', text: 'There is no Husk computer with that id here.' }] };
    if (name === 'computer_card_state') {
      const state = await this.cardState(c.id);
      return { content: [{ type: 'text', text: state.waiting ? 'Waiting for you' : `Computer ${state.state}` }], structuredContent: { ...state } };
    }
    const url = await this.linkFor(c.id);
    return { content: [{ type: 'text', text: url }], structuredContent: { url } };
  }

  /** The link for a chat's first computer call, or nothing if one cannot be made: the call itself already ran. */
  private async announceLink(computerId: string): Promise<string> {
    try {
      const url = await this.linkFor(computerId);
      return ` Tell the user they can watch this computer live and take it over at ${url} (it expires after 10 minutes unused).`;
    } catch (err) {
      this.log.warn(`no link for ${computerId}: ${(err as Error).message}`);
      return '';
    }
  }

  /** The plain-link fallback: what a card would open, as text the model can pass on. */
  private async openUi(args: Record<string, unknown>): Promise<CallToolResult> {
    // Opens a computer this chat already has; it never creates one just to show it.
    const existing =
      this.identity === 'first-call' ? await this.known(args.computer) : [...this.computers.values()][0];
    if (!existing) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              this.identity === 'first-call'
                ? 'Pass computer: "<id>" with the id an earlier Husk result in this conversation gave you. If this conversation has no computer yet, there is nothing to open.'
                : 'This conversation has no Husk computer yet, so there is nothing to open.',
          },
        ],
      };
    }
    const url = await this.linkFor(existing.id);
    return {
      content: [
        {
          type: 'text',
          text: `Give the user this link to open on this device: ${url}\nIt shows this chat's computer, and lets them take over if it is waiting for them. It expires after 10 minutes unused.`,
        },
      ],
    };
  }

  /** The model relays the person's "done". Only meaningful after hand_off. */
  private async handOffDone(args: Record<string, unknown>): Promise<CallToolResult> {
    const given = typeof args.handoff === 'string' ? args.handoff : '';
    // The shared Husk's refusal names its own id; accept that one too.
    const handoffId = [...this.remoteHandoffs].find(([, remote]) => remote === given)?.[0] ?? given;
    if (this.handedBack.has(handoffId)) return { content: [{ type: 'text', text: HANDED_BACK }] };
    if (!this.handoffs.isOpen(handoffId)) throw new Error(`There is no open handoff "${handoffId}".`);
    // The person took it; the model cannot take it back for them.
    if (this.handoffs.list().find((h) => h.handoffId === handoffId)?.runId === PERSON_RUN) throw new Error(takenText(handoffId));
    await this.completeHandoff(handoffId);
    return { content: [{ type: 'text', text: HANDED_BACK }] };
  }

  /** The person is done: in the shared Husk first, so the computer is free there before the model resumes. */
  private async completeHandoff(handoffId: string): Promise<void> {
    const remoteId = this.remoteHandoffs.get(handoffId);
    const daemon = remoteId ? await this.shared() : undefined;
    if (daemon && remoteId) {
      try {
        await daemon.complete(remoteId);
      } catch (err) {
        // Gone there (a restart lost it): nothing holds it there, and a computer
        // held under another handoff still refuses the model's calls.
        // Anything else: not handed back there, so not here either, and the
        // model must not resume on a computer the shared Husk still holds.
        if (!(err instanceof HandoffGone)) {
          throw new Error(`Could not hand the computer back: ${(err as Error).message}. Ask the user to press Done in the Husk console.`);
        }
      }
    }
    if (this.handoffs.isOpen(handoffId)) this.handoffs.complete(handoffId);
  }

  /**
   * Keep a local handoff in step with its twin in the shared Husk. Done in the
   * console ends the local one; this chat going away cancels the remote one,
   * so nobody's computer is left held by a conversation that no longer exists.
   */
  private mirror(daemon: DaemonClient, localId: string, remoteId: string, finished: Promise<unknown>): void {
    this.remoteHandoffs.set(localId, remoteId);
    // Polling also tells the shared Husk this chat is still here; a chat that
    // stops polling for a minute has its handoff cancelled there.
    const poll = setInterval(() => {
      void daemon.state(remoteId).then(
        (state) => {
          // Unknown is not ended: a shared Husk that restarted without it may
          // still hold the computer for the person, and only they end that.
          if (state === 'open' || state === 'unknown' || !this.handoffs.isOpen(localId)) return;
          // Done only when the person said so. Cancelled or expired is not
          // done, and the model is not told it was.
          if (state === 'done') this.handoffs.complete(localId);
          else this.handoffs.cancel(localId);
        },
        (err) => {
          // Gone mid-login: start it again, so the person's console and their hold come back.
          if (err instanceof DaemonUnreachable) this.revive();
        },
      );
    }, MIRROR_POLL_MS);
    poll.unref?.();
    void finished.then((outcome) => {
      clearInterval(poll);
      this.remoteHandoffs.delete(localId);
      if (outcome !== 'done') void daemon.cancel(remoteId).catch(() => undefined);
    });
  }

  async close(): Promise<void> {
    // Free this chat's computers in the shared Husk before going, briefly: the
    // process exits right after, and a lost cancel would hold a computer until
    // the shared Husk's lease runs out.
    const remotes = [...this.remoteHandoffs.values()];
    const daemon = remotes.length && this.daemon ? await this.daemon : undefined;
    if (daemon) {
      await Promise.race([
        Promise.allSettled(remotes.map((r) => daemon.cancel(r))),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
    this.closing.abort();
    if (this.viewer) await quiet(async () => (await this.viewer!).close());
    await quiet(() => this.mcp.close());
    if (this.stdio) await quiet(() => this.stdio!.close());
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    // Stopped, never destroyed: the chat may come back after a restart, and only
    // the user deletes a chat's computer. One the shared Husk served is its to
    // stop: it refuses while a person holds it, and finishes after this exits.
    if (!this.ephemeral) return;
    for (const c of this.computers.values()) if (!this.viaShared.has(c.id)) await quiet(() => c.stop());
    const shared = this.viaShared.size && this.daemon ? await this.daemon : undefined;
    if (shared) {
      await Promise.race([
        Promise.allSettled([...this.viaShared].map((id) => shared.stop(id))),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
  }

  private async openViewer(): Promise<string> {
    return (await this.openViewerServer()).url;
  }

  private openViewerServer(): Promise<{ url: string; origin: string; close: () => Promise<void> }> {
    this.viewer ??= startWorkspaceViewer({
      store: this.workspaceStore,
      handoffs: {
        registry: this.handoffs,
        tokens: this.tokens,
        // The link's view also needs where it runs: on ssh and fly it shows the screen only when asked.
        describe: async (id) => {
          const described = await this.describe(id);
          const provider = this.computers.get(id)?.info.provider;
          return described && provider ? { ...described, provider } : described;
        },
      },
      getProfile: () => this.profile,
      getCapabilities: async () => {
        const providers = await this.manager.status();
        const selected = this.spec.provider
          ? providers.find((p) => p.name === this.spec.provider && p.available)
          : providers.find((p) => p.available);
        this.confirmedProvider = selected?.name;
        return { providers, selected: selected ?? null };
      },
      setProfile: async (profile) => {
        if (profile === 'computer') {
          if (!this.confirmedProvider) throw new Error('Check the available environment before enabling computer tools.');
          const available = await this.manager.probe(this.confirmedProvider, true);
          if (!available.available) throw new Error(available.reason ?? 'The selected environment is no longer available. Check it again.');
          this.spec.provider = this.confirmedProvider;
        }
        this.profile = profile;
        await quiet(() => this.mcp.sendToolListChanged());
      },
    }).catch((error) => { this.viewer = undefined; throw error; });
    return this.viewer;
  }
}

/**
 * What the model is told about its machine, before its first tool result.
 *
 * The model is the party with the least information and the most at stake. It
 * cannot run `husk doctor`, it did not choose the provider, and it will act on
 * whatever this line says -- so this is the only place several facts reach it
 * at all.
 *
 * For a Windows host with no working WSL that fact is not "you are not
 * sandboxed", it is "your commands are not Linux". A model told it has a Linux
 * computer opens with `ls -la /work`, gets something cmd.exe said, and retries
 * variations of a command that was never going to work. Naming the shell is
 * not enough: "the Windows shell" is a label, and the model needs the
 * consequence.
 *
 * Exported because it is the product's first sentence to its primary consumer
 * and deserves a test that is not a subprocess.
 */
export function isolationNote(info: ComputerInfo): string {
  // What the provider cannot enforce of the network policy, said where the model reads first.
  const network = networkEnforcement(info.provider, info.spec.network);
  const note = computerNote(info);
  return network ? `${note} Note: ${network}.` : note;
}

function computerNote(info: ComputerInfo): string {
  const p = info.provider;
  if (p === 'docker' || p === 'podman') {
    return `[husk] ${p} container ${info.id}, isolated from the host. /work persists for this session.`;
  }
  if (p !== 'local') {
    return `[husk] computer ${info.id} on ${p}. /work persists for this session.`;
  }

  const guardrails =
    'This is a guarded working directory, NOT a sandbox: file tools are confined to /work ' +
    'and destructive commands are refused, but shell commands can still reach anything ' +
    'your user can on the host -- filesystem, kernel and network. Keep secrets and ' +
    'untrusted input out of it.';

  // Set by the local provider when a Windows host could not give it Linux.
  const degradation = info.spec.labels?.['husk.degradation'];
  if (degradation) {
    const fix =
      degradation === 'wsl-broken'
        ? 'WSL is installed here but not answering; the user can run `wsl --shutdown` to fix it'
        : 'the user can run `wsl --install` to fix it';
    return (
      `[husk] local computer ${info.id} running on cmd.exe, NOT Linux. ` +
      `$VAR does not expand and 'single quotes' are not quotes -- those fail silently at ` +
      `exit 0 rather than erroring, so trust nothing that depends on them. Unix tools may or ` +
      `may not be on PATH depending on what the user has installed; check, do not assume. ` +
      `Tell the user their computer is degraded rather than working around it -- ${fix}. ` +
      `Docker is unavailable for the same reason, since its engine runs inside WSL2. ` +
      `${guardrails}`
    );
  }

  const shell = info.spec.labels?.['husk.shell'] ?? 'host';
  const where = shell.startsWith('wsl:') ? `real Linux via ${shell.slice(4)}` : 'the host shell';
  return (
    `[husk] local computer ${info.id} on ${where}. ${guardrails} Start Docker for real isolation.`
  );
}

/** The first line of a tool's text output, for the audit log's `error`. */
function firstText(content: Array<{ type: string; text?: string }>): string {
  const text = content.find((c) => c.type === 'text')?.text ?? 'failed';
  return text.split('\n')[0]?.slice(0, 200) ?? 'failed';
}
