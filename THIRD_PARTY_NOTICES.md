# Third-party notices

Husk takes ideas from the projects below. No code from them is included or
required at run time.

## ego-lite

https://github.com/citrolabs/ego-lite

Two ideas in `@husk-ai/browser` and `@husk-ai/mcp` come from ego-lite's MIT
licensed agent-side code and docs:

- *Code over calls*: one call runs several page actions in a single round,
  which is `browser_run` and the `action` steps in `packages/browser/src/driver.py`.
- *Scripts with control flow*: `browser_script` runs a model's script against
  the page in one call, with a `page` object whose names follow ego-lite's
  Playwright-style API where they fit (`goto`, `click`, `fill`,
  `wait_for_url`, `wait_for_selector`, `title`). Husk's runs as Python in its
  own process inside the computer: `SCRIPT_RUNNER` in `driver.py`.
- *Compact snapshots*: the rules in its `docs/native-snapshot-ref-requirement.md`
  for dropping blank text and empty containers and collapsing single-child
  ones, which is `compactAxTree` in `packages/browser/src/page.ts`.

ego-lite's browser engine is a separate, closed download, and Husk neither
uses nor needs it.

```
MIT License

Copyright (c) 2026 CitroLabs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
