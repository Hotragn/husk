import { HuskError } from './errors.js';
import { assertUrlAllowed, ownsLoopback } from './net.js';
import type { Computer } from './types/computer.js';
import type { NetworkPolicy } from './types/computer.js';

/**
 * Browsing, from inside the computer.
 *
 * The point is not to reimplement a browser. The point is that the agent's
 * browser, its terminal and its filesystem are all views of the *same machine*.
 * A `fetch()` from the host process is a different machine with a different IP,
 * a different DNS view and a different egress path -- so a page the human sees
 * in the console is not necessarily the page the agent got, and a network policy
 * scoped to the computer would not apply to it.
 *
 * Everything here runs as a script in the computer. It needs only python3 or
 * curl, both of which the husk images and a stock WSL both have.
 */

/**
 * The serialisable half of a browse request -- exactly what goes over the wire.
 *
 * Split from `BrowseRequest` because the route schema is `.strict()`: a client
 * that reused a type carrying `signal` would send it and get a 422.
 */
export interface BrowseBody {
  url: string;
  /** Follow redirects. Defaults to true. */
  follow?: boolean;
  /** Give up after this many seconds. Defaults to 30. */
  timeoutSec?: number;
  /** Cap the extracted text. Defaults to 200 KB. */
  maxBytes?: number;
}

export interface BrowseRequest extends BrowseBody {
  signal?: AbortSignal;
}

export interface BrowseLink {
  text: string;
  href: string;
}

export interface BrowsePage {
  /** The URL actually loaded, after redirects. */
  url: string;
  requestedUrl: string;
  status: number;
  contentType: string;
  title: string;
  /** Readable text, tags stripped, whitespace collapsed. */
  text: string;
  links: BrowseLink[];
  /** Bytes actually read, i.e. after any truncation. */
  bytes: number;
  /** What the server claimed in Content-Length, when it said. Null otherwise. */
  totalBytes: number | null;
  truncated: boolean;
  elapsedMs: number;
  /** The tool that did the fetch, so the console can say so. */
  via: 'python3' | 'curl';
}

/** Written into the computer once, then reused. */
const FETCH_SCRIPT = String.raw`
import json, re, sys, html, urllib.request, urllib.error, urllib.parse, time

url, follow, timeout, max_bytes = sys.argv[1], sys.argv[2] == "1", float(sys.argv[3]), int(sys.argv[4])

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None

opener = urllib.request.build_opener(*([] if follow else [NoRedirect]))
req = urllib.request.Request(url, headers={
    "User-Agent": "husk-browser/0.1 (+https://husk.sh)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    "Accept-Language": "en",
})

started = time.time()
status, final, ctype, raw, declared = 0, url, "", b"", None
try:
    with opener.open(req, timeout=timeout) as res:
        status = res.status
        final = res.geturl()
        ctype = res.headers.get("Content-Type", "")
        declared = res.headers.get("Content-Length")
        raw = res.read(max_bytes + 1)
except urllib.error.HTTPError as e:
    status, final, ctype = e.code, e.geturl(), e.headers.get("Content-Type", "")
    raw = e.read(max_bytes + 1)
except Exception as e:
    print(json.dumps({"error": str(e)}))
    raise SystemExit(0)

truncated = len(raw) > max_bytes
raw = raw[:max_bytes]

charset = "utf-8"
m = re.search(r"charset=([\w-]+)", ctype, re.I)
if m:
    charset = m.group(1)
body = raw.decode(charset, errors="replace")

title, text, links = "", "", []
if "html" in ctype.lower() or body.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
    t = re.search(r"<title[^>]*>(.*?)</title>", body, re.S | re.I)
    title = html.unescape(t.group(1)).strip()[:300] if t else ""

    for m in re.finditer(r'<a\s[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', body, re.S | re.I):
        href = html.unescape(m.group(1)).strip()
        if href.startswith(("#", "javascript:", "mailto:")):
            continue
        label = html.unescape(re.sub(r"<[^>]+>", " ", m.group(2)))
        label = re.sub(r"\s+", " ", label).strip()
        if not label:
            continue
        links.append({"text": label[:160], "href": urllib.parse.urljoin(final, href)})
        if len(links) >= 300:
            break

    stripped = re.sub(r"(?is)<(script|style|noscript|template|svg)\b.*?</\1>", " ", body)
    stripped = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</h[1-6]>", "\n", stripped)
    stripped = re.sub(r"<[^>]+>", " ", stripped)
    text = html.unescape(stripped)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text).strip()
else:
    text = body

print(json.dumps({
    "url": final, "status": status, "contentType": ctype, "title": title,
    "text": text, "links": links, "bytes": len(raw), "truncated": truncated,
    "totalBytes": int(declared) if declared and declared.isdigit() else None,
    "elapsedMs": int((time.time() - started) * 1000),
}))
`;

const SCRIPT_PATH = '/tmp/.husk-browse.py';

/**
 * Load a page from inside `computer`, honouring its network policy.
 *
 * The policy check happens here, on the parsed URL, rather than being left to
 * the provider: the `local` provider cannot filter egress at the OS level, so
 * this is the only place the declared policy becomes real for a fetch husk
 * makes on the agent's behalf.
 */

export async function browseInComputer(
  computer: Computer,
  req: BrowseRequest,
  policy?: NetworkPolicy,
): Promise<BrowsePage> {
  const effective = policy ?? computer.info.spec.network;
  const parsed = assertUrlAllowed(req.url, effective, {
    loopbackIsOwn: ownsLoopback(computer.info.provider),
  });

  const timeoutSec = req.timeoutSec ?? 30;
  const maxBytes = req.maxBytes ?? 200 * 1024;
  const follow = req.follow !== false;

  const hasPython = await probe(computer, 'python3', req.signal);
  if (!hasPython) return await browseWithCurl(computer, parsed, { follow, timeoutSec, maxBytes, signal: req.signal });

  await computer.writeFile(SCRIPT_PATH, FETCH_SCRIPT);
  const result = await computer.exec({
    cmd: ['python3', SCRIPT_PATH, parsed.toString(), follow ? '1' : '0', String(timeoutSec), String(maxBytes)],
    timeoutSec: timeoutSec + 10,
    maxOutputBytes: maxBytes + 64 * 1024,
    ...(req.signal ? { signal: req.signal } : {}),
  });

  if (result.exitCode !== 0 && !result.stdout.trim()) {
    throw new HuskError('E_EXEC_FAILED', `could not load ${parsed.hostname}`, {
      hint: 'check the computer has egress with `husk exec <name> -- curl -sS -o /dev/null -w "%{http_code}" https://example.com`',
      details: { stderr: result.stderr.slice(0, 500) },
    });
  }

  let parsedOut: Record<string, unknown>;
  try {
    parsedOut = JSON.parse(lastJsonLine(result.stdout)) as Record<string, unknown>;
  } catch {
    throw new HuskError('E_EXEC_FAILED', `the page fetcher returned something unreadable`, {
      hint: 'this is a husk bug; the raw output is in details',
      details: { stdout: result.stdout.slice(0, 500) },
    });
  }

  if (typeof parsedOut.error === 'string') {
    throw new HuskError('E_EXEC_FAILED', `could not load ${parsed.hostname}: ${parsedOut.error}`, {
      hint: 'the machine reached the network but the request failed -- check the URL and the host',
    });
  }

  return {
    requestedUrl: parsed.toString(),
    url: String(parsedOut.url ?? parsed.toString()),
    status: Number(parsedOut.status ?? 0),
    contentType: String(parsedOut.contentType ?? ''),
    title: String(parsedOut.title ?? ''),
    text: String(parsedOut.text ?? ''),
    links: Array.isArray(parsedOut.links) ? (parsedOut.links as BrowseLink[]) : [],
    bytes: Number(parsedOut.bytes ?? 0),
    totalBytes: typeof parsedOut.totalBytes === 'number' ? parsedOut.totalBytes : null,
    truncated: Boolean(parsedOut.truncated),
    elapsedMs: Number(parsedOut.elapsedMs ?? 0),
    via: 'python3',
  };
}

/** No python3: fall back to curl and return the body with no extraction. */
async function browseWithCurl(
  computer: Computer,
  parsed: URL,
  opts: { follow: boolean; timeoutSec: number; maxBytes: number; signal?: AbortSignal },
): Promise<BrowsePage> {
  const started = Date.now();
  const args = [
    'curl',
    '-sS',
    ...(opts.follow ? ['-L'] : []),
    '-m',
    String(opts.timeoutSec),
    '-A',
    'husk-browser/0.1 (+https://husk.sh)',
    '-w',
    '\\nHUSK_META %{http_code} %{content_type} %{url_effective}',
    parsed.toString(),
  ];
  const res = await computer.exec({
    cmd: args,
    timeoutSec: opts.timeoutSec + 10,
    maxOutputBytes: opts.maxBytes + 8192,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (res.exitCode !== 0) {
    throw new HuskError('E_EXEC_FAILED', `could not load ${parsed.hostname}`, {
      hint:
        'this machine has neither python3 nor curl, so there is nothing here to fetch with. ' +
        'Use a flavor whose image ships one -- `husk up <name> --flavor python` works today -- ' +
        'or point computer.image at your own. On the container providers `computer.packages` ' +
        'cannot help here: the root filesystem is mounted read-only on purpose, so no package ' +
        'manager can run.',
      details: { stderr: res.stderr.slice(0, 500) },
    });
  }

  const meta = /\nHUSK_META (\d+) (\S*) (\S+)\s*$/.exec(res.stdout);
  const body = meta ? res.stdout.slice(0, meta.index) : res.stdout;
  return {
    requestedUrl: parsed.toString(),
    url: meta?.[3] ?? parsed.toString(),
    status: meta ? Number(meta[1]) : 0,
    contentType: meta?.[2] ?? '',
    title: '',
    text: stripTags(body),
    links: [],
    bytes: Buffer.byteLength(body, 'utf8'),
    totalBytes: null,
    truncated: res.truncated,
    elapsedMs: Date.now() - started,
    via: 'curl',
  };
}

async function probe(computer: Computer, bin: string, signal?: AbortSignal): Promise<boolean> {
  const r = await computer
    .exec({
      cmd: `command -v ${bin} >/dev/null 2>&1 && echo yes || echo no`,
      timeoutSec: 20,
      ...(signal ? { signal } : {}),
    })
    .catch(() => undefined);
  return r?.stdout.includes('yes') ?? false;
}

/** The script prints one JSON object last; shells sometimes prepend noise. */
function lastJsonLine(out: string): string {
  const lines = out.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith('{') && line.endsWith('}')) return line;
  }
  return out.trim();
}

function stripTags(input: string): string {
  return input
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}
