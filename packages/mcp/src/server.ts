import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HUSK_VERSION, IDENTITY_LABELS, chatLabel, createLogger, networkEnforcement, platformName, quiet, redact } from '@husk-ai/core';
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
  logger?: Logger;
  profile?: WorkspaceProfile;
  workspaceStore?: WorkspaceStore;
}

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
 * Clients known to actually show a form-elicitation prompt. Declaring the
 * capability is not enough: Claude Desktop is reported to declare it and never
 * show the dialog (https://github.com/fdsimms/todo/issues/3124,
 * https://github.com/anthropics/claude-code/issues/41110), which would leave the
 * person waiting minutes for a link. Everyone else gets the link at once.
 *  - Claude Code: https://code.claude.com/docs/en/mcp
 *  - Cursor (1.5+): https://cursor.com/docs/context/mcp
 *  - VS Code (1.102+): https://code.visualstudio.com/updates/v1_107
 * ponytail: names matched by substring of clientInfo.name; confirm each by
 * observation. A wrong name only costs the in-chat prompt, never safety.
 */
const SHOWS_ELICITATION = [/claude-code/i, /cursor/i, /visual studio code|vscode/i];

/**
 * Whether a handoff asks "Done?" in the chat, or gives a link at once: the
 * client declares form elicitation (`elicitation: {}` means form mode; one
 * that lists only `url` has no form) and is one known to show it.
 * https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
 */
export function asksInChat(clientName: string, elicitation: { form?: unknown; url?: unknown } | undefined): boolean {
  if (!elicitation || (elicitation.form === undefined && elicitation.url !== undefined)) return false;
  return SHOWS_ELICITATION.some((re) => re.test(clientName));
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
  private readonly hostSessionId = process.env.CLAUDE_CODE_SESSION_ID;
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
  /** Short-lived links, each scoped to one computer or one computer-less handoff. */
  private readonly tokens = new ScopedTokens();
  /** Ended from the viewer, so a later hand_off_done for one is an answer, not an error. */
  private readonly handedBack = new Set<string>();
  private confirmedProvider?: string;

  constructor(opts: HuskMcpOptions = {}) {
    this.manager = opts.manager ?? new ComputerManager();
    this.namedSession = opts.sessionKey !== undefined || process.env.HUSK_SESSION !== undefined;
    this.sessionKey = opts.sessionKey ?? process.env.HUSK_SESSION ?? `mcp-${randomUUID()}`;
    // Claude Code runs one server process per session and says which, in
    // CLAUDE_CODE_SESSION_ID (https://code.claude.com/docs/en/env-vars). Other
    // hosts may share one process across every chat, so there the chat itself
    // carries its computer id forward.
    this.identity = this.namedSession ? 'named' : this.hostSessionId ? 'session' : 'first-call';
    this.spec = opts.spec ?? {};
    this.ephemeral = opts.ephemeral ?? true;
    this.useDaemon = opts.daemon ?? true;
    if (opts.shared) this.daemon = Promise.resolve(opts.shared);
    this.connect = opts.connect ?? (() => connectDaemon({ log: this.log, onLocal: (why) => (this.localReason = why) }));
    this.idleStopMs = opts.idleStopMs ?? 10 * 60 * 1000;
    this.profile = opts.profile ?? 'computer';
    this.workspaceStore = opts.workspaceStore ?? new WorkspaceStore();
    this.workspaceTools = new WorkspaceTools(this.workspaceStore, () => this.openViewer());
    // stderr only: stdout is the protocol.
    this.log = opts.logger ?? createLogger({ scope: 'mcp' });

    this.mcp = new Server(
      { name: 'husk', version: HUSK_VERSION },
      {
        // `listChanged` is declared because the tool descriptions are not final
        // at this point: see `announceDegradation`.
        capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
        instructions: WORKSPACE_INSTRUCTIONS + '\n' + (this.profile === 'starter'
          ? 'This session starts with workspace tools only. The user can enable computer tools in the viewer Advanced settings after reviewing the environment.'
          :
          COMPUTER_INSTRUCTIONS),
      },
    );

    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...WORKSPACE_TOOLS, ...(this.profile === 'computer' ? this.computerTools() : [])],
    }));

    // The computer card, for clients that render MCP Apps. CSP is left empty on
    // purpose: the card makes no network requests, so the host's restrictive default fits.
    this.mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ uri: CARD_URI, name: 'Husk computer card', mimeType: CARD_MIME }],
    }));
    this.mcp.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri !== CARD_URI) throw new Error(`Unknown resource ${request.params.uri}`);
      return { contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: CARD_HTML, _meta: { ui: { csp: {} } } }] };
    });

    this.mcp.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: this.profile === 'computer' ? PROMPTS : [] }));
    this.mcp.setRequestHandler(GetPromptRequestSchema, async (request) => getPrompt(request.params.name, request.params.arguments));

    this.mcp.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      if (WORKSPACE_TOOL_NAMES.has(name)) return this.workspaceTools.call(name, (args ?? {}) as Record<string, unknown>);
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
          return await this.handOff(a, extra.signal, target);
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: redact((err as Error).message) }] };
        }
      }
      const { computer: requested, ...toolArgs } = (args ?? {}) as Record<string, unknown>;
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

      // Every call, at the one place they all pass through. An audit log that
      // has to be remembered at each new tool is an audit log with holes -- and
      // this path had no log at all until now, which is the more embarrassing
      // version of the same problem.
      this.busy(computer.id, +1);
      let result: Awaited<ReturnType<typeof callTool>>;
      try {
        result = await this.runTool(computer, name, toolArgs, extra.signal);
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
    });
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
    if (!key?.startsWith(CHAT_KEY_PREFIX)) return undefined;
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
    const platform = platformName(this.mcp.getClientVersion()?.name);
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
    return `${CHAT_KEY_PREFIX}${randomUUID()}`;
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
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
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
  private async handOff(args: Record<string, unknown>, callSignal: AbortSignal, computer?: Computer): Promise<CallToolResult> {
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
        remote = await daemon.openHandoff(computer.id, reason, computer.info.spec.labels?.[IDENTITY_LABELS.chat]);
      } catch (err) {
        if (err instanceof RunLocally) this.localComputers.add(computer.id);
        this.log.warn(`handing off in this process: ${(err as Error).message}`);
      }
    }
    // Before the handoff opens: if the viewer cannot start, nothing is left
    // holding the computer with no link to finish it.
    const origin = remote && daemon ? daemon.url : (await this.openViewerServer()).origin;
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
    });
    const link = remote
      ? handoffLink(origin, remote.handoffId, remote.token)
      : handoffLink(origin, handoffId, this.tokens.mint(computer ? `computer:${computer.id}` : `handoff:${handoffId}`));

    // In-chat "Done?" where the client shows it; a link everywhere else.
    if (asksInChat(this.mcp.getClientVersion()?.name ?? '', this.mcp.getClientCapabilities()?.elicitation)) {
      const stop = new AbortController();
      const onCallAbort = (): void => stop.abort();
      callSignal.addEventListener('abort', onCallAbort, { once: true });
      try {
        const asked = this.mcp
          .elicitInput(
            {
              mode: 'form',
              message: `${reason}\n\nOpen ${link} on this device to see and use the computer's browser. Answer here when you are done.`,
              requestedSchema: {
                type: 'object',
                properties: { done: { type: 'boolean', title: "I'm done", description: 'Hand the computer back to the AI.' } },
                required: ['done'],
              },
            },
            // Under the 240s that claude.ai and Claude Desktop allow a whole tool
            // call (https://claude.com/docs/connectors/building), so the model
            // still gets the link back. When this fires the handoff stays open.
            { signal: stop.signal, timeout: ELICIT_WAIT_MS },
          )
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

  /** Whether the client renders MCP Apps cards: it lists the UI extension with our MIME type. */
  private rendersCards(): boolean {
    const caps = this.mcp.getClientCapabilities() as { extensions?: Record<string, { mimeTypes?: unknown }> } | undefined;
    const mimeTypes = caps?.extensions?.[UI_EXTENSION]?.mimeTypes;
    return Array.isArray(mimeTypes) && mimeTypes.includes(CARD_MIME);
  }

  /**
   * The computer tools this client sees. Card-capable clients get the card on
   * computer_info and hand_off, plus the two app-only tools the card calls;
   * other clients never see those, since they would show them to the model.
   */
  private computerTools(): ToolDef[] {
    const base = [...toolsFor(this.degraded), ...HANDOFF_TOOLS, OPEN_UI_TOOL];
    if (!this.rendersCards()) return this.withComputerArg(base);
    const withCard = base.map((t) =>
      t.name === 'computer_info' || t.name === 'hand_off' ? { ...t, _meta: { ui: { resourceUri: CARD_URI } } } : t,
    );
    return [...this.withComputerArg(withCard), ...CARD_APP_TOOLS];
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
        const token = await daemon.linkToken(computerId);
        const held = this.handoffs.list().find((h) => h.computerId === computerId);
        const remoteId = held ? this.remoteHandoffs.get(held.handoffId) : undefined;
        return remoteId ? handoffLink(daemon.url, remoteId, token) : computerLink(daemon.url, computerId, token);
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
