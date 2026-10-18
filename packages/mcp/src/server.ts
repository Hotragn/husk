import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HUSK_VERSION, createLogger, quiet, redact } from '@husk-ai/core';
import type { Computer, ComputerInfo, ComputerSpec, Logger } from '@husk-ai/core';
import { ComputerManager, ensureRunning } from '@husk-ai/runtime';
import { audited } from '@husk-ai/core';
import { callTool, toolsFor } from './tools.js';
import { WorkspaceStore } from '@husk-ai/workspaces';
import { HandoffRegistry, handoffLink, startWorkspaceViewer } from '@husk-ai/server/workspace-viewer';
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
  /** Destroy the machine when the client disconnects. Default true. */
  ephemeral?: boolean;
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

/** How long a tool call waits on the in-chat "Done?" before handing the model the link instead. */
const ELICIT_WAIT_MS = 200_000;

export class HuskMcpServer {
  private readonly mcp: Server;
  private readonly manager: ComputerManager;
  private readonly sessionKey: string;
  private readonly namedSession: boolean;
  private readonly spec: ComputerSpec;
  private readonly ephemeral: boolean;
  private readonly log: Logger;
  private computer: Computer | undefined;
  private creating: Promise<Computer> | undefined;
  private announced = false;
  /** Set once a computer exists and turns out not to be Linux. */
  private degraded = false;
  private profile: WorkspaceProfile;
  private readonly workspaceStore: WorkspaceStore;
  private readonly workspaceTools: WorkspaceTools;
  private viewer?: Promise<{ url: string; origin: string; close: () => Promise<void> }>;
  /** Handoffs open in this session. A person ends one; closing the session ends them all. */
  private readonly handoffs = new HandoffRegistry();
  private readonly closing = new AbortController();
  /** Ended from the viewer, so a later hand_off_done for one is an answer, not an error. */
  private readonly handedBack = new Set<string>();
  private confirmedProvider?: string;

  constructor(opts: HuskMcpOptions = {}) {
    this.manager = opts.manager ?? new ComputerManager();
    this.namedSession = opts.sessionKey !== undefined || process.env.HUSK_SESSION !== undefined;
    this.sessionKey = opts.sessionKey ?? process.env.HUSK_SESSION ?? `mcp-${randomUUID()}`;
    this.spec = opts.spec ?? {};
    this.ephemeral = opts.ephemeral ?? true;
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
        capabilities: { tools: { listChanged: true }, prompts: {} },
        instructions: WORKSPACE_INSTRUCTIONS + '\n' + (this.profile === 'starter'
          ? 'This session starts with workspace tools only. The user can enable computer tools in the viewer Advanced settings after reviewing the environment.'
          :
          COMPUTER_INSTRUCTIONS),
      },
    );

    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...WORKSPACE_TOOLS, ...(this.profile === 'computer' ? [...toolsFor(this.degraded), ...HANDOFF_TOOLS] : [])] }));

    this.mcp.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: this.profile === 'computer' ? PROMPTS : [] }));
    this.mcp.setRequestHandler(GetPromptRequestSchema, async (request) => getPrompt(request.params.name, request.params.arguments));

    this.mcp.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      if (WORKSPACE_TOOL_NAMES.has(name)) return this.workspaceTools.call(name, (args ?? {}) as Record<string, unknown>);
      if (this.profile !== 'computer') return { isError: true, content: [{ type: 'text', text: 'Computer tools are disabled. The user can enable them from Advanced in the workspace viewer after reviewing the environment.' }] };
      if (HANDOFF_TOOL_NAMES.has(name)) {
        const a = (args ?? {}) as Record<string, unknown>;
        try {
          return name === 'hand_off' ? await this.handOff(a, extra.signal) : this.handOffDone(a);
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: redact((err as Error).message) }] };
        }
      }
      // The person holds the computer until they say done. The model must not
      // type into the page they are signing in on, or run commands under them.
      const held = this.handoffs.list()[0];
      if (held && name !== 'computer_info') {
        return { isError: true, content: [{ type: 'text', text: heldText(held.handoffId, held.reason) }] };
      }
      let computer: Computer;
      try {
        computer = await this.getComputer();
      } catch (err) {
        const error = err as Error & { hint?: string };
        const text = `Computer unavailable: ${error.message}\n${error.hint ?? 'Run husk doctor to check the provider, then retry.'}`;
        return { isError: true, content: [{ type: 'text', text: redact(text) }] };
      }
      const toolArgs = (args ?? {}) as Record<string, unknown>;

      // Every call, at the one place they all pass through. An audit log that
      // has to be remembered at each new tool is an audit log with holes -- and
      // this path had no log at all until now, which is the more embarrassing
      // version of the same problem.
      const result = await audited(
        { computerId: computer.id, via: 'mcp', tool: name, args: toolArgs },
        () => callTool(computer, name, toolArgs),
        // MCP tools report failure in the result rather than by throwing, so
        // the wrapper is told how to recognise one.
        (r) => (r.isError ? firstText(r.content) : undefined),
      );

      const content = [...result.content];
      if (!this.announced) {
        this.announced = true;
        content.unshift({ type: 'text', text: `${this.isolationNote(computer)}\n` });
      }
      return { content, ...(result.isError ? { isError: true } : {}) };
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

  /** Create the machine on first use, and only once even under concurrent calls. */
  private async getComputer(): Promise<Computer> {
    this.creating ??= (async () => {
      if (this.computer) return ensureRunning(this.computer);
      const spec = {
        name: `mcp-${this.sessionKey}`,
        idleTimeoutSec: 3600,
        persist: true,
        ...this.spec,
      };
      // Only explicit sessions need a durable binding. Anonymous sessions own
      // their workspace, so disconnecting can remove it with the computer.
      const c = this.namedSession
        ? await this.manager.ensure(this.sessionKey, spec)
        : await this.manager.create(spec);
      this.log.info(`computer ready: ${c.id} (${c.info.provider})`);
      this.computer = c;
      await this.announceDegradation(c);
      return c;
    })();
    try {
      return await this.creating;
    } finally {
      this.creating = undefined;
    }
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
  private async handOff(args: Record<string, unknown>, callSignal: AbortSignal): Promise<CallToolResult> {
    const text = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (!text) throw new Error('hand_off needs a reason the user can read.');
    if (text.length > MAX_REASON) throw new Error(`hand_off reason is over ${MAX_REASON} characters.`);
    // Model text, headed for a person's screen.
    const reason = redact(text);

    const open = this.handoffs.list()[0];
    if (open) throw new Error(heldText(open.handoffId, open.reason));

    let handoffId = '';
    const finished = this.handoffs.request(
      {
        runId: this.sessionKey,
        husk: 'chat',
        reason,
        ...(this.computer ? { computerId: this.computer.id } : {}),
        signal: this.closing.signal,
      },
      (pending) => {
        handoffId = pending.handoffId;
      },
    );
    void finished.then((outcome) => {
      if (outcome === 'done') this.handedBack.add(handoffId);
    });
    const { origin } = await this.openViewerServer();
    const link = handoffLink(origin, handoffId, this.handoffs.secretOf(handoffId) ?? '');

    // In-chat "Done?" where the client declared form elicitation.
    // https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
    // `elicitation: {}` means form mode; a client that lists only `url` has no form.
    const elicit = this.mcp.getClientCapabilities()?.elicitation;
    if (elicit && (elicit.form !== undefined || elicit.url === undefined)) {
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
          if (this.handoffs.secretOf(handoffId)) this.handoffs.complete(handoffId);
          return { content: [{ type: 'text', text: HANDED_BACK }] };
        }
      } finally {
        stop.abort();
        callSignal.removeEventListener('abort', onCallAbort);
      }
    }
    return { content: [{ type: 'text', text: relayText(handoffId, reason, link) }] };
  }

  /** The model relays the person's "done". Only meaningful after hand_off. */
  private handOffDone(args: Record<string, unknown>): CallToolResult {
    const handoffId = typeof args.handoff === 'string' ? args.handoff : '';
    if (this.handedBack.has(handoffId)) return { content: [{ type: 'text', text: HANDED_BACK }] };
    if (!this.handoffs.secretOf(handoffId)) throw new Error(`There is no open handoff "${handoffId}".`);
    this.handoffs.complete(handoffId);
    return { content: [{ type: 'text', text: HANDED_BACK }] };
  }

  async close(): Promise<void> {
    this.closing.abort();
    if (this.viewer) await quiet(async () => (await this.viewer!).close());
    await quiet(() => this.mcp.close());
    if (this.ephemeral && this.computer) {
      // A named local computer owns user files. Destroying it would delete them.
      await quiet(() => this.namedSession ? this.computer!.stop() : this.computer!.destroy());
    }
  }

  private async openViewer(): Promise<string> {
    return (await this.openViewerServer()).url;
  }

  private openViewerServer(): Promise<{ url: string; origin: string; close: () => Promise<void> }> {
    this.viewer ??= startWorkspaceViewer({
      store: this.workspaceStore,
      handoffs: this.handoffs,
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
