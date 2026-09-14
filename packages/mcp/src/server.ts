import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HUSK_VERSION, createLogger, quiet } from '@husk/core';
import type { Computer, ComputerSpec, Logger } from '@husk/core';
import { ComputerManager } from '@husk/runtime';
import { audited } from '@husk/core';
import { TOOLS, callTool } from './tools.js';

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
  private readonly spec: ComputerSpec;
  private readonly ephemeral: boolean;
  private readonly log: Logger;
  private computer: Computer | undefined;
  private creating: Promise<Computer> | undefined;
  private announced = false;

  constructor(opts: HuskMcpOptions = {}) {
    this.manager = opts.manager ?? new ComputerManager();
    this.sessionKey = opts.sessionKey ?? process.env.HUSK_SESSION ?? 'mcp';
    this.spec = opts.spec ?? {};
    this.ephemeral = opts.ephemeral ?? true;
    // stderr only: stdout is the protocol.
    this.log = opts.logger ?? createLogger({ scope: 'mcp' });

    this.mcp = new Server(
      { name: 'husk', version: HUSK_VERSION },
      {
        capabilities: { tools: {} },
        instructions:
          'Husk gives you a Linux computer. Use `shell` for anything a command line can do; ' +
          'the filesystem at /work persists across calls in this session. Call `computer_info` ' +
          'once before assuming a runtime or tool is installed.',
      },
    );

    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    this.mcp.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      const computer = await this.getComputer();
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
        content.unshift({ type: 'text', text: this.isolationNote(computer) });
      }
      return { content, ...(result.isError ? { isError: true } : {}) };
    });
  }

  /** One honest line about what this machine actually is. */
  private isolationNote(computer: Computer): string {
    const p = computer.info.provider;
    if (p === 'docker' || p === 'podman') {
      return `[husk] ${p} container ${computer.info.id}, isolated from the host. /work persists for this session.`;
    }
    if (p === 'local') {
      const shell = computer.info.spec.labels?.['husk.shell'] ?? 'host';
      const linux = shell.startsWith('wsl') ? `real Linux via ${shell}` : shell === 'posix' ? 'the host shell' : 'the Windows shell';
      return (
        `[husk] local computer ${computer.info.id} on ${linux}. This is a guarded working ` +
        `directory, NOT a sandbox: /work is jailed and destructive commands are refused, but ` +
        `it shares the host kernel and network. Start Docker for real isolation.`
      );
    }
    return `[husk] computer ${computer.info.id} on ${p}. /work persists for this session.`;
  }

  /** Create the machine on first use, and only once even under concurrent calls. */
  private async getComputer(): Promise<Computer> {
    if (this.computer) return this.computer;
    this.creating ??= (async () => {
      const c = await this.manager.ensure(this.sessionKey, {
        name: `mcp-${this.sessionKey}`,
        idleTimeoutSec: 3600,
        ...this.spec,
      });
      this.log.info(`computer ready: ${c.id} (${c.info.provider})`);
      this.computer = c;
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
    await quiet(() => this.mcp.close());
    if (this.ephemeral && this.computer) {
      await quiet(() => this.computer!.destroy());
    }
  }
}

/** The first line of a tool's text output, for the audit log's `error`. */
function firstText(content: Array<{ type: string; text?: string }>): string {
  const text = content.find((c) => c.type === 'text')?.text ?? 'failed';
  return text.split('\n')[0]?.slice(0, 200) ?? 'failed';
}
