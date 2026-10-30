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

host_cpus=$(nproc 2>/dev/null || true)
cpu_quota=
cpu_period=
if [ -r /sys/fs/cgroup/cpu.max ]; then
    read cpu_quota cpu_period < /sys/fs/cgroup/cpu.max || true
elif [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ] && [ -r /sys/fs/cgroup/cpu/cpu.cfs_period_us ]; then
    cpu_quota=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us) || true
    cpu_period=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us) || true
elif [ -r /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us ] && [ -r /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us ]; then
    cpu_quota=$(cat /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us) || true
    cpu_period=$(cat /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us) || true
fi
cpus=$(awk -v host="$host_cpus" -v quota="$cpu_quota" -v period="$cpu_period" 'BEGIN {
    host_ok = host ~ /^[0-9]+([.][0-9]+)?$/ && host > 0
    limit_ok = quota ~ /^[0-9]+$/ && period ~ /^[0-9]+$/ && period > 0 && quota > 0
    if (limit_ok && (!host_ok || quota / period < host)) printf "%.6g\n", quota / period
    else if (host_ok) print host
    else print "?"
}')
printf 'cpus      %s\n' "$cpus"

host_memory=$(awk '/^MemTotal:/ {printf "%.0f", $2 * 1024; exit}' /proc/meminfo 2>/dev/null) || true
memory_limit=
memory_source=
if [ -r /sys/fs/cgroup/memory.max ]; then
    memory_limit=$(cat /sys/fs/cgroup/memory.max) || true
    memory_source=v2
elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    memory_limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes) || true
    memory_source=v1
fi
# cgroup v1 represents unlimited with a huge page-aligned integer. Values at
# or above 2^60 are not useful resource limits and must not be shown as exabytes.
memory=$(awk -v host="$host_memory" -v limit="$memory_limit" -v source="$memory_source" 'BEGIN {
    host_ok = host ~ /^[0-9]+$/
    limit_ok = limit ~ /^[0-9]+$/ && !(source == "v1" && limit >= 1152921504606846976)
    if (limit_ok && (!host_ok || limit < host)) bytes = limit
    else if (host_ok) bytes = host
    else { print "?"; exit }
    printf "%.0fMB\n", int(bytes / 1048576)
}')
printf 'memory    %s\n' "$memory"

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
