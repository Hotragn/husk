/**
 * The person's own Claude Code or Codex as a husk's engine (J5-c).
 *
 * Their installed, unmodified CLI runs headless under their own login, in a
 * folder of the bot's own, with Husk's MCP tools and nothing else: no shell,
 * no file tools, no web search, no other MCP server and no project's
 * settings. So it acts only on the computer, through the shared Husk, where a
 * person's take-over, a cancel and admission reach it as they reach a chat's
 * calls. The login stays where the CLI keeps it; Husk never reads or copies it.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AGENT_CLIS, HuskError, clampText, createLogger, ensurePaths, findCli, huskLaunch, id, keepsNotes, messageText, notesDir, notesInstructions, notesWarning, redact, renderPersona } from '@husk-ai/core';
import type { AgentCli, CliCommand, HuskSpec, Logger, RunResult, Tool, ToolCallPart, Usage } from '@husk-ai/core';
import type { AgentOptions, AgentRunEvent, AgentRunOptions } from './types.js';

/** How long a run has to stop once asked: SIGINT ends the CLI's turn, then SIGTERM, then SIGKILL. */
const STOP_GRACE_MS = 5000;
/** Tool output kept in a run's events; Husk's own tools already clamp what they return. */
const MAX_OUTPUT = 64 * 1024;
/** Set by the Claude Code a shared Husk may have been started from. Claude Code refuses to start under them. */
const PARENT_SESSION = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT'];
/**
 * Set for one bot's MCP server (huskServer). The shared Husk keeps the
 * environment of the bot server that started it, and one of these must not
 * reach another bot's: its notes, or the chat it continues.
 */
const ONE_BOT = ['HUSK_BOT', 'HUSK_CHAT_SESSION', 'HUSK_MEMORY_DIR', 'HUSK_MEMORY_ONLY'];
/** Codex's own ways to act, beside the MCP servers it is given. Unknown names are ignored by older versions. */
const CODEX_OFF = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation', 'view_image', 'code_mode_host'];
/** Codex items that mean it acted outside Husk's tools after all. */
const CODEX_OUTSIDE = new Set(['command_execution', 'file_change', 'web_search', 'collab_tool_call']);

interface Outcome {
  text: string;
  steps: number;
  usage: Usage;
  /** The CLI said the run ended, one way or another. */
  finished: boolean;
  stop?: RunResult['stopReason'];
  error?: { code?: string; message: string };
  /** Something that must end the run at once. */
  fatal?: { code: string; message: string };
}

type Line = Record<string, unknown> & { type?: string };
type Reader = Outcome & { read(line: Line): AgentRunEvent[] };

export class CliAgent {
  readonly spec: HuskSpec;
  private readonly cli: AgentCli;
  private readonly log: Logger;

  constructor(opts: Pick<AgentOptions, 'spec' | 'logger'>) {
    const engine = opts.spec.engine.type;
    if (engine === 'builtin') throw new HuskError('E_INTERNAL', 'CliAgent runs a claude-code or codex husk', { hint: 'the builtin engine is Agent' });
    this.spec = opts.spec;
    this.cli = engine;
    this.log = opts.logger ?? createLogger({ scope: `agent:${opts.spec.name}` });
  }

  /** None of its own: the CLI is offered Husk's, over MCP. */
  listTools(): Tool[] {
    return [];
  }

  async run(opts: AgentRunOptions): Promise<RunResult> {
    let result: RunResult | undefined;
    for await (const event of this.stream(opts)) if (event.type === 'run_end') result = event.result;
    if (!result) throw new HuskError('E_INTERNAL', 'the run produced no result', { hint: 'this is a bug in @husk-ai/agent' });
    return result;
  }

  /** Every event goes to `onEvent` as well, as the builtin loop's do: the server records a run's events from it. */
  async *stream(opts: AgentRunOptions): AsyncIterable<AgentRunEvent> {
    for await (const event of this.events(opts)) {
      opts.onEvent?.(event);
      yield event;
    }
  }

  private async *events(opts: AgentRunOptions): AsyncIterable<AgentRunEvent> {
    const runId = id('run');
    const started = Date.now();
    const { name } = AGENT_CLIS[this.cli];
    yield { type: 'run_start', runId, husk: this.spec.name, model: this.cli };
    const unkept = notesWarning(this.spec);
    if (unkept) yield { type: 'warning', message: unkept };
    const end =(out: Outcome): AgentRunEvent[] => {
      const error = out.fatal ?? out.error;
      const result: RunResult = {
        runId,
        text: out.text,
        messages: [
          { role: 'user', content: promptOf(opts) },
          ...(out.text ? [{ role: 'assistant' as const, content: out.text }] : []),
        ],
        steps: out.steps,
        usage: out.usage,
        durationMs: Date.now() - started,
        stopReason: out.stop ?? 'complete',
        ...(error ? { error } : {}),
      };
      return [...(error ? [{ type: 'error' as const, error }] : []), { type: 'run_end', result }];
    };

    const cli = findCli(this.cli);
    if (!cli) {
      const { override } = AGENT_CLIS[this.cli];
      yield* end({ ...empty(), stop: 'error', error: { code: 'E_PROVIDER_UNAVAILABLE', message: `${name} is not installed where Husk can find it; install it, or set ${override} to its path` } });
      return;
    }

    const dir = join(ensurePaths().root, 'bots', this.spec.name);
    mkdirSync(dir, { recursive: true });
    const resumed = this.cli === 'claude-code' && this.spec.engine.resume !== undefined;
    const reader: Reader = this.cli === 'claude-code' ? claudeReader(resumed, huskServer(this.spec) !== undefined) : codexReader();
    const args = this.cli === 'claude-code' ? claudeArgs(this.spec, dir, opts) : codexArgs(this.spec, dir, opts);
    const child = spawn(cli.command, [...cli.args, ...args], { cwd: dir, env: cliEnv(cli), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.log.info(`${name} started for ${this.spec.name}${resumed ? ', continuing its chat' : ''}`);

    let stopped: 'aborted' | 'timeout' | undefined;
    let failed: Error | undefined;
    let stderr = '';
    const exited = new Promise<number | null>((resolve) => {
      child.once('close', (code) => resolve(code));
      child.once('error', (err) => {
        failed = err;
        resolve(null);
      });
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-8000)));
    child.stdin.on('error', () => {});
    child.stdin.end(promptOf(opts));

    const stop = (why: 'aborted' | 'timeout' | 'fatal') => {
      if (stopped || child.exitCode !== null || child.signalCode !== null) return;
      if (why !== 'fatal') stopped = why;
      child.kill('SIGINT');
      const term = setTimeout(() => child.kill('SIGTERM'), STOP_GRACE_MS);
      const kill = setTimeout(() => child.kill('SIGKILL'), 2 * STOP_GRACE_MS);
      void exited.then(() => {
        clearTimeout(term);
        clearTimeout(kill);
      });
    };
    const onAbort = () => stop('aborted');
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeoutSec ? setTimeout(() => stop('timeout'), opts.timeoutSec * 1000) : undefined;

    try {
      for await (const text of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        const line = parse(text);
        if (!line) continue;
        yield* reader.read(line);
        if (reader.fatal) stop('fatal');
      }
      const code = await exited;
      if (stopped) {
        reader.stop = stopped;
        reader.error = undefined;
      } else if (failed) {
        reader.stop = 'error';
        reader.error = { code: 'E_PROVIDER_UNAVAILABLE', message: `${name} could not start: ${failed.message}` };
      } else if (reader.fatal) {
        reader.stop = 'error';
      } else if (!reader.finished) {
        const said = redact(stderr.trim().split('\n').slice(-3).join(' ')) || 'nothing';
        reader.stop = 'error';
        reader.error = { code: 'E_PROVIDER_UNAVAILABLE', message: `${name} stopped (exit ${code ?? 'signal'}) before it finished; it said: ${said}` };
      }
      yield* end(reader);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}

function empty(): Outcome {
  return { text: '', steps: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, finished: false };
}

function parse(text: string): Line | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as Line) : undefined;
  } catch {
    return undefined;
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(record) : []);

/** Tool output as text: a string, or MCP content's text parts. */
function outputText(content: unknown): string {
  const text = typeof content === 'string' ? content : list(content).map((p) => (typeof p['text'] === 'string' ? p['text'] : '')).filter(Boolean).join('\n');
  return clampText(text, MAX_OUTPUT).text;
}

/** The run's input as one prompt: the conversation so far, then the new message. */
function promptOf(opts: AgentRunOptions): string {
  const turns = [...(opts.history ?? []), ...(typeof opts.input === 'string' ? [{ role: 'user' as const, content: opts.input }] : opts.input)];
  const last = turns.pop();
  const earlier = turns.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => `${m.role}: ${messageText(m)}`);
  const now = last ? messageText(last) : '';
  return earlier.length ? `The conversation so far:\n${earlier.join('\n')}\n\nNow: ${now}` : now;
}

/** A husk with no tools, or no computer, only talks. */
const hasComputer = (spec: HuskSpec): boolean => spec.computer.enabled && spec.tools.length > 0;

/** What the CLI is told, beside its own system prompt: who it is running as, the husk's persona, and its notes. */
function instructions(spec: HuskSpec, opts: AgentRunOptions): string {
  const parts = [
    `You are running unattended, as the Husk bot "${spec.name}". Nobody is watching this run, so finish the task without asking questions.`,
    hasComputer(spec)
      ? "Your only tools are Husk's. They act on a computer of your own: use them for everything the task needs."
      : keepsNotes(spec)
        ? 'Your only tool is your notes: answer from what you know.'
        : 'You have no tools: answer from what you know.',
  ];
  const persona = renderPersona(spec, opts.vars ?? {});
  if (persona) parts.push(persona);
  if (spec.examples.length) parts.push(`## Examples\n${spec.examples.map((e) => `User: ${e.user}\nYou: ${e.assistant}`).join('\n\n')}`);
  if (keepsNotes(spec)) parts.push(notesInstructions(notesDir(spec.name)));
  return parts.join('\n\n');
}

/**
 * How the CLI starts Husk's MCP server: this install's launch line, the
 * husk's computer, and `--keep`, since the shared Husk stops computers itself.
 * A bot that continues a Claude Code chat names the chat, and so gets its
 * computer, files and logins; any other bot has a computer of its own. A bot
 * that keeps notes gets them as the `memory` tool, and a bot with no computer
 * that keeps notes gets that tool alone.
 */
export function huskServer(spec: HuskSpec): CliCommand | undefined {
  const c = spec.computer;
  const notes = keepsNotes(spec);
  if (!hasComputer(spec) && !notes) return undefined;
  const launch = huskLaunch({ ...(c.provider ? { provider: c.provider } : {}), flavor: c.flavor });
  // A bot's calls wait out a person's take-over, where a chat's are told to stop (J5-e).
  const env: Record<string, string> = { ...(launch.env ?? {}), HUSK_BOT: spec.name };
  if (notes) env['HUSK_MEMORY_DIR'] = notesDir(spec.name);
  if (!hasComputer(spec)) return { command: launch.command, args: launch.args, env: { ...env, HUSK_MEMORY_ONLY: '1' } };
  const args = [...launch.args, '--keep', '--network', c.network.mode];
  if (c.network.strict) args.push('--network-strict');
  if (c.memoryMb) args.push('--memory', String(c.memoryMb));
  if (c.cpus) args.push('--cpus', String(c.cpus));
  if (spec.engine.resume) env['HUSK_CHAT_SESSION'] = spec.engine.resume;
  else args.push('--session', `bot-${spec.name}`);
  return { command: launch.command, args, env };
}

/** The CLI's environment: this one's, without a parent Claude Code session's markers or another bot's. */
function cliEnv(cli: CliCommand): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(cli.env ?? {}) };
  for (const key of [...PARENT_SESSION, ...ONE_BOT]) delete env[key];
  return env;
}

/** A model the run or the husk names for the CLI; `auto` leaves the CLI's own choice. */
function modelOf(spec: HuskSpec, opts: AgentRunOptions): string | undefined {
  const model = opts.model ?? spec.model;
  return model && model !== 'auto' ? model : undefined;
}

/**
 * `claude -p`, its prompt on stdin. No built-in tool (`--tools ""`), no MCP
 * server but Husk's, and no settings but the person's own: a `-p` run would
 * otherwise run a project's hooks, so it also starts in the bot's own folder.
 * Husk's tools run without asking and anything else is refused, never asked.
 * The budget counts only this run's spend, even when it continues a chat.
 */
export function claudeArgs(spec: HuskSpec, dir: string, opts: AgentRunOptions): string[] {
  const server = huskServer(spec);
  const config = join(dir, 'mcp.json');
  writeFileSync(config, JSON.stringify({ mcpServers: server ? { husk: { type: 'stdio', ...server } } : {} }, null, 2), { mode: 0o600 });
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  args.push('--tools', '', '--strict-mcp-config', '--mcp-config', config, '--setting-sources', 'user');
  if (server) args.push('--allowedTools', 'mcp__husk');
  args.push('--permission-mode', 'dontAsk');
  args.push('--append-system-prompt', instructions(spec, opts), '--max-budget-usd', String(opts.maxCostUsd ?? spec.limits.maxCostUsd));
  const model = modelOf(spec, opts);
  if (model) args.push('--model', model);
  // A fork: the chat's own session is never written to.
  if (spec.engine.resume) args.push('--resume', spec.engine.resume, '--fork-session');
  return args;
}

/** A TOML basic string: JSON's string syntax is one. */
const toml = (v: string): string => JSON.stringify(v);

/**
 * `codex exec`, its prompt on stdin. Without the person's config.toml, so no
 * MCP server but Husk's; its shell, apps, browser, web search and agents off;
 * a read-only sandbox and no approvals, so nothing on this machine changes.
 */
export function codexArgs(spec: HuskSpec, dir: string, opts: AgentRunOptions): string[] {
  const s = huskServer(spec);
  const args = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '-C', dir];
  for (const feature of CODEX_OFF) args.push('-c', `features.${feature}=false`);
  args.push('-c', 'web_search="disabled"', '-c', 'approval_policy="never"');
  args.push('-c', `developer_instructions=${toml(instructions(spec, opts))}`);
  if (s) {
    args.push('-c', `mcp_servers.husk.command=${toml(s.command)}`, '-c', `mcp_servers.husk.args=[${s.args.map(toml).join(',')}]`);
    const env = Object.entries(s.env ?? {});
    if (env.length) args.push('-c', `mcp_servers.husk.env={${env.map(([k, v]) => `${k}=${toml(v)}`).join(',')}}`);
    // Without its tools the run would only talk: Codex stops instead.
    args.push('-c', 'mcp_servers.husk.required=true');
  }
  const model = modelOf(spec, opts);
  if (model) args.push('-m', model);
  args.push('-');
  return args;
}

/** A tool's name without the `mcp__husk__` Claude Code puts in front. */
const toolName = (name: string): string => name.replace(/^mcp__husk__/, '');

/**
 * Claude Code's `stream-json`: `system` (init, retries), `assistant` and
 * `user` messages, and a closing `result`. A subagent's messages carry a
 * `parent_tool_use_id` and are left out. The cost Claude Code reports for a
 * continued chat includes the chat's earlier spend, so such a run shows its
 * own tokens and no cost.
 */
export function claudeReader(resumed: boolean, tools = true): Reader {
  const calls = new Map<string, { call: ToolCallPart; at: number }>();
  const seen = new Set<string>();
  const out: Reader = {
    ...empty(),
    read(line) {
      const events: AgentRunEvent[] = [];
      const message = record(line['message']);
      if (line.type === 'system' && line['subtype'] === 'init') {
        const husk = list(line['mcp_servers']).find((s) => s['name'] === 'husk');
        if (tools && husk?.['status'] !== 'connected') {
          out.fatal = { code: 'E_PROVIDER_UNAVAILABLE', message: `Husk's tools did not start in Claude Code (${String(husk?.['status'] ?? 'missing')}); ~/.husk/daemon.log may say why` };
        }
        if (resumed) events.push({ type: 'warning', message: 'Claude Code counts a continued chat’s earlier spend in its cost, so this run shows its tokens and no cost' });
      } else if (line.type === 'system' && line['subtype'] === 'api_retry') {
        events.push({ type: 'warning', message: `Claude Code is retrying (${String(line['error'] ?? 'error')}, attempt ${num(line['attempt'])})` });
      } else if (line.type === 'assistant' && !line['parent_tool_use_id']) {
        const msgId = typeof message['id'] === 'string' ? message['id'] : undefined;
        if (!msgId || !seen.has(msgId)) {
          if (msgId) seen.add(msgId);
          events.push({ type: 'step_start', step: ++out.steps });
        }
        for (const part of list(message['content'])) {
          if (part['type'] === 'text' && typeof part['text'] === 'string') events.push({ type: 'text_delta', text: part['text'] });
          else if (part['type'] === 'thinking' && typeof part['thinking'] === 'string') events.push({ type: 'thinking_delta', text: part['thinking'] });
          else if (part['type'] === 'tool_use' && typeof part['id'] === 'string') {
            const call: ToolCallPart = { type: 'tool_call', id: part['id'], name: toolName(String(part['name'] ?? '')), args: record(part['input']) };
            calls.set(call.id, { call, at: Date.now() });
            events.push({ type: 'tool_start', call });
          }
        }
      } else if (line.type === 'user' && !line['parent_tool_use_id']) {
        for (const part of list(message['content'])) {
          const open = part['type'] === 'tool_result' ? calls.get(String(part['tool_use_id'])) : undefined;
          if (!open) continue;
          calls.delete(open.call.id);
          events.push({ type: 'tool_end', call: open.call, output: outputText(part['content']), isError: part['is_error'] === true, durationMs: Date.now() - open.at });
        }
      } else if (line.type === 'result') {
        const u = record(line['usage']);
        out.finished = true;
        if (typeof line['result'] === 'string') out.text = line['result'];
        out.usage = {
          inputTokens: num(u['input_tokens']),
          outputTokens: num(u['output_tokens']),
          cacheReadTokens: num(u['cache_read_input_tokens']),
          cacheWriteTokens: num(u['cache_creation_input_tokens']),
          costUsd: resumed ? 0 : num(line['total_cost_usd']),
        };
        events.push({ type: 'usage', usage: out.usage, cumulative: out.usage });
        const subtype = String(line['subtype'] ?? '');
        if (subtype === 'success' && line['is_error'] !== true) out.stop = 'complete';
        else if (subtype === 'error_max_budget_usd') out.stop = 'budget';
        else if (subtype === 'error_max_turns') out.stop = 'step_limit';
        else {
          out.stop = 'error';
          out.error = { code: 'E_MODEL_ERROR', message: `Claude Code: ${out.text || subtype || 'the run failed'}` };
        }
      }
      return events;
    },
  };
  return out;
}

/**
 * `codex exec --json`: `turn.*` and `item.*` events (codex-rs exec_events.rs).
 * Husk's tools arrive as `mcp_tool_call` items; a `command_execution`,
 * `file_change` or `web_search` means Codex acted on its own after all, and
 * ends the run.
 */
export function codexReader(): Reader {
  const started = new Map<string, number>();
  const callOf = (item: Record<string, unknown>): ToolCallPart => ({ type: 'tool_call', id: String(item['id']), name: String(item['tool'] ?? ''), args: record(item['arguments']) });
  const out: Reader = {
    ...empty(),
    read(line) {
      const events: AgentRunEvent[] = [];
      const item = record(line['item']);
      const kind = String(item['type'] ?? '');
      if ((line.type === 'item.started' || line.type === 'item.completed') && CODEX_OUTSIDE.has(kind)) {
        out.fatal = { code: 'E_EXEC_DENIED', message: `Codex acted outside Husk's tools (${kind}), so the run was stopped` };
      } else if (line.type === 'turn.started') {
        events.push({ type: 'step_start', step: ++out.steps });
      } else if (line.type === 'item.started' && kind === 'mcp_tool_call') {
        started.set(String(item['id']), Date.now());
        events.push({ type: 'tool_start', call: callOf(item) });
      } else if (line.type === 'item.completed' && kind === 'mcp_tool_call') {
        const at = started.get(String(item['id'])) ?? Date.now();
        started.delete(String(item['id']));
        const error = record(item['error']);
        const failed = item['status'] === 'failed' || typeof error['message'] === 'string';
        const output = typeof error['message'] === 'string' ? error['message'] : outputText(record(item['result'])['content']);
        events.push({ type: 'tool_end', call: callOf(item), output, isError: failed, durationMs: Date.now() - at });
      } else if (line.type === 'item.completed' && kind === 'agent_message' && typeof item['text'] === 'string') {
        out.text = item['text'];
        events.push({ type: 'text_delta', text: item['text'] });
      } else if (line.type === 'item.completed' && kind === 'reasoning' && typeof item['text'] === 'string') {
        events.push({ type: 'thinking_delta', text: item['text'] });
      } else if (line.type === 'item.completed' && kind === 'error') {
        events.push({ type: 'warning', message: `Codex: ${String(item['message'] ?? 'error')}` });
      } else if (line.type === 'turn.completed') {
        const u = record(line['usage']);
        out.usage = {
          inputTokens: out.usage.inputTokens + num(u['input_tokens']),
          outputTokens: out.usage.outputTokens + num(u['output_tokens']),
          cacheReadTokens: (out.usage.cacheReadTokens ?? 0) + num(u['cached_input_tokens']),
          costUsd: 0,
        };
        events.push({ type: 'usage', usage: out.usage, cumulative: out.usage });
        out.finished = true;
        out.stop = 'complete';
      } else if (line.type === 'turn.failed') {
        out.finished = true;
        out.stop = 'error';
        out.error = { code: 'E_MODEL_ERROR', message: `Codex: ${String(record(line['error'])['message'] ?? 'the turn failed')}` };
      } else if (line.type === 'error') {
        events.push({ type: 'warning', message: `Codex: ${String(line['message'] ?? 'error')}` });
      }
      return events;
    },
  };
  return out;
}
