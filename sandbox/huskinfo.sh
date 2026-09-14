#!/bin/sh
# `huskinfo` -- what an agent should read before it starts guessing.
#
# Agents waste turns probing an unfamiliar machine. One command answers all of it.
set -eu

printf 'husk %s (flavor: %s)\n' "${HUSK_VERSION:-0.1.0}" "${HUSK_FLAVOR:-base}"
printf 'os        %s\n' "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)"
printf 'kernel    %s\n' "$(uname -r)"
printf 'arch      %s\n' "$(uname -m)"
printf 'user      %s (uid %s)\n' "$(id -un)" "$(id -u)"
printf 'workdir   %s\n' "$(pwd)"

cpus=$(nproc 2>/dev/null || echo '?')
printf 'cpus      %s\n' "$cpus"

if [ -r /sys/fs/cgroup/memory.max ]; then
    lim=$(cat /sys/fs/cgroup/memory.max)
    [ "$lim" = "max" ] && lim="unlimited" || lim="$((lim / 1024 / 1024))MB"
    printf 'memory    %s\n' "$lim"
fi

printf 'disk      %s free on /work\n' "$(df -h /work 2>/dev/null | awk 'NR==2 {print $4}')"

if curl -fsS --max-time 2 -o /dev/null https://example.com 2>/dev/null; then
    printf 'network   egress reachable\n'
else
    printf 'network   no egress\n'
fi

printf 'tools     '
for t in git curl jq rg fd python3 node go cargo make gcc; do
    command -v "$t" >/dev/null 2>&1 && printf '%s ' "$t"
done
printf '\n'
