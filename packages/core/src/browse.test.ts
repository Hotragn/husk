import { describe, expect, it } from 'vitest';
import { browseInComputer } from './browse.js';
import type { Computer, ExecRequest, ExecResult } from './types/computer.js';

/**
 * The policy decision and the output parsing are what can silently rot here;
 * the fetch itself is exercised for real against a live computer in the
 * runtime's integration checks.
 */
function fakeComputer(opts: { stdout?: string; exitCode?: number; hasPython?: boolean; pages?: Record<string, string> } = {}): Computer & {
  execs: ExecRequest[];
  written: Map<string, string>;
} {
  const execs: ExecRequest[] = [];
  const written = new Map<string, string>();
  const computer = {
    id: 'cmp_fake',
    execs,
    written,
    info: {
      id: 'cmp_fake',
      name: 'fake',
      provider: 'local',
      state: 'running',
      image: 'fake',
      workdir: '/work',
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      spec: { network: { mode: 'full' as const } },
    },
    async exec(req: ExecRequest): Promise<ExecResult> {
      execs.push(req);
      const text = Array.isArray(req.cmd) ? req.cmd.join(' ') : req.cmd;
      if (text.includes('command -v python3')) {
        return result(opts.hasPython === false ? 'no' : 'yes');
      }
      // The fetcher's URL is its first argument: a page per URL, for redirects.
      const url = Array.isArray(req.cmd) ? req.cmd[2] : undefined;
      const answer = (url && opts.pages?.[url]) ?? opts.stdout ?? '{}';
      return { ...result(answer), exitCode: opts.exitCode ?? 0 };
    },
    async writeFile(path: string, content: string | Uint8Array) {
      written.set(path, typeof content === 'string' ? content : Buffer.from(content).toString('utf8'));
    },
  } as unknown as Computer & { execs: ExecRequest[]; written: Map<string, string> };
  return computer;
}

function result(stdout: string): ExecResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1, truncated: false, timedOut: false };
}

const page = JSON.stringify({
  url: 'https://example.com/',
  status: 200,
  contentType: 'text/html; charset=utf-8',
  title: 'Example Domain',
  text: 'Example Domain\n\nThis domain is for use in examples.',
  links: [{ text: 'More information', href: 'https://iana.org/domains/example' }],
  bytes: 559,
  truncated: false,
  elapsedMs: 42,
});

describe('browseInComputer', () => {
  it('runs the fetch inside the computer, not on the host', async () => {
    const c = fakeComputer({ stdout: page });
    await browseInComputer(c, { url: 'https://example.com' });
    // The proof that this is not a host fetch: the work happened as an exec.
    expect(c.execs.some((e) => String(e.cmd).includes('python3'))).toBe(true);
    expect(c.written.has('/tmp/.husk-browse.py')).toBe(true);
  });

  it('parses the page into structured fields', async () => {
    const c = fakeComputer({ stdout: page });
    const p = await browseInComputer(c, { url: 'https://example.com' });
    expect(p).toMatchObject({
      status: 200,
      title: 'Example Domain',
      via: 'python3',
      requestedUrl: 'https://example.com/',
      bytes: 559,
    });
    expect(p.links[0]?.href).toBe('https://iana.org/domains/example');
  });

  it('enforces the policy before running anything', async () => {
    const c = fakeComputer({ stdout: page });
    c.info.spec.network = { mode: 'egress', allow: ['example.com'] };
    await expect(browseInComputer(c, { url: 'https://evil.com' })).rejects.toThrowError(/refuses evil\.com/);
    expect(c.execs).toHaveLength(0);
  });

  it('refuses the metadata endpoint even when the policy says full', async () => {
    const c = fakeComputer({ stdout: page });
    await expect(browseInComputer(c, { url: 'http://169.254.169.254/' })).rejects.toThrowError(/refuses/);
    expect(c.execs).toHaveLength(0);
  });

  it('refuses file:// before it can read the host disk', async () => {
    const c = fakeComputer({ stdout: page });
    await expect(browseInComputer(c, { url: 'file:///etc/passwd' })).rejects.toThrowError(/scheme/);
    expect(c.execs).toHaveLength(0);
  });

  it('surfaces a fetcher-side error as a load failure, not a parse failure', async () => {
    const c = fakeComputer({ stdout: JSON.stringify({ error: 'Name or service not known' }) });
    await expect(browseInComputer(c, { url: 'https://nope.example' })).rejects.toThrowError(
      /could not load nope\.example: Name or service not known/,
    );
  });

  it('ignores shell noise before the JSON line', async () => {
    const c = fakeComputer({ stdout: `warning: something on stdout\n${page}` });
    expect((await browseInComputer(c, { url: 'https://example.com' })).title).toBe('Example Domain');
  });

  it('falls back to curl when the computer has no python3', async () => {
    const body = 'hello <b>world</b>\nHUSK_META\t200\ttext/html; charset=utf-8\thttps://example.com/\t';
    const c = fakeComputer({ hasPython: false, stdout: body });
    const p = await browseInComputer(c, { url: 'https://example.com' });
    expect(p.via).toBe('curl');
    expect(p.status).toBe(200);
    // A content type with a space in it used to lose the status and the URL.
    expect(p.contentType).toBe('text/html; charset=utf-8');
    expect(p.text).toContain('hello');
    expect(p.text).not.toContain('<b>');
  });

  it('honours an explicit policy argument over the computer default', async () => {
    const c = fakeComputer({ stdout: page });
    await expect(
      browseInComputer(c, { url: 'https://example.com' }, { mode: 'none' }),
    ).rejects.toThrowError(/refuses example\.com/);
  });
});

describe('browseInComputer following redirects', () => {
  const redirect = (from: string, to: string, status = 302) => JSON.stringify({ url: from, status, location: to, text: '', links: [], bytes: 0 });
  const fetched = (c: { execs: ExecRequest[] }) => c.execs.filter((e) => Array.isArray(e.cmd) && e.cmd[0] === 'python3').map((e) => (e.cmd as string[])[2]);

  it('follows one to an allowed host, and says where it ended up', async () => {
    const c = fakeComputer({
      pages: {
        'https://example.com/': redirect('https://example.com/', 'https://www.example.com/'),
        'https://www.example.com/': page.replace('"https://example.com/"', '"https://www.example.com/"'),
      },
    });
    const p = await browseInComputer(c, { url: 'https://example.com' });
    expect(p).toMatchObject({ status: 200, title: 'Example Domain', url: 'https://www.example.com/', requestedUrl: 'https://example.com/' });
    expect(fetched(c)).toEqual(['https://example.com/', 'https://www.example.com/']);
  });

  it('refuses a hop to the metadata endpoint before anything is sent there', async () => {
    const c = fakeComputer({ pages: { 'https://example.com/': redirect('https://example.com/', 'http://169.254.169.254/latest/meta-data/') } });
    await expect(browseInComputer(c, { url: 'https://example.com' })).rejects.toThrowError(/refuses 169\.254\.169\.254/);
    expect(fetched(c)).toEqual(['https://example.com/']);
  });

  it('resolves a relative Location against the page that sent it', async () => {
    const c = fakeComputer({ pages: { 'https://example.com/a/b': redirect('https://example.com/a/b', '../next'), 'https://example.com/next': page } });
    await browseInComputer(c, { url: 'https://example.com/a/b' });
    expect(fetched(c)).toEqual(['https://example.com/a/b', 'https://example.com/next']);
  });

  it('stops a redirect loop', async () => {
    const c = fakeComputer({ pages: { 'https://example.com/': redirect('https://example.com/', 'https://example.com/') } });
    await expect(browseInComputer(c, { url: 'https://example.com' })).rejects.toThrowError(/redirected more than 10 times/);
  });

  it('returns the redirect itself when asked not to follow', async () => {
    const c = fakeComputer({ pages: { 'https://example.com/': redirect('https://example.com/', 'http://169.254.169.254/') } });
    expect((await browseInComputer(c, { url: 'https://example.com', follow: false })).status).toBe(302);
  });
});
