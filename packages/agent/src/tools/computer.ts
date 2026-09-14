import { HuskError } from '@husk-ai/core';
import { assertCommandAllowed } from '../guard.js';
import { defineTool } from '../types.js';
import type { AgentTool } from '../types.js';
import { int, object, str } from './util.js';

export interface ShellResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export const shell = defineTool<
  { command: string; cwd?: string; timeoutSec?: number; stdin?: string },
  ShellResult
>({
  name: 'shell',
  description:
    'Run a shell command on the Linux computer. Returns exit code, stdout and stderr. ' +
    'Use this for anything a terminal can do: building, installing, running tests, inspecting processes.',
  dangerous: true,
  needsComputer: true,
  parameters: object(
    {
      command: str('The shell command to run, e.g. "npm test" or "ls -la /work".'),
      cwd: str('Working directory inside the computer. Defaults to the husk workdir.'),
      timeoutSec: int('Kill the command after this many seconds.', { minimum: 1, maximum: 3600 }),
      stdin: str('Text piped to the command on standard input.'),
    },
    ['command'],
  ),
  async handler(input, ctx) {
    assertCommandAllowed(input.command, ctx.spec.guardrails);
    const computer = await ctx.acquireComputer();

    const result = await computer.exec({
      cmd: input.command,
      cwd: input.cwd,
      timeoutSec: input.timeoutSec ?? ctx.spec.limits.execTimeoutSec,
      stdin: input.stdin,
      maxOutputBytes: ctx.maxOutputBytes,
      signal: ctx.signal,
      onStdout: (text) =>
        ctx.emit({ type: 'tool_delta', callId: ctx.callId, tool: 'shell', stream: 'stdout', text }),
      onStderr: (text) =>
        ctx.emit({ type: 'tool_delta', callId: ctx.callId, tool: 'shell', stream: 'stderr', text }),
    });

    return {
      command: input.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      truncated: result.truncated,
    };
  },
  render(out) {
    const bits = [`exit ${out.exitCode}${out.timedOut ? ' (timed out)' : ''}`];
    if (out.stdout.trim()) bits.push(`stdout:\n${out.stdout.trimEnd()}`);
    if (out.stderr.trim()) bits.push(`stderr:\n${out.stderr.trimEnd()}`);
    if (!out.stdout.trim() && !out.stderr.trim()) bits.push('(no output)');
    return bits.join('\n');
  },
});

export const expose_port = defineTool<
  { port: number },
  { port: number; url: string; publicUrl?: string; reachable?: boolean }
>({
  name: 'expose_port',
  description:
    'Publish a port from inside the computer to the host so a human can open it in a browser. ' +
    'Call this after starting a server; it is idempotent.',
  dangerous: true,
  needsComputer: true,
  parameters: object({ port: int('The port the server is listening on inside the computer.', { minimum: 1, maximum: 65535 }) }, [
    'port',
  ]),
  async handler(input, ctx) {
    const computer = await ctx.acquireComputer();
    const binding = await computer.exposePort(input.port);
    return {
      port: input.port,
      url: binding.url,
      publicUrl: binding.publicUrl,
      reachable: binding.reachable,
    };
  },
  render(out) {
    const where = out.publicUrl ? `${out.url} (public: ${out.publicUrl})` : out.url;
    // Only providers that check say so. Silence means "not checked", which is
    // different from "checked and nothing there" -- and the model should not
    // start a debugging detour over a provider that simply does not report.
    if (out.reachable === false) {
      return `port ${out.port} is published at ${where}, but nothing is listening on it yet`;
    }
    return `port ${out.port} is at ${where}`;
  },
});

const FALLBACK_INFO = [
  'uname -a',
  'echo "cpus: $(nproc 2>/dev/null || echo unknown)"',
  'echo "memory:"; (free -h 2>/dev/null || echo unknown)',
  'echo "disk:"; df -h / 2>/dev/null | tail -n +1',
  'echo "cwd: $(pwd)"',
].join('; ');

export const computer_info = defineTool<Record<string, never>, { source: 'huskinfo' | 'probe'; text: string }>({
  name: 'computer_info',
  description:
    'Describe the computer: kernel, CPU count, memory, disk and working directory. ' +
    'Call this once before assuming what is installed.',
  needsComputer: true,
  parameters: object({}),
  async handler(_input, ctx) {
    const computer = await ctx.acquireComputer();
    const probe = await computer.exec({
      cmd: 'command -v huskinfo >/dev/null 2>&1 && echo yes || echo no',
      timeoutSec: 15,
      signal: ctx.signal,
      maxOutputBytes: 4096,
    });
    const hasHuskinfo = probe.exitCode === 0 && probe.stdout.trim() === 'yes';

    const result = await computer.exec({
      cmd: hasHuskinfo ? 'huskinfo' : FALLBACK_INFO,
      timeoutSec: 30,
      signal: ctx.signal,
      maxOutputBytes: Math.min(ctx.maxOutputBytes, 16_384),
    });

    if (result.exitCode !== 0 && !result.stdout.trim()) {
      throw new HuskError('E_EXEC_FAILED', `could not inspect the computer: ${result.stderr.trim() || 'no output'}`, {
        hint: 'the machine may still be booting; retry once',
      });
    }
    return { source: hasHuskinfo ? 'huskinfo' : 'probe', text: result.stdout.trim() || result.stderr.trim() };
  },
  render(out) {
    return out.text;
  },
});

export const computerTools: AgentTool[] = [shell, expose_port, computer_info];
