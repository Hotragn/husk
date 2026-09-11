import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HUSK_VERSION, createLogger, quiet } from '@husk/core';
import type { Computer, ComputerSpec, Logger } from '@husk/core';
import { ComputerManager } from '@husk/runtime';
import { listWorkResources, readWorkResource } from './resources.js';
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
        // `resources` is what lets a *person* see the machine. Tools return text
        // into a transcript, so without it a client has nothing to render, nothing
        // to attach and nothing to download -- "show me what the bot produced" had
        // no answer but pasted characters. Files under /work are the answer.
        capabilities: { tools: {}, resources: {} },
        instructions:
          'Husk gives you a Linux computer. Use `shell` for anything a command line can do; ' +
          'the filesystem at /work persists across calls in this session. Call `computer_info` ' +
          'once before assuming a runtime or tool is installed. Files you write under /work are ' +
          'exposed as resources, so writing a result to /work is how you hand it to the user.',
      },
    );

    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    this.mcp.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      const computer = await this.getComputer();
      const result = await callTool(computer, name, (args ?? {}) as Record<string, unknown>);

      const content = [...result.content];
      if (!this.announced) {
        this.announced = true;
        content.unshift({ type: 'text', text: this.isolationNote(computer) });
      }
      return { content, ...(result.isError ? { isError: true } : {}) };
    });

    /**
     * Listing resources must not create a machine.
     *
     * Clients call `resources/list` eagerly on connect, sometimes before the
     * user has said anything. Booting a container for that would undo the
     * "adding the server costs nothing" property that makes people leave it
     * installed -- so with no computer yet, there is nothing in /work, and the
     * honest answer is an empty list.
     */
    this.mcp.setRequestHandler(ListResourcesRequestSchema, async () => {
      if (!this.computer) return { resources: [] };
      return { resources: await listWorkResources(this.computer) };
    });

    this.mcp.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const computer = await this.getComputer();
      return { contents: [await readWorkResource(computer, request.params.uri)] };
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
    if (!this.computer) return;
    if (this.ephemeral) {
      // Release rather than destroy: another session may be holding the same
      // key, and taking its filesystem away mid-run is the failure mode the
      // refcount exists to prevent. At the last holder this destroys.
      await quiet(() => this.manager.release(this.sessionKey, { destroy: true }));
    } else {
      await quiet(() => this.manager.release(this.sessionKey, { destroy: false }));
    }
  }
}
