import { bold, dim, cyan, gray } from './ui.js';

/**
 * Help is the documentation. Almost nobody reads a wiki; everybody types
 * `--help`. So every entry gets a one-line summary, its flags, and at least one
 * example that can be copied and run as-is.
 */

export interface HelpEntry {
  name: string;
  summary: string;
  usage: string;
  group: 'computers' | 'agents' | 'chats' | 'system';
  details?: string;
  flags?: Array<[string, string]>;
  examples: string[];
}

export const COMMANDS: HelpEntry[] = [
  {
    name: 'onboard',
    group: 'system',
    summary: 'Guided setup — run this first',
    usage: 'husk onboard [--yes] [--json]',
    details:
      'Five steps: what this machine gives you and how isolated it really is, a throwaway\n'
      + 'computer created and destroyed in front of you, the shortest route to a model if you\n'
      + 'have none, the three places people reach a husk from, and one command to run next.\n\n'
      + 'It never asks for an API key. husk reads credentials from the environment and does not\n'
      + 'store them, so this prints the export line and re-checks instead. With no terminal it\n'
      + 'prints the whole path as text rather than waiting for an answer.',
    flags: [
      ['--yes', 'do not ask; run the check even without a terminal'],
      ['--skip-checks', 'do not create the throwaway computer'],
      ['--json', 'the same decisions as a machine-readable plan'],
    ],
    examples: ['husk onboard', 'husk onboard --json | jq .next'],
  },
  {
    name: 'doctor',
    group: 'system',
    summary: 'Show exactly what this machine can and cannot do',
    usage: 'husk doctor [--json]',
    details:
      'Every computer provider with its availability, isolation, and what to do about it;\nevery model provider; what husk would pick right now; and any warnings.\nThis is the first thing to run when something is confusing.',
    flags: [['--json', 'machine-readable report']],
    examples: ['husk doctor', 'husk doctor --json | jq .selection'],
  },
  {
    name: 'up',
    group: 'computers',
    summary: 'Create a Linux computer',
    usage: 'husk up [name] [flags]',
    details: 'With no name, husk generates one. The machine is lazy: nothing runs in it until you exec.',
    flags: [
      ['--provider <p>', 'docker | podman | local | ssh | fly (default: best available)'],
      ['--flavor <f>', 'base | python | node | full (default: base)'],
      ['--memory <size>', 'e.g. 2g, 512m'],
      ['--cpus <n>', 'cpu allocation'],
      ['--network <mode>', 'none | egress | full (default: egress)'],
      ['--packages <p,..>', 'install these in the machine at create time; repeatable'],
      ['--persist', 'keep the filesystem across restarts'],
      ['--json', 'print the computer record instead of the summary'],
    ],
    examples: [
      'husk up',
      'husk up scratch --provider local',
      'husk up web --packages curl',
      'husk up builder --flavor python --memory 2g --network full',
    ],
  },
  {
    name: 'ps',
    group: 'computers',
    summary: 'List your computers',
    usage: 'husk ps [--all] [--json]',
    flags: [
      ['--all, -a', 'include stopped machines'],
      ['--json', 'print the full computer records'],
    ],
    examples: ['husk ps', 'husk ps --json | jq -r ".[].name"'],
  },
  {
    name: 'rm',
    group: 'computers',
    summary: 'Destroy a computer and its filesystem',
    usage: 'husk rm <name|id> [--all] [--yes]',
    details: 'Destructive and not recoverable. Asks first unless --yes is given or --json is set.',
    flags: [
      ['--all', 'destroy every computer'],
      ['--yes, -y', 'skip the confirmation'],
    ],
    examples: ['husk rm scratch', 'husk rm --all --yes'],
  },
  {
    name: 'stop',
    group: 'computers',
    summary: 'Stop a computer without destroying it',
    usage: 'husk stop <name|id>',
    examples: ['husk stop scratch'],
  },
  {
    name: 'start',
    group: 'computers',
    summary: 'Start a stopped computer',
    usage: 'husk start <name|id>',
    examples: ['husk start scratch'],
  },
  {
    name: 'exec',
    group: 'computers',
    summary: 'Run a command inside a computer',
    usage: 'husk exec <name|id> -- <command...>',
    details:
      'stdout and stderr stream live, and husk exits with the command\'s own exit code --\nso `husk exec box -- test -f /work/x && echo yes` behaves the way you expect.\nEverything after `--` belongs to the command, flags included.',
    flags: [
      ['--cwd <path>', 'working directory inside the machine (default: /work)'],
      ['--timeout <sec>', 'kill the process tree after this long (default: 120)'],
      ['--env K=V', 'set an environment variable; repeatable'],
      ['--json', 'buffer and print the full result as JSON instead of streaming'],
    ],
    examples: [
      'husk exec scratch -- uname -sr',
      "husk exec scratch -- 'echo hi > /work/a.txt; cat /work/a.txt'",
      'husk exec scratch -- "echo hi > /work/a.txt; cat /work/a.txt"   # cmd.exe keeps single quotes',
      'husk exec scratch --json -- ls /work | jq .exitCode',
    ],
  },
  {
    name: 'shell',
    group: 'computers',
    summary: 'An interactive prompt against a computer',
    usage: 'husk shell <name|id>',
    details:
      'A readline loop, NOT a pty. Each line is a separate exec, so husk tracks `cd` for you,\nbut full-screen programs (vim, top, less) and anything that checks isatty will not work.\nUse `exit`, `quit`, or Ctrl-D to leave.',
    examples: ['husk shell scratch'],
  },
  {
    name: 'cp',
    group: 'computers',
    summary: 'Copy files in or out of a computer',
    usage: 'husk cp <src> <dst>',
    details:
      'Either side may be `name:/path`. A single-letter prefix is treated as a Windows drive,\nnot a computer, so C:\\data\\x.csv works as a local path.',
    examples: [
      'husk cp ./report.csv scratch:/work/report.csv',
      'husk cp scratch:/work/out.json ./out.json',
      'husk cp ./src scratch:/work/src',
    ],
  },
  {
    name: 'init',
    group: 'agents',
    summary: 'Scaffold a husk.yaml',
    usage: 'husk init [name] [--out husk.yaml] [--force]',
    details: 'Asks a few questions on a terminal. With --yes, or when piped, it writes sensible defaults.',
    flags: [
      ['--out <file>', 'where to write (default: husk.yaml)'],
      ['--force', 'overwrite an existing file'],
      ['--yes, -y', 'accept every default without asking'],
    ],
    examples: ['husk init', 'husk init support-bot --yes'],
  },
  {
    name: 'import',
    group: 'chats',
    summary: 'Find and import a chat transcript',
    usage: 'husk import [path] [--source <s>] [--pick <n>]',
    details:
      'With no path, husk searches the usual places (Claude Code, ChatGPT exports, Cursor,\nmarkdown in the current directory), lists what it found, and asks you to choose.',
    flags: [
      ['--source <s>', 'claude-code | chatgpt | cursor | gemini | markdown | universal'],
      ['--pick <n>', 'choose by number without being asked'],
      ['--limit <n>', 'how many candidates to list (default: 20)'],
      ['--json', 'print the discovered list, or the imported transcript'],
    ],
    examples: ['husk import', 'husk import --pick 1', 'husk import ./chat.md --source markdown'],
  },
  {
    name: 'distill',
    group: 'chats',
    summary: 'Turn a chat into a husk.yaml',
    usage: 'husk distill <transcript-id|path> [--out husk.yaml]',
    details:
      'Prints what it extracted and how confident it is. The heuristic path is free and needs\nno API key; --no-model forces it even when a model is configured.',
    flags: [
      ['--model <m>', 'model to distill with (default: auto)'],
      ['--no-model', 'force the free heuristic path'],
      ['--out <file>', 'where to write (default: husk.yaml)'],
      ['--name <n>', 'override the generated husk name'],
      ['--force', 'overwrite an existing file'],
      ['--json', 'print the distillation result'],
    ],
    examples: ['husk distill ./chat.md --no-model', 'husk distill tr_01hxyz --out support-bot.yaml'],
  },
  {
    name: 'run',
    group: 'agents',
    summary: 'Run an agent',
    usage: 'husk run <husk.yaml|name> [prompt] [flags]',
    details:
      'Streams the model\'s text and every tool call as it happens. Ctrl-C stops the run\ncleanly and leaves the computer alone -- nothing is destroyed.',
    flags: [
      ['--model <m>', 'override the spec\'s model'],
      ['--max-steps <n>', 'ceiling on tool-calling rounds'],
      ['--approve <mode>', 'auto | ask | readonly (default: from the spec)'],
      ['--no-computer', 'run without giving the agent a machine'],
      ['--json', 'print the run result instead of streaming'],
    ],
    examples: [
      'husk run husk.yaml "summarise /work/notes.md"',
      'husk run support-bot --approve ask',
      'husk run husk.yaml "list the files" --json | jq -r .text',
    ],
  },
  {
    name: 'serve',
    group: 'system',
    summary: 'Start the control plane and any bots the husk declares',
    usage: 'husk serve [--port 7377] [--host 127.0.0.1]',
    flags: [
      ['--port <n>', 'default: 7377'],
      ['--host <h>', 'default: 127.0.0.1 -- loopback only unless you change it'],
    ],
    examples: ['husk serve', 'husk serve --port 8080'],
  },
  {
    name: 'mcp',
    group: 'system',
    summary: 'Run the MCP server on stdio',
    usage: 'husk mcp',
    details:
      'This is what an MCP client launches. stdout is the protocol channel and carries\nnothing else; logs go to stderr.',
    examples: ['claude mcp add husk -- npx -y @husk-ai/mcp', 'husk mcp'],
  },
  {
    name: 'models',
    group: 'system',
    summary: 'List the models you can actually reach',
    usage: 'husk models [--all] [--json]',
    flags: [
      ['--all', 'include models from providers with no credentials'],
      ['--json', 'machine-readable list'],
    ],
    examples: ['husk models', 'husk models --json | jq -r ".[].id"'],
  },
  {
    name: 'validate',
    group: 'agents',
    summary: 'Check a husk.yaml',
    usage: 'husk validate [file]',
    details: 'Defaults to ./husk.yaml. Prints every problem at once, not just the first.',
    flags: [['--json', 'machine-readable result']],
    examples: ['husk validate', 'husk validate support-bot.yaml'],
  },
  {
    name: 'version',
    group: 'system',
    summary: 'Print the version',
    usage: 'husk version [--json]',
    examples: ['husk version'],
  },
  {
    name: 'help',
    group: 'system',
    summary: 'Show help for a command',
    usage: 'husk help [command]',
    examples: ['husk help exec'],
  },
];

const GROUPS: Array<{ key: HelpEntry['group']; title: string }> = [
  { key: 'computers', title: 'Computers' },
  { key: 'agents', title: 'Agents' },
  { key: 'chats', title: 'Chats' },
  { key: 'system', title: 'System' },
];

export function findCommand(name: string): HelpEntry | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/**
 * The overview.
 *
 * `firstRun` is passed in rather than read here: this module is pure so that
 * `husk --help` costs nothing, and a `statSync` on the state directory is
 * exactly the kind of thing that creeps into a hot path. The caller already
 * knows.
 *
 * On a first run the twenty-command wall is the wrong first thing to read, so
 * one line goes above it pointing at the command written for that moment.
 */
export function topLevelHelp(version: string, firstRun = false): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const out: string[] = [];

  out.push(`${bold('husk')} ${dim(version)} — give your agent a computer, and turn a chat into a bot.`);
  out.push('');
  if (firstRun) {
    out.push(`${bold('NEW HERE?')}  ${cyan('husk onboard')} ${dim('— five steps, nothing to sign up for, safe to re-run.')}`);
    out.push('');
  }
  out.push(`${bold('USAGE')}`);
  out.push(`  husk <command> [flags]`);
  out.push('');

  for (const group of GROUPS) {
    out.push(bold(group.title.toUpperCase()));
    for (const c of COMMANDS.filter((x) => x.group === group.key)) {
      out.push(`  ${cyan(c.name.padEnd(width))}  ${c.summary}`);
    }
    out.push('');
  }

  const globals: Array<[string, string]> = [
    ['--json', 'machine-readable output; the only thing on stdout'],
    ['-q, --quiet', 'errors only'],
    ['--no-color', 'plain text (also automatic when piped, and with NO_COLOR)'],
    ['--debug', 'full stack traces'],
    ['-h, --help', 'help for any command'],
  ];
  const flagWidth = Math.max(width, ...globals.map(([f]) => f.length));
  out.push(bold('GLOBAL FLAGS'));
  for (const [flag, desc] of globals) out.push(`  ${flag.padEnd(flagWidth)}  ${desc}`);
  out.push('');
  out.push(bold('GETTING STARTED'));
  out.push(`  ${gray('$')} husk onboard                     ${dim('# guided, start here')}`);
  out.push(`  ${gray('$')} husk doctor                      ${dim('# what can this machine do?')}`);
  out.push(`  ${gray('$')} husk up scratch                  ${dim('# a Linux box, free, no account')}`);
  out.push(`  ${gray('$')} husk exec scratch -- uname -sr   ${dim('# drive it')}`);
  out.push(`  ${gray('$')} husk rm scratch                  ${dim('# throw it away')}`);
  out.push('');
  out.push(dim('  Exit codes: 0 ok · 1 error · 2 usage · 130 interrupted.'));
  out.push(dim('  husk sends nothing anywhere except the model provider you configure.'));
  return out.join('\n');
}

export function commandHelp(entry: HelpEntry): string {
  const out: string[] = [];
  out.push(`${bold('husk ' + entry.name)} — ${entry.summary}`);
  out.push('');
  out.push(bold('USAGE'));
  out.push(`  ${entry.usage}`);

  if (entry.details) {
    out.push('');
    for (const line of entry.details.split('\n')) out.push(`  ${line}`);
  }

  if (entry.flags?.length) {
    const width = Math.max(...entry.flags.map(([f]) => f.length));
    out.push('');
    out.push(bold('FLAGS'));
    for (const [flag, desc] of entry.flags) out.push(`  ${cyan(flag.padEnd(width))}  ${desc}`);
  }

  out.push('');
  out.push(bold('EXAMPLES'));
  for (const ex of entry.examples) out.push(`  ${gray('$')} ${ex}`);
  out.push('');
  out.push(dim('  Global flags: --json --quiet --no-color --debug --help'));
  return out.join('\n');
}

/** Levenshtein-lite: good enough to catch a fat-fingered subcommand. */
export function suggest(input: string): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const c of COMMANDS) {
    const score = distance(input, c.name);
    if (score <= Math.max(2, Math.floor(c.name.length / 3)) && (!best || score < best.score)) {
      best = { name: c.name, score };
    }
  }
  return best?.name;
}

function distance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let carry = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j] as number;
      prev[j] = Math.min(
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + 1,
        carry + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      carry = temp;
    }
  }
  return prev[b.length] as number;
}
