import { lookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { HUSK_BROWSER_USER_AGENT } from '@husk-ai/core';
import type { FetchedSource } from './types.js';
import { WorkspaceError } from './errors.js';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  denied.addSubnet(address, prefix, 'ipv6');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

/** Deny special-use addresses, including IPv4-mapped IPv6, before any socket opens. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !denied.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}

export function publicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new WorkspaceError('INVALID_INPUT', 'Enter a complete public URL, such as https://example.com.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new WorkspaceError('SOURCE_BLOCKED', 'Sources must use a public HTTP or HTTPS URL.');
  if (url.username || url.password) throw new WorkspaceError('SOURCE_BLOCKED', 'Source URLs cannot contain credentials.');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host.includes('.') && !isIP(host) || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) {
    throw new WorkspaceError('SOURCE_BLOCKED', 'Local and private addresses cannot be captured as public sources.');
  }
  if (isIP(host) && !isPublicAddress(host)) throw new WorkspaceError('SOURCE_BLOCKED', 'Local and private addresses cannot be captured as public sources.');
  url.hash = '';
  return url;
}

type Response = { status: number; location?: string; contentType: string; body: Buffer; truncated: boolean };

async function pinnedRequest(url: URL, signal: AbortSignal): Promise<Response> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
      const onAbort = () => reject(new WorkspaceError('SOURCE_TIMEOUT', 'Source fetch timed out.', 504));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      lookup(host, { all: true, verbatim: true }).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new WorkspaceError('SOURCE_BLOCKED', 'This source resolves to a private or reserved address and cannot be fetched.');
  }
  const pinned = addresses.find(({ family }) => family === 4) ?? addresses[0]!;
  // Supply only the already-checked address to the connection. A second DNS
  // lookup would allow DNS rebinding between authorization and connection.
  const options: RequestOptions & { autoSelectFamily: boolean } = {
    agent: false,
    family: pinned.family,
    autoSelectFamily: false,
    signal,
    lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    headers: {
      'User-Agent': HUSK_BROWSER_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown',
      'Accept-Encoding': 'identity',
    },
  };
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, (response) => {
      const status = response.statusCode ?? 0;
      const contentType = response.headers['content-type'] ?? '';
      if ([301, 302, 303, 307, 308].includes(status)) {
        resolve({ status, location: response.headers.location, contentType, body: Buffer.alloc(0), truncated: false });
        response.destroy();
        return;
      }
      if (status < 200 || status >= 300) {
        reject(new Error(`The source returned HTTP ${status}. It was not saved.`));
        response.destroy();
        return;
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        reject(new Error('This source requires compressed content that the source reader does not support.'));
        response.destroy();
        return;
      }
      if (!/^(text\/(html|plain|markdown)|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
        reject(new Error(`Unsupported source type: ${contentType || 'unspecified'}. Use an HTML or plain-text page.`));
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        const remaining = MAX_BYTES - bytes;
        chunks.push(chunk.subarray(0, Math.max(remaining, 0)));
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          resolve({ status, contentType, body: Buffer.concat(chunks), truncated: true });
          response.destroy();
        }
      });
      response.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks), truncated: false }));
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('The source connection ended before the page was complete.')));
    });
    request.on('error', (error) => reject(signal.aborted ? new Error('Source fetch timed out.') : error));
    request.end();
  });
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? match;
    const n = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\uFFFD';
  });
}

export function extractText(body: string, html: boolean): { title: string; content: string } {
  if (!html) return { title: '', content: body.replace(/\u0000/g, '').trim() };
  const title = decodeEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '').replace(/<[^>]*>/g, '').trim().slice(0, 300);
  const content = decodeEntities(body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\u0000/g, '').replace(/[^\S\n]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return { title, content };
}

async function fetchSource(value: string): Promise<FetchedSource> {
  let url = publicUrl(value);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await pinnedRequest(url, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location) throw new Error('The source redirected without a destination.');
      url = publicUrl(new URL(response.location, url).href);
      continue;
    }
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.contentType)?.[1] ?? 'utf-8';
    let body: string;
    try { body = new TextDecoder(charset).decode(response.body); }
    catch { throw new Error(`Unsupported source character encoding: ${charset}.`); }
    const extracted = extractText(body, /html/i.test(response.contentType));
    if (!extracted.content) throw new Error('No readable text was found. This page may require JavaScript or a sign-in.');
    return { ...extracted, finalUrl: url.href, contentType: response.contentType, truncated: response.truncated };
  }
  throw new Error(`The source exceeded ${MAX_REDIRECTS} redirects. It was not saved.`);
}

export async function fetchPublicSource(value: string): Promise<FetchedSource> {
  try { return await fetchSource(value); }
  catch (error) {
    if (error instanceof WorkspaceError) throw error;
    const message = error instanceof Error ? error.message : 'The source could not be fetched.';
    if (/timed out/i.test(message)) throw new WorkspaceError('SOURCE_TIMEOUT', message, 504);
    throw new WorkspaceError('SOURCE_FAILED', message, 502);
  }
}
