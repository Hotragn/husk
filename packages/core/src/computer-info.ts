/**
 * What `computer_info` runs on a machine with no `huskinfo`.
 *
 * The images in `sandbox/` ship `huskinfo`. The public images every flavor
 * resolves to do not, so this is the path almost every computer takes -- and it
 * had drifted into two answers. `@husk-ai/mcp` probed for installed tools and
 * `@husk-ai/agent` did not, so one tool name reported different facts depending
 * on which entry point the caller came through, and nothing surfaced that.
 *
 * It lives in core because both callers need it and neither may import the
 * other: `agent` and `mcp` sit on the same side of the dependency graph.
 *
 * Field order and column width match `huskinfo`'s own output. A model that has
 * learned one shape should not have to learn a second one.
 */

/**
 * Probed with `command -v` rather than read from a package manager. The question
 * behind `computer_info` is "can I run this", which is exactly what `command -v`
 * answers -- and it answers it on an image carrying no package database at all.
 */
export const PROBED_TOOLS = [
  'git',
  'curl',
  'jq',
  'rg',
  'python3',
  'node',
  'go',
  'cargo',
  'make',
  'gcc',
] as const;

/** Matches GUEST_ROOT in `@husk-ai/runtime`, which sits above core and cannot be imported here. */
const GUEST_WORKDIR = '/work';

/**
 * A container's /proc files can describe the host, so finite cgroup limits take
 * precedence when they are smaller. cgroup v2 is the current default; the v1
 * paths keep the probe useful on older hosts. This intentionally reads only the
 * cgroup namespace root; resolving ancestor limits is a separate hierarchy walk.
 * Fractional CPU is kept to six significant digits and memory retains the
 * existing whole-MB display so both computer_info entry points stay compatible.
 */
const PROBE_CPUS = [
  'host_cpus=$(nproc 2>/dev/null || true)',
  'cpu_quota=',
  'cpu_period=',
  'if [ -r /sys/fs/cgroup/cpu.max ]; then read cpu_quota cpu_period < /sys/fs/cgroup/cpu.max || true; elif [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ] && [ -r /sys/fs/cgroup/cpu/cpu.cfs_period_us ]; then cpu_quota=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us) || true; cpu_period=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us) || true; elif [ -r /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us ] && [ -r /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us ]; then cpu_quota=$(cat /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us) || true; cpu_period=$(cat /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us) || true; fi',
  `cpus=$(awk -v host="$host_cpus" -v quota="$cpu_quota" -v period="$cpu_period" 'BEGIN { host_ok = host ~ /^[0-9]+([.][0-9]+)?$/ && host > 0; limit_ok = quota ~ /^[0-9]+$/ && period ~ /^[0-9]+$/ && period > 0 && quota > 0; if (limit_ok && (!host_ok || quota / period < host)) printf "%.6g\\n", quota / period; else if (host_ok) print host; else print "?" }')`,
  'echo "cpus      $cpus"',
].join('; ');

const PROBE_MEMORY = [
  `host_memory=$(awk '/^MemTotal:/ {printf "%.0f", $2 * 1024; exit}' /proc/meminfo 2>/dev/null) || true`,
  'memory_limit=',
  'memory_source=',
  'if [ -r /sys/fs/cgroup/memory.max ]; then memory_limit=$(cat /sys/fs/cgroup/memory.max) || true; memory_source=v2; elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then memory_limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes) || true; memory_source=v1; fi',
  // v1 represents unlimited with a huge page-aligned integer. Treating values
  // at or above 2^60 as unbounded avoids advertising exabytes on old kernels.
  `memory=$(awk -v host="$host_memory" -v limit="$memory_limit" -v source="$memory_source" 'BEGIN { host_ok = host ~ /^[0-9]+$/; limit_ok = limit ~ /^[0-9]+$/ && !(source == "v1" && limit >= 1152921504606846976); if (limit_ok && (!host_ok || limit < host)) bytes = limit; else if (host_ok) bytes = host; else { print "?"; exit } printf "%.0fMB\\n", int(bytes / 1048576) }')`,
  'echo "memory    $memory"',
].join('; ');

/** A `;`-joined sequence, safe run bare or inside `command -v huskinfo ... || { <this>; }`. */
export const PROBE_COMPUTER_INFO = [
  'echo "os        $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)"',
  'echo "kernel    $(uname -r)"',
  'echo "arch      $(uname -m)"',
  'echo "user      $(id -un) (uid $(id -u))"',
  'echo "workdir   $(pwd)"',
  PROBE_CPUS,
  PROBE_MEMORY,
  `echo "disk      $(df -h ${GUEST_WORKDIR} 2>/dev/null | awk 'NR==2 {print $4} END {if (NR<2) print "?"}') free on ${GUEST_WORKDIR}"`,
  // `(none)` rather than a blank: an empty value after the key reads as output
  // that got cut off, and "nothing here" is a real answer a model should get.
  `printf "tools     "; found=; for t in ${PROBED_TOOLS.join(' ')}; do command -v $t >/dev/null 2>&1 && { printf "%s " $t; found=1; }; done; [ -n "$found" ] || printf "(none)"; echo`,
].join('; ');
