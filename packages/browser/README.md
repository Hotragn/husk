# @husk/browser

A real Chromium, running **inside the agent's computer**, driven over the Chrome
DevTools Protocol.

`browseInComputer` in `@husk/core` fetches HTML with `urllib` and strips the
tags. That is the right zero-dependency floor and it is not going anywhere — but
it cannot see a page that only exists after JavaScript runs, it cannot log in,
and it cannot click. This can.

The browser lives in the same machine as the shell and the filesystem, for the
same reason the fetch does: a browser on the host would have a different IP, a
different DNS view, and an egress path the computer's `network` policy does not
govern.

**The driver lives there too.** Chromium's `--remote-debugging-port` binds
loopback, and the answer to that is not to widen the bind address — an
unauthenticated CDP port is a remote-code-execution primitive. So husk does not
connect to the browser from the host, and does not publish the port: it runs a
small Python CDP client *in the computer* and reads one JSON object back off
stdout. Nothing here calls `exposePort`, and `--remote-debugging-address` does
not appear anywhere in this package.

A round trip is one process start plus one websocket handshake — about 165 ms on
the `local` provider on WSL2, of which roughly 145 ms is that provider's own
cost of starting any process at all. Each `Page` method is one driver invocation
wherever the CDP sequence allows it, which is the lever if that ever stops being
fast enough.

## Example

```ts
import { LocalProvider } from '@husk/runtime';
import { browserFor } from '@husk/browser';

const computer = await new LocalProvider().create({
  name: 'browsing',
  network: { mode: 'full' },
});

const browser = browserFor(computer);

// Provisions Chromium on first use: system binary -> cached download -> CDN.
await browser.goto('https://example.com');

const page = await browser.activePage();
for (const node of await page.snapshot()) {
  console.log(node.ref, node.role, node.name);
}

await page.click('e42');          // refs come from the snapshot, never pixels
await page.type('e17', 'husk');
await page.press('Enter');
console.log(await page.text());

await browser.close();
```

## What it does

- **`provision.ts`** — finds a system `chromium` / `google-chrome`, else a copy
  already downloaded into the computer, else downloads one for the detected
  architecture. On **x86-64** that is Chrome for Testing's
  `chrome-headless-shell-linux64.zip`, which unpacks to
  `chrome-headless-shell-linux64/chrome-headless-shell`. On **arm64** Chrome for
  Testing publishes nothing at all, so it is Playwright's CDN, which unpacks to
  `chrome-linux/headless_shell` — a different directory *and* a different binary
  name. That mapping is the thing most likely to rot silently, so it is data
  with a unit test rather than an `if` in the install path.
- **`driver.py`** — the CDP client, executed **inside the computer**. One
  process per command: connect to Chromium on the machine's own loopback, run a
  short list of steps, print one JSON object, exit. It needs nothing but
  `python3`, which every flavour has.
- **`cdp.ts`** — the transport. Runs `driver.py` through `Computer.exec` and
  turns its JSON into results or a `HuskError`, keeping apart the failures that
  need different fixes: the browser is not listening, it died holding your
  command, the page never answered, Chromium refused the command, the driver
  could not run at all.
- **`page.ts`** — `goto`, `snapshot`, `click`, `type`, `press`, `screenshot`,
  `evaluate`, `content`, `text`, `waitForLoad`.
- **`session.ts`** — one browser per computer, launched lazily and closed after
  five idle minutes, because a resident Chromium is a few hundred megabytes of
  RSS and a machine with four of them gets OOM-killed. The user-data-dir is
  persisted, so a login survives the relaunch.

## Refs, not coordinates

`snapshot()` flattens `Accessibility.getFullAXTree` into
`{ ref, role, name, value }`. A `ref` of `e42` is Chromium's backend node id, so
it identifies the same element across snapshots for as long as the element is in
the document. There is deliberately no `click(x, y)`: a model that infers a
pixel from a screenshot will eventually click the wrong thing, and the wrong
thing is sometimes "Delete account".

Nodes with no DOM element get an `a`-prefixed ref, and `click` refuses those
explicitly rather than resolving them to something nearby.

## Network policy

Every navigation goes through `assertUrlAllowed` from `@husk/core`, with the
same `loopbackIsOwn` rule `browseInComputer` uses: `docker`, `podman` and `fly`
own their loopback, `local` and `ssh` do not. `mode: 'full'` still refuses
`169.254.169.254`. A real browser — which will follow a redirect chain a
prompt-injected page hands it — makes this matter more, not less.

## Not sandboxed by itself

Chromium runs with `--no-sandbox`. The computer *is* the sandbox; Chromium's own
namespace sandbox cannot nest inside an unprivileged container, and on the
`local` provider there is no kernel boundary to begin with. Run untrusted pages
in a `docker` or `podman` computer.

One caveat measured rather than assumed: on `local` under **WSL2**, Windows'
loopback relay forwards a WSL `127.0.0.1` listener to the Windows host, so the
debug port is reachable from the host there even though husk never publishes it.
That is WSL's networking, not husk's — and it is one more reason the `local`
provider reports `isolationKind: 'guardrails'` rather than claiming isolation.
On `docker`, `podman` and `fly`, container loopback is not reachable from the
host, and nothing in this package needs it to be.
