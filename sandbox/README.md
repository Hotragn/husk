# Husk images

The machines an agent gets.

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
PUSH=1 ./build.sh       # multi-arch to ghcr.io
```

`base` must be built before the others — they are `FROM` it.

## Not using our images

You do not have to. `flavor` is a convenience; `image` overrides it with anything:

```yaml
computer:
  image: python:3.12-slim
```

The runtime falls back to upstream public images (`debian:bookworm-slim`,
`python:3.12-slim`, `node:22-slim`) when a husk image is not present locally and
cannot be pulled, so a fresh install works before anyone has published anything.
You lose `huskinfo` and the non-root guarantees the husk images bake in.
