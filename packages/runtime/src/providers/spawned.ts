import type { ChildProcess } from 'node:child_process';
import type { ComputerProcess, SpawnRequest } from '@husk-ai/core';

/**
 * A child process as a `ComputerProcess`: callbacks wired, exit reported once.
 *
 * Decoded as a stream rather than per chunk, so a character split across two
 * reads arrives whole. Kill closes stdin first and signals only after a grace
 * period: a killed `docker exec` client does not kill what it started, but the
 * process in the container sees its stdin end and leaves -- if the end gets
 * there before the client dies.
 */
export function wireSpawned(child: ChildProcess, req: SpawnRequest, kill: () => void = () => child.kill('SIGKILL')): ComputerProcess {
  let exited = false;
  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    req.onExit(code);
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (c: string) => req.onStdout(c));
  child.stderr?.on('data', (c: string) => req.onStderr?.(c));
  child.stdin?.on('error', () => {});
  child.on('error', () => exit(1));
  child.on('close', (code, signal) => exit(code ?? (signal ? 137 : 1)));
  return {
    write: (data) => {
      if (!exited) child.stdin?.write(data);
    },
    kill: () => {
      if (exited) return;
      child.stdin?.end();
      const timer = setTimeout(() => {
        try {
          kill();
        } catch {
          /* already gone */
        }
      }, 2000);
      timer.unref?.();
      child.once('close', () => clearTimeout(timer));
    },
  };
}
