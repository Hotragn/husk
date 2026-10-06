import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HUSK_VERSION, createLogger, quiet, redact } from '@husk-ai/core';
import type { Computer, ComputerInfo, ComputerSpec, Logger } from '@husk-ai/core';
import { ComputerManager, ensureRunning } from '@husk-ai/runtime';
import { audited } from '@husk-ai/core';
import { callTool, toolsFor } from './tools.js';
import { WorkspaceStore } from '@husk-ai/workspaces';
import { startWorkspaceViewer } from '@husk-ai/server/workspace-viewer';
import type { WorkspaceProfile } from '@husk-ai/server/workspace-viewer';
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
  private viewer?: Promise<{ url: string; close: () => Promise<void> }>;
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
        capabilities: { tools: { listChanged: true } },
        instructions: WORKSPACE_INSTRUCTIONS + '\n' + (this.profile === 'starter'
          ? 'This session starts with workspace tools only. The user can enable computer tools in the viewer Advanced settings after reviewing the environment.'
          :
          'Husk gives you a computer -- on almost every host a Linux container. Use `shell` ' +
          'for anything a command line can do; the filesystem at /work persists across calls ' +
          'in this session. Call `computer_info` once before assuming a runtime, a tool or ' +
          'even a POSIX shell is there: on a Windows host without a working WSL this is ' +
          'cmd.exe, and the first tool result will say so.'),
      },
    );

    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...WORKSPACE_TOOLS, ...(this.profile === 'computer' ? toolsFor(this.degraded) : [])] }));

    this.mcp.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      if (WORKSPACE_TOOL_NAMES.has(name)) return this.workspaceTools.call(name, (args ?? {}) as Record<string, unknown>);
      if (this.profile !== 'computer') return { isError: true, content: [{ type: 'text', text: 'Computer tools are disabled. The user can enable them from Advanced in the workspace viewer after reviewing the environment.' }] };
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

  async close(): Promise<void> {
    if (this.viewer) await quiet(async () => (await this.viewer!).close());
    await quiet(() => this.mcp.close());
    if (this.ephemeral && this.computer) {
      // A named local computer owns user files. Destroying it would delete them.
      await quiet(() => this.namedSession ? this.computer!.stop() : this.computer!.destroy());
    }
  }

  private async openViewer(): Promise<string> {
    this.viewer ??= startWorkspaceViewer({
      store: this.workspaceStore,
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
    return (await this.viewer).url;
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
