import { describe, expect, it, vi } from 'vitest';
import * as ui from '../ui.js';
import { listenOn, run } from './serve.js';

const { serve } = vi.hoisted(() => ({
  serve: vi.fn(async (opts: { host: string; port: number }) => ({
    url: `http://${opts.host}:${opts.port}`,
    host: opts.host,
    port: opts.port,
    close: async () => {},
  })),
}));
// The real loopback rule, so this checks the rule the server refuses binds by, not a copy.
vi.mock('@husk-ai/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@husk-ai/server')>();
  return { serve, parsePublicUrl: real.parsePublicUrl, isLoopbackHost: real.isLoopbackHost };
});
vi.mock('@husk-ai/mcp/tools', () => ({ runTool: () => {} }));
// Aborted just after run() starts listening, so it prints and returns instead of
// waiting for Ctrl-C. An already-aborted signal would never fire its listener.
vi.mock('../signal.js', () => ({
  interruptSignal: () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 0);
    return c.signal;
  },
}));
vi.mock('../lib/first-run.js', () => ({ orientBriefly: () => {} }));
// What the Husk would mint: a link that works once, carrying no token.
vi.mock('../lib/console-link.js', () => ({ consoleLink: async () => 'http://127.0.0.1:7399/#code=c0de' }));

describe('husk serve: where it listens', () => {
  it('takes the flags, then HUSK_HOST and HUSK_PORT, then the defaults', () => {
    const env = { HUSK_HOST: '0.0.0.0', HUSK_PORT: '8080' };
    expect(listenOn({}, env)).toEqual({ host: '0.0.0.0', port: 8080 });
    expect(listenOn({ host: '127.0.0.1', port: '9000' }, env)).toEqual({ host: '127.0.0.1', port: 9000 });
    expect(listenOn({}, {})).toEqual({ host: '127.0.0.1', port: 7377 });
    expect(() => listenOn({}, { HUSK_PORT: 'abc' })).toThrow(/HUSK_PORT expects a positive number/);
  });
});

describe('husk serve: its token', () => {
  it('makes one on loopback, and leaves any other address to HUSK_TOKEN', async () => {
    for (const fn of ['print', 'note', 'warn'] as const) vi.spyOn(ui, fn).mockImplementation(() => {});
    await run(['--host', '127.0.0.1', '--port', '7399']);
    expect(serve.mock.calls.at(-1)?.[0]).toMatchObject({ host: '127.0.0.1', mintToken: true });
    await run(['--host', '0.0.0.0', '--port', '7399']);
    expect(serve.mock.calls.at(-1)?.[0]).toMatchObject({ host: '0.0.0.0', mintToken: false });
  });
});

describe('husk serve: the console line', () => {
  const consoleLine = async (tty: boolean): Promise<string> => {
    const printed: string[] = [];
    vi.spyOn(ui, 'print').mockImplementation((line?: string) => void printed.push(line ?? ''));
    for (const fn of ['note', 'warn'] as const) vi.spyOn(ui, fn).mockImplementation(() => {});
    const was = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
    try {
      await run(['--host', '127.0.0.1', '--port', '7399']);
    } finally {
      if (was) Object.defineProperty(process.stdout, 'isTTY', was);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
    return printed.find((l) => l.includes('console')) ?? '';
  };

  it('is a link that signs you in once, on a terminal', async () => {
    expect(await consoleLine(true)).toContain('http://127.0.0.1:7399/#code=c0de');
  });

  it('is the plain address anywhere else, where it could land in a log or a chat', async () => {
    const line = await consoleLine(false);
    expect(line).not.toContain('#code=');
    expect(line).toContain('husk console');
  });
});
