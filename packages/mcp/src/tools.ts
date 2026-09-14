import type { Computer } from '@husk-ai/core';
import { HuskError, clampText, formatBytes, redact } from '@husk-ai/core';
import { browseInComputer } from '@husk-ai/core';
import { BROWSER_TOOLS, BROWSER_TOOL_NAMES, callBrowserTool } from './browser-tools.js';
import { workspaceNote } from './workspace.js';

/**
 * The tools an MCP client gets.
 *
 * Descriptions are written for a model, not for a docs page: they say what the
 * tool does, what it costs, and when NOT to reach for it. A model that picks the
 * wrong tool burns a turn, and turns are the scarce resource.
 */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'shell',
    description:
      'Run a shell command on your Linux computer and return its output. This is the ' +
      'primary tool -- prefer it for anything a command line can do. The filesystem ' +
      'persists across calls within a session. Commands run from /work by default.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command, run with sh -c.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to /work.' },
        timeoutSec: { type: 'number', description: 'Kill the command after this long. Defaults to 120.' },
        stdin: { type: 'string', description: 'Text piped to the command on stdin.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a text file from the computer. Use offset/limit for large files rather than ' +
      'reading the whole thing -- output is capped and the middle will be elided.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, e.g. /work/main.py' },
        offset: { type: 'number', description: 'First line to return (1-based).' },
        limit: { type: 'number', description: 'How many lines to return.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a file. Creates parent directories. To change part of an ' +
      'existing file, use edit_file instead so you do not lose content you did not read.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        append: { type: 'boolean', description: 'Append instead of overwriting.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. Fails if old_string is absent or appears more ' +
      'than once, so include enough surrounding context to be unambiguous. Safer than ' +
      'write_file for edits.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to replace, including indentation.' },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_dir',
    description: 'List a directory. Directories are listed first.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path. Defaults to /work.' } },
    },
  },
  {
    name: 'expose_port',
    description:
      'Publish a port the computer is listening on and get a URL reachable from the host. ' +
      'Start your server first, then call this.',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'number', description: 'The port inside the computer.' } },
      required: ['port'],
    },
  },
  {
    name: 'browse',
    description:
      'Load a web page from inside this computer and get its text and links. Prefer this ' +
      'over your own web tools when what matters is what THIS machine can reach: it shares ' +
      'the computer network, DNS and egress policy, so the result matches what a command ' +
      'running here would see.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL.' },
        maxBytes: { type: 'number', description: 'Cap the extracted text. Defaults to 200 KB.' },
        timeoutSec: { type: 'number', description: 'Give up after this long. Defaults to 30.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'computer_info',
    description:
      'Describe the machine: OS, kernel, CPU, memory, disk, network reachability, and which ' +
      'language runtimes are installed. Call this once before assuming a tool exists, ' +
      'instead of probing with several shell commands.',
    inputSchema: { type: 'object', properties: {} },
  },
  ...BROWSER_TOOLS,
];

/**
 * One content block in an MCP tool result.
 *
 * Images are here for `browser_screenshot` alone. Everything else is text,
 * because a model reasons better about a page from a snapshot than from pixels
 * -- but "show me what you are looking at" is a real request and a picture is
 * the only answer to it.
 */
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text: text.length ? text : '(no output)' }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const MAX_TOOL_OUTPUT = 96 * 1024;

/** Run one tool call against a live computer. Never throws; errors come back as results. */
export async function callTool(
  computer: Computer,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'shell':
        return await shell(computer, args);
      case 'read_file':
        return await readFile(computer, args);
      case 'write_file':
        return await writeFile(computer, args);
      case 'edit_file':
        return await editFile(computer, args);
      case 'list_dir':
        return await listDir(computer, args);
      case 'expose_port':
        return await exposePort(computer, args);
      case 'computer_info':
        return await computerInfo(computer);
      case 'browse':
        return await browse(computer, args);
      default:
        if (BROWSER_TOOL_NAMES.has(name)) {
          return await callBrowserTool(computer, name, args, MAX_TOOL_OUTPUT);
        }
        return fail(`unknown tool: ${name}`);
    }
  } catch (err) {
    // A model recovers from a described failure and stalls on an opaque one, so the
    // hint matters more here than it does for a human reading a terminal.
    if (err instanceof HuskError) {
      return fail(`${err.message}${err.hint ? `\nhint: ${err.hint}` : ''}`);
    }
    return fail(`${name} failed: ${(err as Error).message}`);
  }
}

async function shell(computer: Computer, args: Record<string, unknown>): Promise<ToolResult> {
  const command = String(args.command ?? '');
  if (!command.trim()) return fail('command is empty');

  const r = await computer.exec({
    cmd: command,
    ...(args.cwd ? { cwd: String(args.cwd) } : {}),
    ...(args.stdin !== undefined ? { stdin: String(args.stdin) } : {}),
    timeoutSec: typeof args.timeoutSec === 'number' ? args.timeoutSec : 120,
    maxOutputBytes: MAX_TOOL_OUTPUT,
  });

  const parts: string[] = [];
  if (r.stdout) parts.push(r.stdout.trimEnd());
  if (r.stderr) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
  if (r.timedOut) parts.push(`[timed out after ${Math.round(r.durationMs / 1000)}s and was killed]`);
  if (r.exitCode !== 0 && !r.timedOut) parts.push(`[exit ${r.exitCode}]`);

  const text = redact(parts.join('\n'));
  return r.exitCode === 0 && !r.timedOut ? ok(text) : { content: [{ type: 'text', text }], isError: true };
}

async function readFile(computer: Computer, args: Record<string, unknown>): Promise<ToolResult> {
  const path = String(args.path ?? '');
  const text = await computer.readTextFile(path, MAX_TOOL_OUTPUT);
  const offset = typeof args.offset === 'number' ? Math.max(1, args.offset) : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : undefined;

  if (offset === undefined && limit === undefined) return ok(redact(text));

  const lines = text.split('\n');
  const start = (offset ?? 1) - 1;
  const slice = lines.slice(start, limit ? start + limit : undefined);
  const header = `[lines ${start + 1}-${start + slice.length} of ${lines.length}]`;
  return ok(`${header}\n${redact(slice.join('\n'))}`);
}

async function writeFile(computer: Computer, args: Record<string, unknown>): Promise<ToolResult> {
  const path = String(args.path ?? '');
  const content = String(args.content ?? '');
  await computer.writeFile(path, content, { append: args.append === true });
  return ok(`${args.append === true ? 'appended to' : 'wrote'} ${path} (${formatBytes(Buffer.byteLength(content))})`);
}

async function editFile(computer: Computer, args: Record<string, unknown>): Promise<ToolResult> {
  const path = String(args.path ?? '');
  const oldStr = String(args.old_string ?? '');
  const newStr = String(args.new_string ?? '');
  if (!oldStr) return fail('old_string is empty; use write_file to create a file');

  const before = await computer.readTextFile(path);
  const first = before.indexOf(oldStr);
  if (first === -1) {
    return fail(
      `old_string was not found in ${path}. Read the file first and copy the exact text, ` +
        'including indentation and line endings.',
    );
  }
  if (before.indexOf(oldStr, first + 1) !== -1) {
    const count = before.split(oldStr).length - 1;
    return fail(
      `old_string appears ${count} times in ${path}. Include more surrounding context so it ` +
        'matches exactly once.',
    );
  }

  await computer.writeFile(path, before.slice(0, first) + newStr + before.slice(first + oldStr.length));
  return ok(`edited ${path}`);
}

async function listDir(computer: Computer, args: Record<string, unknown>): Promise<ToolResult> {
  const path = args.path ? String(args.path) : '/work';
  const entries = await computer.listDir(path);
  if (!entries.length) return ok(`${path} is empty`);
  const body = entries
    .map((e) => `${e.type === 'dir' ? 'd' : e.type === 'symlink' ? 'l' : '-'} ${formatBytes(e.size).padStart(7)}  ${e.name}`)
    .join('\n');
  return ok(`${path}\n${clampText(body, MAX_TOOL_OUTPUT).text}`);
}

async function exposePort(computer: Computer, args: Record<string, unknown>): Promise<ToolResult> {
  const port = Number(args.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('port must be an integer 1-65535');
  const b = await computer.exposePort(port);
  const where = b.publicUrl ?? b.url;
  // "is reachable" was a guess. Say it only when the provider checked.
  if (b.reachable === false) {
    return ok(`port ${port} is published at ${where}, but nothing is listening on it yet`);
  }
  return ok(`port ${port} is published at ${where}`);
}

async function computerInfo(computer: Computer): Promise<ToolResult> {
  // huskinfo exists in our images; everywhere else, assemble the same facts.
  const r = await computer.exec({
    cmd:
      'command -v huskinfo >/dev/null 2>&1 && huskinfo || { ' +
      'echo "os        $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)"; ' +
      'echo "kernel    $(uname -r)"; echo "arch      $(uname -m)"; ' +
      'echo "user      $(id -un) (uid $(id -u))"; echo "workdir   $(pwd)"; ' +
      'echo "cpus      $(nproc 2>/dev/null || echo ?)"; ' +
      'echo "disk      $(df -h /work 2>/dev/null | awk \'NR==2 {print $4}\') free on /work"; ' +
      'printf "tools     "; for t in git curl jq rg python3 node go cargo make gcc; do ' +
      'command -v $t >/dev/null 2>&1 && printf "%s " $t; done; echo; }',
    timeoutSec: 20,
  });

  const info = computer.info;
  const header = [
    `provider  ${info.provider}`,
    `image     ${info.image}`,
    `computer  ${info.id}`,
  ].join('\n');

  // Where a human can watch this machine. `computer_info` is the tool an agent
  // calls to orient itself and the one whose output a person reliably reads, so
  // the workspace link belongs here rather than on every result.
  const workspace = await workspaceNote(info.id);

  return ok(`${header}\n${r.stdout.trim()}${workspace}`);
}

/**
 * Browse from inside the machine.
 *
 * The client's own web tools fetch from the client's host. This fetches from the
 * computer -- same IP, same DNS, same egress, same network policy -- so what the
 * agent reads is what this machine can actually reach, and the console Browser
 * panel shows the same page.
 */
async function browse(computer: Computer, args: Record<string, unknown>): Promise<ToolResult> {
  const url = String(args.url ?? '');
  if (!url) return fail('browse needs a url');

  const page = await browseInComputer(computer, {
    url,
    ...(typeof args.maxBytes === 'number' ? { maxBytes: args.maxBytes } : {}),
    ...(typeof args.timeoutSec === 'number' ? { timeoutSec: args.timeoutSec } : {}),
  });

  const head = [
    `${page.status} ${page.url}`,
    page.title ? `title     ${page.title}` : '',
    `fetched   ${page.bytes} bytes via ${page.via}${page.truncated ? ' (truncated)' : ''}`,
  ]
    .filter(Boolean)
    .join('\n');

  // Links are what a model needs in order to navigate, and they are the first
  // thing lost when a page is flattened to text. Keep a bounded list.
  const links = page.links
    .slice(0, 40)
    .map((l, i) => `  [${i + 1}] ${l.text} -> ${l.href}`)
    .join('\n');

  const tail = links ? `\n\nlinks\n${links}` : '';
  return ok(`${head}\n\n${page.text}${tail}`);
}
