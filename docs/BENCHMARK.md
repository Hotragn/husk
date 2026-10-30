# Husk against Playwright MCP

Every e2e run measures Husk's browser tools against
[Playwright MCP](https://github.com/microsoft/playwright-mcp), pinned to `0.0.83`. Both
run on the same computer with the same Chromium binary, on the same seven tasks. The
results go to the run's job summary and to `benchmark.json` among its screenshots. The
benchmark is `benchmarkAgainstPlaywright` in [`scripts/e2e-computers.mjs`](../scripts/e2e-computers.mjs).

## The latest numbers

From CI run [40247107065](https://github.com/Hotragn/husk/actions/runs/40247107065)
(commit `ba3f558`, October 2026). Five runs per task, the median time with the worst in
brackets, and the bytes each tool set read back:

| Task | Husk | Playwright MCP 0.0.83 |
| --- | --- | --- |
| read a page | 5/5 done, 1 call, 43 ms (45), 155 B | 5/5 done, 2 calls, 28 ms (194), 478 B |
| sign in with a form | 5/5 done, 1 call, 366 ms (378), 439 B | 5/5 done, 3 calls, 550 ms (557), 699 B |
| accept a confirm dialog | 5/5 done, 1 call, 350 ms (351), 381 B | 5/5 done, 4 calls, 571 ms (579), 782 B |
| catch a 150 ms toast | 5/5 done, 1 call, 350 ms (366), 301 B | 5/5 done, 4 calls, 1566 ms (1567), 811 B |
| type in a cross-site frame | 5/5 done, 2 calls, 92 ms (92), 703 B | 5/5 done, 4 calls, 83 ms (89), 950 B |
| download a file | 5/5 done, 1 call, 352 ms (366), 313 B | 5/5 done, 2 calls, 553 ms (567), 548 B |
| follow a link to a new tab | 5/5 done, 2 calls, 400 ms (416), 561 B | 5/5 done, 4 calls, 587 ms (603), 1436 B |

- Both tool sets did every task.
- Husk used fewer calls on every task: 9 across the seven, against 23. Each call is a
  model turn, and a turn costs far more than either tool's milliseconds.
- Husk read back fewer bytes on every task.
- Playwright MCP was faster on reading a page and on typing in a frame.
- Husk's ~350 ms on actions is its wait for the page to settle, after which it says
  what happened.

Later runs measure again; the job summary has the current numbers.

## How it is run

**The tasks** are fixture pages served from inside the computer: read a page, sign in
with a form, accept a confirm dialog, catch a toast that shows for 150 ms, type into a
cross-site frame, download a file, and follow a link to a new tab.

**The two tool sets:**

- Husk runs through the chat's own tools, on its own long-lived Chromium.
- Playwright MCP runs inside the computer and launches the same Chromium binary itself,
  headless and isolated, as it does by default.

**The plans** are scripted, not a model, since a model in CI would need an API key. Each
tool set uses its own tools as economically as it can and still does the task:

- **Husk:** `browser_run`, `waitFor` and `dialog`.
- **Playwright MCP:** selectors as targets, `browser_handle_dialog`, `browser_tabs`, and
  `browser_evaluate` to watch for the toast from before the click. A wait that starts
  after the click returns misses it.

**Not measured:** what a model would do with each tool set. A model-driven run, with the
same client and model on both sides, needs an API key in CI.
