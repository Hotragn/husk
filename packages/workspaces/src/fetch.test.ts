import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:http';
import { fetchPublicSource, isPublicAddress, publicUrl } from './fetch.js';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:http', () => ({ request: mocks.request }));
vi.mock('node:https', () => ({ request: mocks.request }));

type Fixture = { status?: number; type?: string; location?: string; body?: string; encoding?: string; error?: string };
let fixtures: Fixture[];

beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  fixtures = [];
  mocks.request.mockReset().mockImplementation((_url, _options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => queueMicrotask(() => {
      const fixture = fixtures.shift() ?? { body: '<title>Example</title><p>Useful text.</p>' };
      if (fixture.error) { request.emit('error', new Error(fixture.error)); return; }
      const response = Object.assign(new EventEmitter(), {
        statusCode: fixture.status ?? 200,
        headers: {
          'content-type': fixture.type ?? 'text/html; charset=utf-8',
          location: fixture.location,
          'content-encoding': fixture.encoding,
        },
        destroyed: false,
        destroy() { this.destroyed = true; },
      });
      callback(response);
      if (!response.destroyed) response.emit('data', Buffer.from(fixture.body ?? ''));
      if (!response.destroyed) response.emit('end');
    });
    return request;
  });
});

describe('public page capture', () => {
  it.each([
    'http://localhost', 'http://127.1', 'http://2130706433', 'http://0x7f000001',
    'http://192.168.1.2', 'http://169.254.169.254', 'http://[::1]', 'http://[::ffff:127.0.0.1]',
    'http://[fe80::1]', 'http://[fd00::1]', 'file:///etc/passwd', 'https://user:secret@example.com',
  ])('refuses %s without resolving or opening a socket', async (url) => {
    await expect(fetchPublicSource(url)).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' });
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each(['0.0.0.0', '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::ffff:8.8.8.8', '2001:db8::1', '2002:7f00:1::', '3fff::1'])('refuses reserved address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('allows ordinary public IPv4 and IPv6', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(publicUrl('https://example.com/a#section').href).toBe('https://example.com/a');
  });

  it('rejects a public hostname with any private DNS result', async () => {
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    await expect(fetchPublicSource('https://example.com')).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('pins the verified IP and sends no cookies or authentication', async () => {
    fixtures.push({ body: '<title>Useful &amp; saved</title><script>secret()</script><p>Fact &#65;.</p>' });
    const page = await fetchPublicSource('https://example.com/a');
    expect(page).toMatchObject({ finalUrl: 'https://example.com/a', title: 'Useful & saved', truncated: false });
    expect(page.content).toContain('Fact A.');
    expect(page.content).not.toContain('secret()');
    const options = mocks.request.mock.calls[0]![1] as RequestOptions;
    const callback = vi.fn();
    (options.lookup as Function)('example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(options.headers).not.toHaveProperty('Cookie');
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it('checks redirect destinations before opening their socket', async () => {
    fixtures.push({ status: 302, location: 'http://127.0.0.1/admin' });
    await expect(fetchPublicSource('https://example.com')).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' });
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('resolves and checks a redirected public name again', async () => {
    fixtures.push({ status: 301, location: 'https://other.example.com/page' }, { type: 'text/plain', body: 'Final text' });
    const page = await fetchPublicSource('https://example.com');
    expect(page.finalUrl).toBe('https://other.example.com/page');
    expect(page.content).toBe('Final text');
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });

  it('marks large pages as truncated and limits saved content', async () => {
    fixtures.push({ type: 'text/plain', body: 'x'.repeat(2 * 1024 * 1024 + 100) });
    const page = await fetchPublicSource('https://example.com');
    expect(page.truncated).toBe(true);
    expect(Buffer.byteLength(page.content)).toBe(2 * 1024 * 1024);
  });

  it.each([
    { status: 403, body: 'Access denied' }, { type: 'application/pdf', body: 'PDF' },
    { body: '<script>renderEverything()</script>' }, { encoding: 'gzip', body: 'compressed' },
  ])('reports unreadable responses instead of saving them as success: %j', async (fixture) => {
    fixtures.push(fixture);
    await expect(fetchPublicSource('https://example.com')).rejects.toMatchObject({ code: 'SOURCE_FAILED', statusCode: 502 });
  });

  it('exposes a useful timeout status', async () => {
    fixtures.push({ error: 'Source fetch timed out.' });
    await expect(fetchPublicSource('https://example.com')).rejects.toMatchObject({ code: 'SOURCE_TIMEOUT', statusCode: 504 });
  });
});
