# Contributing

## Setup

```bash
npm install
npm run build
npm test
node packages/cli/dist/bin.js doctor
```

Node ≥ 20.10. Nothing else is required — no Docker, no API key. If any of those four
commands needs something you do not have, that is a bug worth reporting on its own.

## Read this first

[`docs/BUILD-CONTRACT.md`](docs/BUILD-CONTRACT.md) is the set of rules every package
obeys. It is short, and it is not optional. The parts that trip people up:

- **ESM only, and relative imports carry `.js`.** NodeNext resolution.
- **No native modules.** Ever. A Windows `npm install` must be clean without a C++
  toolchain, which is worth more than SQLite would be.
- **Dependencies run downhill.** `core` ← `runtime`/`models`/`sessions` ← `agent` ←
  `mcp`/`server`/`adapters` ← `cli`. Never sideways, never up, never into another
  package's `src/`.
- **Two tsconfigs per package.** `tsconfig.json` for typecheck, `tsconfig.build.json`
  for build. Compiled tests must not ship.

## The values that show up in code review

**Every error is actionable.** Throw `HuskError` with a code and a one-line `hint` that
names the fix. "docker is installed but the daemon is not reachable → start Docker
Desktop" is the standard. "Install Docker" when Docker is already installed is a bug we
have actually shipped and fixed.

**Never claim isolation you do not provide.** `Availability.isolationKind` exists
because a boolean overclaimed for `ssh`. If you add a provider, be precise about what
its boundary actually is, in the code and in `husk doctor`.

**The free path is the default path.** No API key, no Docker, no account: everything
still runs. If a change makes a feature require one of those, it needs a fallback or it
needs to degrade with an explanation.

**Comments explain why.** A comment restating the line below it will be removed in
review. A comment explaining a non-obvious constraint — why `close` and not `exit`, why
`unshare -mr`, why the deny list is anchored to command position — is the point.

## Tests

Vitest, colocated as `src/**/*.test.ts`. Test the logic that would rot silently:
parsers, policy decisions, budget and retry maths, wire-format translation. Do not
write tests that assert a mock was called.

Every test must pass with **no Docker, no API key, no network**. The suite runs on a
laptop and in CI with nothing installed; if your test needs a daemon, it is testing the
daemon.

```bash
npx vitest run                       # everything
npx vitest run packages/runtime      # one package
npx vitest run -t "path jail"        # one description
```

## Before you open a PR

```bash
npm run build:packages && npm run typecheck && npm test
```

Then actually run the thing you changed. `husk doctor`, `husk up`, `husk exec` — the
CLI is the product's face, and a change that typechecks but reads badly in a terminal
is not done.

## Adding a computer provider

Implement `ComputerProvider` from `@husk/core`. The bar:

- `isAvailable()` never throws, and distinguishes *not installed* from *installed but
  not running* from *installed and refusing this user*, each with its own hint.
- Set `isolationKind` honestly.
- Reuse `policy.ts` — the path jail, command policy, env scrubbing and `OutputBuffer`
  are shared so a command refused in one place is refused everywhere.
- Tests pass without the underlying tool installed.

## Adding a model provider

If it speaks the OpenAI dialect, add a configuration to `src/providers/compatible.ts`
— base URL, env var, catalogue slice, any header quirk. Do not copy the OpenAI provider.
If it does not, write the translation properly, as `google.ts` does.

`isAvailable()` must report the exact environment variable in its hint, and must never
throw when the key is missing.

## Commits

Present tense, explain the why in the body when it is not obvious. No emoji, no
Conventional Commits ceremony.
