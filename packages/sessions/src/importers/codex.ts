import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HuskError, id } from '@husk-ai/core';
import type { ImportInput, Transcript, TranscriptImporter, TranscriptMessage } from '@husk-ai/core';
import { isDirectory } from './fsutil.js';

/**
 * Codex CLI sessions: one JSONL "rollout" per session, under
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`. Each line is
 * `{ timestamp, type, payload }` (codex-rs `history/src/rollout_payload.rs`):
 *
 *  - `session_meta` names the session: its `id`, `cwd` and `cli_version`.
 *  - `response_item` is what the model saw and said: `message` (role and
 *    `input_text`/`output_text` parts), `function_call` with its JSON
 *    `arguments`, `function_call_output`, the custom and shell calls, and
 *    `reasoning`, which is left out.
 *  - `event_msg` repeats the conversation for the UI. It is used only when a
 *    rollout has no `response_item` messages at all.
 *
 * Codex puts its own context into the conversation as user and developer
 * messages: the environment, AGENTS.md, permission notes. None of it is the
 * person's, so none of it is kept.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Codex's own context, filed under the user's role. */
const INJECTED = /^\s*(<(environment_context|user_instructions|permissions instructions|turn_aborted|subagent_notification|user_shell_command)\b|# AGENTS\.md instructions)/;

/** The text of a message's parts, or of a tool's output in any of its shapes. */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((p) => (isRecord(p) ? (asString(p.text) ?? '') : typeof p === 'string' ? p : '')).filter(Boolean).join('\n');
  if (isRecord(v)) return textOf(v.content ?? v.output ?? v.text);
  return '';
}

/**
 * A tool's name as one string. Codex records an MCP tool's server as its
 * `namespace` (`mcp__husk`); older rollouts put both in the name
 * (`mcp__husk__shell`). Either way it comes out as `mcp__husk__shell`.
 */
function toolNameOf(p: Record<string, unknown>): string {
  const name = asString(p.name) ?? 'unknown';
  const namespace = asString(p.namespace)?.replace(/_+$/, '');
  return namespace ? `${namespace}__${name}` : name;
}

/** A function call's arguments are a JSON string; keep them as data when they parse. */
function argumentsOf(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export function parseCodexRollout(content: string, origin?: string): Transcript[] {
  const messages: TranscriptMessage[] = [];
  const fromEvents: TranscriptMessage[] = [];
  const toolNames = new Map<string, string>();
  const tools = new Set<string>();
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let version: string | undefined;
  let model: string | undefined;
  let lines = 0;

  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      // Codex may still be writing the last line.
      continue;
    }
    if (!isRecord(line) || !isRecord(line.payload)) continue;
    lines++;
    const p = line.payload;
    const ts = asString(line.timestamp);
    const at = ts ? { ts } : {};

    if (line.type === 'session_meta') {
      sessionId = asString(p.id) ?? sessionId;
      cwd = asString(p.cwd) ?? cwd;
      version = asString(p.cli_version) ?? version;
    } else if (line.type === 'turn_context') {
      model = asString(p.model) ?? model;
    } else if (line.type === 'event_msg') {
      const text = asString(p.message);
      if (text && p.type === 'user_message' && !INJECTED.test(text)) fromEvents.push({ role: 'user', content: text, ...at });
      if (text && p.type === 'agent_message') fromEvents.push({ role: 'assistant', content: text, ...at });
    } else if (line.type === 'response_item') {
      const callId = asString(p.call_id);
      switch (p.type) {
        case 'message': {
          const role = p.role === 'assistant' ? 'assistant' : p.role === 'user' ? 'user' : undefined;
          const text = textOf(p.content).trim();
          if (role && text && !INJECTED.test(text)) messages.push({ role, content: text, ...at });
          break;
        }
        case 'function_call':
        case 'custom_tool_call':
        case 'local_shell_call': {
          const name = p.type === 'local_shell_call' ? 'shell' : toolNameOf(p);
          const input = p.type === 'function_call' ? argumentsOf(p.arguments) : p.type === 'custom_tool_call' ? p.input : p.action;
          if (callId) toolNames.set(callId, name);
          tools.add(name);
          messages.push({ role: 'assistant', content: `[tool: ${name}]`, ...at, toolName: name, toolInput: input, ...(callId ? { meta: { toolUseId: callId } } : {}) });
          break;
        }
        case 'function_call_output':
        case 'custom_tool_call_output': {
          const name = callId ? toolNames.get(callId) : undefined;
          messages.push({ role: 'tool', content: textOf(p.output), ...at, ...(name ? { toolName: name } : {}), ...(callId ? { meta: { toolUseId: callId } } : {}) });
          break;
        }
        case 'web_search_call':
          tools.add('web_search');
          messages.push({ role: 'assistant', content: '[tool: web_search]', ...at, toolName: 'web_search', toolInput: p.action });
          break;
      }
    }
  }

  const said = messages.some((m) => m.role === 'user' || m.role === 'assistant') ? messages : fromEvents;
  if (!said.length) {
    if (lines) return [];
    throw new HuskError('E_IMPORT_FAILED', `${origin ?? 'input'} is not a Codex session.`, {
      hint: 'Codex keeps sessions as rollout-*.jsonl under ~/.codex/sessions.',
    });
  }
  const firstUser = said.find((m) => m.role === 'user')?.content;
  const stamps = said.map((m) => m.ts).filter((t): t is string => Boolean(t));
  return [
    {
      id: sessionId ?? id('codex'),
      source: 'codex',
      messages: said,
      ...(firstUser ? { title: firstUser.slice(0, 80).replace(/\s+/g, ' ').trim() } : {}),
      ...(stamps.length ? { createdAt: stamps[0], updatedAt: stamps[stamps.length - 1] } : {}),
      ...(origin ? { origin } : {}),
      meta: {
        ...(cwd ? { cwd } : {}),
        ...(version ? { codexVersion: version } : {}),
        ...(model ? { model } : {}),
        tools: [...tools].sort(),
      },
    },
  ];
}

/** Where Codex keeps its sessions: `$CODEX_HOME/sessions`, `~/.codex/sessions` by default. */
export function codexSessions(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
}

export class CodexImporter implements TranscriptImporter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';

  async detect(input: { path?: string; content?: string }): Promise<number> {
    try {
      const path = input.path?.replace(/\\/g, '/').toLowerCase() ?? '';
      let score = 0;
      if (path.includes('/.codex/') && path.endsWith('.jsonl')) score = 0.7;
      else if (/\/rollout-[^/]*\.jsonl$/.test(path)) score = 0.6;
      const probe = input.content?.slice(0, 64 * 1024);
      if (probe && /"type"\s*:\s*"(session_meta|response_item|turn_context)"/.test(probe) && /"payload"\s*:/.test(probe)) score = Math.max(score, 0.95);
      return score;
    } catch {
      return 0;
    }
  }

  async parse(input: ImportInput): Promise<Transcript[]> {
    if (input.content !== undefined) return parseCodexRollout(input.content, input.path);
    if (!input.path) {
      throw new HuskError('E_IMPORT_FAILED', 'Codex import needs a path or content.', {
        hint: 'Point it at a rollout-*.jsonl under ~/.codex/sessions, or at that folder.',
      });
    }
    const files = (await isDirectory(input.path))
      ? (await readdir(input.path, { recursive: true })).filter((f) => /rollout-.*\.jsonl$/.test(f)).map((f) => join(input.path!, f))
      : [input.path];
    const out: Transcript[] = [];
    for (const f of files) out.push(...parseCodexRollout(await readFile(f, 'utf8'), f));
    return out;
  }

  defaultLocations(): string[] {
    return [codexSessions()];
  }
}
