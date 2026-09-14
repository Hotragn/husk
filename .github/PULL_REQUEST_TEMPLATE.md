## What does this change?



## Why?



## How to test

```bash
npm run build:packages && npm run typecheck && npm test
```

<!-- Then describe what to run manually, if anything. -->

## Checklist

- [ ] `npm run build:packages && npm run typecheck && npm test` passes
- [ ] I actually ran the thing I changed (`husk doctor`, `husk up`, `husk exec`, etc.)
- [ ] New code follows the [build contract](docs/BUILD-CONTRACT.md)
- [ ] No new dependencies unless justified in the PR description
