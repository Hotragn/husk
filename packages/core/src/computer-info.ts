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

/** A `;`-joined sequence, safe run bare or inside `command -v huskinfo ... || { <this>; }`. */
export const PROBE_COMPUTER_INFO = [
  'echo "os        $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)"',
  'echo "kernel    $(uname -r)"',
  'echo "arch      $(uname -m)"',
  'echo "user      $(id -un) (uid $(id -u))"',
  'echo "workdir   $(pwd)"',
  'echo "cpus      $(nproc 2>/dev/null || echo ?)"',
  `echo "memory    $(free -m 2>/dev/null | awk 'NR==2 {print $2"MB"} END {if (NR<2) print "?"}')"`,
  `echo "disk      $(df -h ${GUEST_WORKDIR} 2>/dev/null | awk 'NR==2 {print $4} END {if (NR<2) print "?"}') free on ${GUEST_WORKDIR}"`,
  // `(none)` rather than a blank: an empty value after the key reads as output
  // that got cut off, and "nothing here" is a real answer a model should get.
  `printf "tools     "; found=; for t in ${PROBED_TOOLS.join(' ')}; do command -v $t >/dev/null 2>&1 && { printf "%s " $t; found=1; }; done; [ -n "$found" ] || printf "(none)"; echo`,
].join('; ');
