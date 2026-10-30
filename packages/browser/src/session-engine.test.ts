import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserEngine, Computer, ComputerInfo, ExecResult } from '@husk-ai/core';
import type { CdpTransport, DriverRequest, DriverResult, SendStep } from './cdp.js';
import { LIGHTPANDA_BINARY } from './provision.js';
import { BrowserSession, wantedEngine } from './session.js';

/**
 * Which browser a computer runs, and its one move from Lightpanda to Chrome.
 * No browser here: a computer that answers the install and launch commands,
 * and a driver that answers like a page at one address with one cookie.
 */

const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '', durationMs: 1, truncated: false, timedOut: false });

function computerFor(opts: { browser?: BrowserEngine; spawn?: boolean; moved?: boolean; saved?: string } = {}) {
  const info = {
    id: `engine-${Math.random()}`,
    name: 'engine',
    provider: 'docker',
    state: 'running',
    image: 'none',
    workdir: '/work',
    createdAt: '',
    lastUsedAt: '',
    spec: { network: { mode: 'full' }, ...(opts.browser ? { browser: opts.browser } : {}) },
  } as ComputerInfo;
  let port = 44000;
  const moved = { now: opts.moved === true };
  const computer = {
    id: info.id,
    info,
    cmds: [] as string[],
    moved,
    // Only whether a provider can keep a process running matters here: the transport is a fake.
    ...(opts.spawn === false ? {} : { spawn: () => undefined }),
    async exec(input: { cmd: string | string[] }): Promise<ExecResult> {
      const cmd = Array.isArray(input.cmd) ? input.cmd.join(' ') : input.cmd;
      computer.cmds.push(cmd);
      if (cmd.startsWith(`test -x ${LIGHTPANDA_BINARY}`)) return ok('yes\n');
      if (cmd.startsWith('test -e') && cmd.includes('moved-to-chrome')) return ok(moved.now ? 'moved\n' : '');
      if (cmd.includes('touch') && cmd.includes('moved-to-chrome')) {
        moved.now = true;
        return ok();
      }
      if (cmd.startsWith('cat ') && cmd.includes('lightpanda-cookies.json')) return ok(opts.saved ?? '[]');
      if (cmd.includes('command -v chromium')) return ok('/usr/bin/chromium\n');
      if (cmd.includes('--version')) return ok('Chromium 140.0\n');
      if (cmd.includes('import socket')) return ok(`${++port}\n`);
      return ok();
    },
  };
  return computer;
}

const COOKIE = { name: 'sid', value: 'abc', domain: 'example.com', path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax', size: 6 };

/** A driver for a page at `page.url`; `page.answers` false is a page that stopped answering. */
function driver(sent: DriverRequest[], page: { url: string; answers: boolean }) {
  return {
    async run(req: DriverRequest): Promise<DriverResult> {
      sent.push(req);
      return {
        results: req.steps.map((s) => {
          if (s.op === 'send' && s.method === 'Target.createTarget') return { targetId: 'T1' };
          if (s.op === 'send' && (s.method === 'Runtime.evaluate' || s.method === 'Storage.getCookies') && !page.answers) throw new Error('the page is gone');
          if (s.op === 'send' && s.method === 'Runtime.evaluate') return { result: { type: 'string', value: page.url } };
          if (s.op === 'send' && s.method === 'Storage.getCookies') return { cookies: [COOKIE] };
          if (s.op === 'action' && s.do === 'goto') return { ok: true, url: s.url, loaded: true };
          return {};
        }),
      };
    },
    async close(): Promise<void> {},
  } as unknown as CdpTransport;
}

function sessionOn(computer: ReturnType<typeof computerFor>, page = { url: 'https://example.com/cart', answers: true }) {
  const sent: DriverRequest[] = [];
  const said: string[] = [];
  const session = new BrowserSession(computer as unknown as Computer, {
    idleTimeoutMs: 0,
    onProgress: (m) => said.push(m),
    transport: () => driver(sent, page),
  });
  return { session, sent, said, page };
}

const launched = (cmds: string[], engine: BrowserEngine) => cmds.filter((c) => c.includes('setsid') && c.includes(engine === 'lightpanda' ? ' serve --host 127.0.0.1' : '--remote-debugging-port='));
const sends = (sent: DriverRequest[], method: string) => sent.flatMap((r) => r.steps).filter((s): s is SendStep => s.op === 'send' && s.method === method);

let home: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe('which browser a computer runs', () => {
  it("is the computer's own setting, else this machine's config.json, else Chrome", () => {
    home = mkdtempSync(join(tmpdir(), 'husk-engine-'));
    vi.stubEnv('HUSK_HOME', home);
    const asks = (browser?: BrowserEngine) => computerFor(browser ? { browser } : {}) as unknown as Computer;
    expect(wantedEngine(asks())).toBe('chrome');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ browser: 'lightpanda' }));
    expect(wantedEngine(asks())).toBe('lightpanda');
    expect(wantedEngine(asks('chrome'))).toBe('chrome');
    // A config.json Husk cannot read does not stop the browser.
    writeFileSync(join(home, 'config.json'), '{ not json');
    expect(wantedEngine(asks())).toBe('chrome');
  });

  it('starts Lightpanda with no telemetry, kept cookies and a window-sized viewport, and no screen', async () => {
    const computer = computerFor({ browser: 'lightpanda' });
    const { session, sent } = sessionOn(computer);
    const page = await session.activePage();
    const [start] = launched(computer.cmds, 'lightpanda');
    expect(start).toContain('LIGHTPANDA_DISABLE_TELEMETRY=true setsid');
    expect(start).toContain('--load-resources iframe,stylesheet');
    expect(start).toMatch(/--cookie \S+lightpanda-cookies\.json --cookie-jar \S+lightpanda-cookies\.json/);
    expect(start).toMatch(/--port 44001 >/);
    expect(launched(computer.cmds, 'chrome')).toHaveLength(0);
    expect(session.engineNow).toBe('lightpanda');
    expect(page.drawsScreen).toBe(false);
    await expect(page.screenshot()).rejects.toThrow(/Lightpanda draws no screen/);
    expect(sends(sent, 'Emulation.setDeviceMetricsOverride')[0]).toMatchObject({ params: { width: 1280, height: 800 } });
  });

  it('is Chrome, saying why, on a provider that cannot keep a driver running', async () => {
    const computer = computerFor({ browser: 'lightpanda', spawn: false });
    const { session, said } = sessionOn(computer);
    expect((await session.activePage()).drawsScreen).toBe(true);
    expect(launched(computer.cmds, 'lightpanda')).toHaveLength(0);
    expect(said.join('\n')).toMatch(/Lightpanda needs a provider that keeps a process running/);
  });

  it('is Chrome on a computer that moved to Chrome before', async () => {
    const computer = computerFor({ browser: 'lightpanda', moved: true });
    const { session } = sessionOn(computer);
    await session.activePage();
    expect(session.engineNow).toBe('chrome');
    expect(launched(computer.cmds, 'lightpanda')).toHaveLength(0);
  });

  it('starts on Chrome, for good, when its first call needs a screen', async () => {
    const computer = computerFor({ browser: 'lightpanda' });
    const { session } = sessionOn(computer);
    expect((await session.activePage('a screenshot was asked for')).drawsScreen).toBe(true);
    expect(launched(computer.cmds, 'lightpanda')).toHaveLength(0);
    expect(computer.moved.now).toBe(true);
  });
});

describe('a move from Lightpanda to Chrome', () => {
  it('takes the address and cookies to Chrome, stops Lightpanda first, and stays', async () => {
    const computer = computerFor({ browser: 'lightpanda' });
    const { session, sent, said } = sessionOn(computer);
    await session.activePage();
    const page = await session.activePage('a screenshot was asked for');
    expect(page.drawsScreen).toBe(true);
    expect(session.engineNow).toBe('chrome');

    const stopped = computer.cmds.findIndex((c) => c.includes('pkill') && c.includes('serve --host 127.0.0.1 .*--port 44001$'));
    const marked = computer.cmds.findIndex((c) => c.includes('touch') && c.includes('moved-to-chrome'));
    const chrome = computer.cmds.findIndex((c) => c.includes('setsid') && c.includes('--remote-debugging-port=44002'));
    expect(stopped).toBeGreaterThan(-1);
    expect(marked).toBeGreaterThan(stopped);
    expect(chrome).toBeGreaterThan(marked);

    // Lightpanda's session cookie (expires -1) goes as a session cookie, in the fields Chrome takes.
    expect(sends(sent, 'Storage.setCookies')[0]).toMatchObject({ params: { cookies: [{ name: 'sid', value: 'abc', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }] } });
    expect((sends(sent, 'Storage.setCookies')[0]!.params as { cookies: Array<Record<string, unknown>> }).cookies[0]).not.toHaveProperty('expires');
    expect(sent.flatMap((r) => r.steps).filter((s) => s.op === 'action' && s.do === 'goto').at(-1)).toMatchObject({ url: 'https://example.com/cart' });
    expect(said.join('\n')).toMatch(/moved from Lightpanda to Chrome, because a screenshot was asked for\. https:\/\/example\.com\/cart is open there again/);

    // And it stays: the next launch, after the browser closes, is Chrome too.
    await session.close('idle');
    await session.activePage();
    expect(launched(computer.cmds, 'lightpanda')).toHaveLength(1);
  });

  it("uses the cookies Lightpanda saved and the last address it was sent to, when its page no longer answers", async () => {
    const saved = JSON.stringify([{ ...COOKIE, name: 'kept', expires: 1_900_000_000 }]);
    const computer = computerFor({ browser: 'lightpanda', saved });
    const { session, sent, page } = sessionOn(computer, { url: 'https://example.com/a', answers: true });
    await session.goto('https://example.com/a');
    page.answers = false;
    await session.toChrome('a person is taking it over');
    expect(sends(sent, 'Storage.setCookies')[0]).toMatchObject({ params: { cookies: [{ name: 'kept', expires: 1_900_000_000 }] } });
    expect(sent.flatMap((r) => r.steps).filter((s) => s.op === 'action' && s.do === 'goto').at(-1)).toMatchObject({ url: 'https://example.com/a' });
  });

  it('holds a call that comes in during the move, then runs it on Chrome, never Lightpanda again', async () => {
    const computer = computerFor({ browser: 'lightpanda' });
    const { session } = sessionOn(computer);
    await session.activePage();
    const moving = session.toChrome('a person is taking it over');
    const meanwhile = session.activePage();
    await moving;
    expect((await meanwhile).drawsScreen).toBe(true);
    expect(launched(computer.cmds, 'lightpanda')).toHaveLength(1);
  });

  it('starts nothing for a person when the browser is not running, and the next launch is Chrome', async () => {
    const computer = computerFor({ browser: 'lightpanda' });
    const { session } = sessionOn(computer);
    await session.activePage();
    await session.close('idle');
    await session.toChrome('a person is taking it over');
    expect(launched(computer.cmds, 'chrome')).toHaveLength(0);
    expect(computer.moved.now).toBe(true);
    await session.activePage();
    expect(launched(computer.cmds, 'chrome')).toHaveLength(1);
  });

  it('does nothing to a browser already on Chrome', async () => {
    const computer = computerFor();
    const { session } = sessionOn(computer);
    await session.activePage();
    await session.toChrome('a person is taking it over');
    expect(computer.cmds.some((c) => c.includes('moved-to-chrome'))).toBe(false);
    expect(launched(computer.cmds, 'chrome')).toHaveLength(1);
  });
});
