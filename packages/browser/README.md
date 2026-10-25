# @husk-ai/browser

A real Chromium, running **inside the agent's computer**, driven over the Chrome
DevTools Protocol.

`browseInComputer` in `@husk-ai/core` fetches HTML with `urllib` and strips the
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
small Python CDP client *in the computer* and reads JSON back off its stdout.
Nothing here calls `exposePort`, and `--remote-debugging-address` does not
appear anywhere in this package.

Where the provider can hold a process's stdin open (`Computer.spawn`: Docker,
Podman, `local`), one driver lives as long as the browser and keeps one
websocket to it, so a command costs its CDP round trips and nothing else, and
the live screen is Chrome's own screencast pushed through it. Elsewhere each
request is one process start plus one websocket handshake — about 165 ms on
WSL2. Either way a request is a list of steps, and `Page.actions` (the
`browser_run` tool) makes several whole page actions one request.

## Example

```ts
import { LocalProvider } from '@husk-ai/runtime';
import { browserFor } from '@husk-ai/browser';

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
- **`driver.py`** — the CDP client, executed **inside the computer**, talking
  to Chromium on the machine's own loopback. `--serve` keeps it running and
  answers newline-delimited requests by id, and pushes screencast frames acked
  no faster than the viewer's rate; without it, one request in, one answer out,
  exit. It needs nothing but `python3`, which every flavour has.
- **`cdp.ts`** — the transport. Holds one `driver.py --serve` per browser, falls
  back to one `Computer.exec` per request where it cannot, and turns the JSON
  into results or a `HuskError`, keeping apart the failures that need different
  fixes: the browser is not listening, it died holding your command, the page
  never answered, Chromium refused the command, the driver could not run at all.
- **`page.ts`** — `goto`, `snapshot`, `click`, `type`, `press`, `screenshot`,
  `evaluate`, `content`, `text`, `waitForLoad`, `actions` for several at once,
  and `script` for a model's Python that decides as it goes. The script runs in
  its own process inside the computer and is stopped at its limit (at most
  600 s). The stop kills its process group, plus every process that still
  carries its tag in the environment, which catches a grandchild that called
  `setsid`; one that also scrubs its environment escapes, as a process
  started from `shell` would. Printed output, `result` and the error are each
  capped. Every `page.goto` it makes is checked by the host's network policy
  before Chromium moves. That check is what it is and no more: clicks,
  `fill(submit=True)`, redirects and page scripts are not checked, as with
  `browser_click`. And a script, like `shell`, runs in the computer, where
  it can reach Chromium's raw CDP port on 127.0.0.1 itself. The computer,
  not the check, is the boundary.
- **`session.ts`** — one browser per computer, launched lazily and closed after
  five idle minutes, because a resident Chromium is a few hundred megabytes of
  RSS and a machine with four of them gets OOM-killed. The user-data-dir is
  persisted, so a login survives the relaunch.

## Refs, not coordinates

`snapshot()` turns `Accessibility.getFullAXTree` into a compact tree of
`{ ref, role, name, value, depth }`, by the rules credited in
`THIRD_PARTY_NOTICES.md`: blank text and empty containers
go, a container with one child becomes that child, and groups, refs, order and
frame boundaries stay. A `ref` of `e42` is Chromium's backend node id, so
it identifies the same element across snapshots for as long as the element is in
the document. There is deliberately no `click(x, y)`: a model that infers a
pixel from a screenshot will eventually click the wrong thing, and the wrong
thing is sometimes "Delete account".

Nodes with no DOM element get an `a`-prefixed ref, and `click` refuses those
explicitly rather than resolving them to something nearby.

## Honest clicks

A click is refused, saying why, before anything is pressed:

- when its element is gone, disabled (a disabled form control, or `aria-disabled`),
  hidden, or of no size;
- when its element is still moving: two box readings 50 ms apart must agree to the
  pixel, within half a second;
- when something covers it: a hit test at the point the click would land must find the
  element or something inside it, and the refusal names what is there instead;
- when a role and name match more than one element, rather than taking the first.

`force` skips every check and presses at the element's centre, as clicks always did.
`browser_click` says which happened: a checked click landed on its element, and a
forced one was only dispatched. One path does every click: `browser_click`,
`browser_run`, `page.click` in a script and the console's Browser page all use the
driver's `click` action.

## Network policy

Every URL Husk opens — `goto`, a tab opened with `newTab`, the `goto` steps of `run`,
and the `page.goto` calls of a script — goes through `assertUrlAllowed` from
`@husk-ai/core`, with the same `loopbackIsOwn` rule `browseInComputer` uses: `docker`,
`podman` and `fly` own their loopback, `local` and `ssh` do not. `mode: 'full'` still
refuses `169.254.169.254`, in its IPv6 spellings too. A real browser — which will follow
a redirect chain a prompt-injected page hands it — makes this matter more, not less,
and the check still does not see a page navigating itself (links, scripts, pop-ups).
Closing that gap is tracked in [#187](https://github.com/Hotragn/husk/issues/187).

## Chromium's own sandbox

In a `docker` or `podman` container, or on a `fly` machine, Chromium runs with
`--no-sandbox`: its namespace sandbox cannot nest inside an unprivileged container, and
the computer is the boundary. On `local`, in WSL and over `ssh` it keeps its sandbox,
the only thing there between a hostile page and your account. Where that sandbox
cannot run at all — no unprivileged user namespaces, or running as root — Chromium is
started again without it and Husk says so. Run untrusted pages in a `docker` or
`podman` computer.

One caveat measured rather than assumed: on `local` under **WSL2**, Windows'
loopback relay forwards a WSL `127.0.0.1` listener to the Windows host, so the
debug port is reachable from the host there even though husk never publishes it.
That is WSL's networking, not husk's — and it is one more reason the `local`
provider reports `isolationKind: 'guardrails'` rather than claiming isolation.
On `docker`, `podman` and `fly`, container loopback is not reachable from the
host, and nothing in this package needs it to be.
