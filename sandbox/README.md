# Husk images

Optional images, for anyone who would rather run their own than pull from Docker Hub.
By default husk pulls a public upstream image per flavor and builds none of these; see
`packages/runtime/src/images.ts`.

| flavor | contents | size (approx, amd64) | use it for |
| --- | --- | --- | --- |
| `base` | Debian bookworm-slim, git, curl, jq, ripgrep, fd | ~120 MB | shell work, text wrangling, the default |
| `python` | base + Python 3.11, uv, requests/httpx/rich | ~280 MB | data work, scripting, notebooks |
| `node` | base + Node 22, npm, corepack | ~230 MB | JS/TS tooling, web scraping |
| `full` | python + node + build-essential, ffmpeg, imagemagick | ~900 MB | "build and test this repo" |

## Design rules

**Never root.** Every image ships with the root account locked, no sudo, and a `husk`
user at uid 1000. There is no path from inside the machine to a privileged process.

**tini as pid 1.** A container used as a long-lived exec host accumulates zombies
otherwise, and a wedged pid 1 makes `docker stop` hang for its full 10s grace period.

**`/work` is the only writable place that matters.** The runtime mounts the root
filesystem read-only and gives `/work` and `/tmp` their own writable layers. An agent
that writes outside `/work` gets an honest permission error instead of silently
mutating an image layer that will vanish.

**`huskinfo` exists so agents stop probing.** An unfamiliar machine costs an agent
three or four turns of `uname`, `nproc`, `df`, `which python3`. One command answers
all of it:

```
$ huskinfo
husk 0.1.0 (flavor: python)
os        Debian GNU/Linux 12 (bookworm)
kernel    6.10.14-linuxkit
arch      x86_64
user      husk (uid 1000)
workdir   /work
cpus      2
memory    1024MB
disk      58G free on /work
network   egress reachable
tools     git curl jq rg fd python3
```

## Building

```bash
./build.sh              # all flavors, local, single-arch
./build.sh base python  # a subset
HUSK_REGISTRY=ghcr.io/you PUSH=1 ./build.sh   # multi-arch, pushed there
```

`base` must be built before the others — they are `FROM` it.

## Not using these images

You do not have to, and by default you do not. Each flavor resolves to a public image
— `debian:bookworm-slim`, `python:3.12-slim`, `node:22-slim`, and Playwright's
`mcr.microsoft.com/playwright:v1.59.1-noble` for `full` — none of which carry
`huskinfo` or the non-root guarantees these Dockerfiles bake in. The container still
runs as uid 1000 either way, because `-u 1000:1000` is passed regardless.

`flavor` is a convenience; `image` overrides it with anything:

```yaml
computer:
  image: python:3.12-slim
```

To run these images instead, build them, push them somewhere, and point `HUSK_REGISTRY`
at it. husk will then prefer `<registry>/husk-<flavor>:<tag>` and fall back to the
public image if that pull fails.
