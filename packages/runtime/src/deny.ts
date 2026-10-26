export interface CommandRule {
  pattern: RegExp;
  reason: string;
}

/**
 * A command only counts as *run* when it sits in command position: at the start
 * of the line, or right after a separator.
 *
 * Without this anchor, `grep -r "sudo" .` and `echo "shutdown" >> notes.txt` get
 * refused — and a deny list that cries wolf is a deny list users switch off.
 *
 * A lookbehind, so a match starts at the command and not at the separator
 * before it: that is the part an allow entry has to cover to lift the rule.
 */
const CMD = String.raw`(?<=^|[\n;|&]\s*|\$\(\s*|\bthen\s+|\bdo\s+)`;

function atCommandStart(body: string): RegExp {
  return new RegExp(CMD + body);
}

/**
 * Commands refused on every provider.
 *
 * The bar for inclusion is "no legitimate agent task needs this, and running it
 * by accident is unrecoverable". Merely risky things are left alone; an
 * over-eager deny list trains people to disable the deny list.
 */
export const DEFAULT_DENY: CommandRule[] = [
  {
    pattern: atCommandStart(String.raw`rm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+/(?:\s|$)`),
    reason: 'recursive delete of /',
  },
  { pattern: atCommandStart(String.raw`rm\s+(?:-[a-zA-Z]*\s+)*/(?:\s|$)`), reason: 'delete of /' },
  {
    pattern: atCommandStart(String.raw`(?:mkfs(?:\.\w+)?|mkswap|fdisk|parted|sgdisk)\b`),
    reason: 'disk formatting',
  },
  {
    pattern: atCommandStart(String.raw`dd\b[^|;&]*\bof=/dev/(?:sd|nvme|hd|disk)`),
    reason: 'raw write to a block device',
  },
  { pattern: atCommandStart(String.raw`(?:shutdown|reboot|halt|poweroff)\b`), reason: 'host power control' },
  { pattern: atCommandStart(String.raw`init\s+0\b`), reason: 'host power control' },
  {
    // `systemctl [options] stop <unit>`, and `service <name> stop`.
    pattern: atCommandStart(String.raw`(?:systemctl\s+(?:-\S+\s+)*|service\s+\S+\s+)(?:stop|disable|mask)\b`),
    reason: 'stopping host services',
  },
  { pattern: /(?:^|[^>])>>?\s*\/etc\/(?:passwd|shadow|sudoers|hosts)\b/, reason: 'overwriting a system file' },
  { pattern: atCommandStart(String.raw`chmod\s+(?:-[a-zA-Z]*\s+)*777\s+/(?:\s|$)`), reason: 'world-writable /' },
  { pattern: /\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/, reason: 'piping a remote script into a shell' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { pattern: atCommandStart(String.raw`sudo\b`), reason: 'privilege escalation' },
  {
    pattern: atCommandStart(String.raw`(?:nc|ncat|netcat)\b[^|;&]*\s-[a-zA-Z]*e[a-zA-Z]*\b`),
    reason: 'reverse shell',
  },
];
