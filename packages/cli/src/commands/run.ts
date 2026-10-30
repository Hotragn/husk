import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { HuskError, formatDuration, loadConfig, paths } from '@husk-ai/core';
import type { ApprovalMode, ChatRequest, ChatResponse, HuskSpec, RunResult, StreamEvent } from '@husk-ai/core';
import type { AgentRunEvent, ApprovalRequest, RouterLike } from '@husk-ai/agent';
import { UsageError, parse, parseChoice, parseCount,
  parseAmount, required } from '../args.js';
import { manager } from '../lib/computers.js';
import { orientBriefly } from '../lib/first-run.js';
import { resolveModel } from '../lib/models.js';
import { confirm, interactive, readPipedStdin } from '../lib/prompt.js';
import { loadSpec } from '../lib/yaml.js';
import { interruptSignal, wasInterrupted } from '../signal.js';
import * as ui from '../ui.js';
import { EXIT_ERROR, EXIT_OK, EXIT_SIGINT } from '../exit.js';

const APPROVAL_MODES = ['auto', 'ask', 'readonly'] as const;

/**
 * Run an agent and show the work.
 *
 * Watching an agent is most of the value. A wall of silence followed by a
 * paragraph gives a user no way to tell a stuck run from a slow one, and no
 * chance to hit Ctrl-C before it does something expensive -- so tokens stream,
 * every tool call is announced before it runs, and shell output is relayed live.
 */
export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(
    argv,
    {
      model: { type: 'string' },
      'max-steps': { type: 'string' },
      'max-cost': { type: 'string' },
      approve: { type: 'string' },
      'no-computer': { type: 'boolean', default: false },
      var: { type: 'string', multiple: true },
    },
    'run',
  );
  ui.configure(values);
  orientBriefly('the agent gets a computer on its first tool call; `husk ps` shows it');

  const ref = required(positionals, 0, 'husk.yaml|name', 'run');
  const spec = await locateSpec(ref);

  const prompt = positionals.slice(1).join(' ') || (await readPipedStdin())?.trim();
  if (!prompt) {
    throw new UsageError(
      `nothing to do — give it a prompt:\n  husk run ${ref} "summarise /work/notes.md"\n  echo "hello" | husk run ${ref}`,
      'run',
    );
  }

  const approvalMode: ApprovalMode =
    parseChoice(values.approve as string | undefined, APPROVAL_MODES, '--approve', 'run') ??
    spec.guardrails.approvalMode;

  if (spec.engine.type !== 'builtin' && approvalMode !== 'auto') {
    throw new UsageError(`the ${spec.engine.type} engine runs Husk's tools without asking; --approve ${approvalMode} needs the builtin engine`, 'run');
  }
  if (approvalMode === 'ask' && !interactive()) {
    throw new UsageError('--approve ask needs a terminal to ask on; use auto or readonly in a script', 'run');
  }

  // Every flag is validated before anything happens. Parsing these inline in the
  // `agent.run({...})` call meant a typo'd --max-cost surfaced only after the
  // model was resolved and the header printed -- and, worse, `Number('abc')` is
  // NaN, so `projected > NaN` is false and the spend ceiling quietly vanished.
  const maxSteps = parseCount(values['max-steps'] as string | undefined, '--max-steps', 'run') ?? spec.limits.maxSteps;
  const maxCostUsd =
    parseAmount(values['max-cost'] as string | undefined, '--max-cost', 'run') ?? spec.limits.maxCostUsd;
  const vars = parseVars(values.var as string[] | undefined);
  // This machine's settings: its model aliases, and the router's per-call ceiling.
  const config = loadConfig();

  // The person's own Claude Code or Codex runs it, on its own login and model: nothing of Husk's to resolve.
  if (spec.engine.type !== 'builtin') {
    const engine = spec.engine.type;
    if (values['max-steps'] !== undefined) ui.warn(`--max-steps does not apply to the ${engine} engine; --max-cost and limits.timeoutSec do`);
    const ran = values['no-computer'] === true ? { ...spec, computer: { ...spec.computer, enabled: false } } : spec;
    const tools = ran.computer.enabled && ran.tools.length > 0;
    if (!values.json) {
      ui.note(
        ui.fields([
          ['husk', `${ui.bold(spec.name)} ${ui.dim(spec.description || '')}`],
          ['engine', spec.engine.resume ? `${engine} ${ui.dim(`continuing chat ${spec.engine.resume}`)}` : engine],
          ['tools', tools ? "Husk's, on its computer" : ui.dim('none')],
        ]),
      );
      ui.note('');
    }
    const { CliAgent } = await import('@husk-ai/agent');
    const started = Date.now();
    const result = await new CliAgent({ spec: ran }).run({
      input: prompt,
      ...(values.model ? { model: values.model as string } : {}),
      maxCostUsd,
      timeoutSec: spec.limits.timeoutSec,
      signal: interruptSignal(),
      vars,
      onEvent: values.json ? () => {} : renderer(),
    });
    return finish(result, spec, { started, json: values.json === true, wantsComputer: tools, who: engine });
  }

  // Resolve up front so an unreachable model fails before anything is created,
  // and so the header can name what will actually run.
  //
  // A husk that declares `fallbackModels` has already said what to do when the
  // primary is missing, so refusing to start would be ignoring the instruction.
  // Walk the chain, and only give up when nothing in it is reachable.
  const requested = (values.model as string | undefined) ?? spec.model;
  const chain = [requested, ...spec.fallbackModels];
  let resolved: Awaited<ReturnType<typeof resolveModel>> | undefined;
  let downgradedFrom: string | undefined;
  let lastErr: unknown;
  for (const candidate of chain) {
    try {
      resolved = await resolveModel(candidate, config.modelAliases, Math.min(maxCostUsd, config.maxCostUsd));
      if (candidate !== requested) downgradedFrom = requested;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!resolved) throw lastErr;
  if (downgradedFrom && !values.json) {
    ui.warn(`${downgradedFrom} is not reachable — falling back to ${resolved.info.id}`);
  }

  // Execution goes through the real router, not a pinned provider. Pinning was
  // why `fallbackModels` was validated, stored, and then never read on this
  // path: a husk that declared a fallback got a hard failure instead of one.
  // The router also emits a warning on every downgrade, so a quietly weaker
  // answer is impossible.
  const { ModelRouter } = await import('@husk-ai/models');
  const modelRouter = new ModelRouter({ maxCostUsd: Math.min(maxCostUsd, config.maxCostUsd), aliases: config.modelAliases });
  const fallbacks = spec.fallbackModels;
  const router: RouterLike = {
    chat: (req: ChatRequest): Promise<ChatResponse> => modelRouter.chat({ ...req, fallbacks }),
    stream: (req: ChatRequest): AsyncIterable<StreamEvent> => modelRouter.stream({ ...req, fallbacks }),
    getModelInfo: async (model: string) => (await modelRouter.getModelInfo(model)) ?? resolved.info,
  };

  const wantsComputer = spec.computer.enabled && values['no-computer'] !== true;

  const { Agent } = await import('@husk-ai/agent');
  const agent = new Agent({
    spec: wantsComputer ? spec : { ...spec, computer: { ...spec.computer, enabled: false } },
    router,
    // Lazy by design: the machine is created on the first tool call that needs
    // one, so a husk that only talks never pays for a container.
    ...(wantsComputer ? { computers: manager() } : {}),
    computerKey: `husk:${spec.name}`,
  });

  const tools = agent.listTools();

  if (!values.json) {
    ui.note(
      ui.fields([
        ['husk', `${ui.bold(spec.name)} ${ui.dim(spec.description || '')}`],
        ['model', resolved.info.id],
        ['computer', wantsComputer ? ui.dim('created on first use') : ui.dim('none')],
        ['tools', tools.length ? tools.map((t) => t.name).join(', ') : ui.dim('none')],
        ['approvals', approvalMode === 'auto' ? approvalMode : ui.yellow(approvalMode)],
      ]),
    );
    ui.note('');
  }

  const render = values.json ? () => {} : renderer();
  const started = Date.now();

  const result = await agent.run({
    input: prompt,
    model: resolved.info.id,
    maxSteps,
    maxCostUsd,
    maxTokens: spec.limits.maxTokens,
    timeoutSec: spec.limits.timeoutSec,
    approvalMode,
    signal: interruptSignal(),
    vars,
    onApproval: askOperator,
    onEvent: render,
  });
  return finish(result, spec, { started, json: values.json === true, wantsComputer, who: resolved.info.id, quiet: 'small local models often do this with tools attached — try a larger model, or --approve readonly to see its plan' });
}

/** What a finished run says, and the exit code it ends with. */
function finish(
  result: RunResult,
  spec: HuskSpec,
  opts: { started: number; json: boolean; wantsComputer: boolean; who: string; quiet?: string },
): number {
  const { started, wantsComputer } = opts;
  if (opts.json) {
    ui.json(result);
  } else {
    // A run that produced nothing looks identical to a run that is still going.
    // Saying so beats leaving someone staring at an empty terminal wondering
    // whether husk swallowed the answer.
    if (!result.text.trim() && result.stopReason === 'complete') {
      ui.warn(`${opts.who} finished without saying anything and without calling a tool`);
      if (opts.quiet) ui.hint(opts.quiet);
    }
    // Piped, stdout carries the answer alone, as `--json`'s `text` has it: each
    // step's text went to stderr as it came.
    if (!ui.options().stdoutTty) {
      if (result.text.trim()) ui.print(result.text.replace(/\n+$/, ''));
    } else {
      ui.print();
    }
    ui.note(
      ui.dim(
        `${result.steps} step${result.steps === 1 ? '' : 's'} · ${formatDuration(Date.now() - started)} · ` +
          `${result.usage.inputTokens + result.usage.outputTokens} tokens` +
          (result.usage.costUsd ? ` · $${result.usage.costUsd.toFixed(4)}` : ' · free'),
      ),
    );
  }

  // Ctrl-C stops the run; it does not destroy the machine. The filesystem is
  // usually the thing the user wanted to keep.
  if (wasInterrupted() || result.stopReason === 'aborted') {
    if (wantsComputer) ui.note(ui.dim(`the computer is still up — \`husk ps\` to see it, \`husk rm ${spec.name}\` to remove it`));
    return EXIT_SIGINT;
  }

  if (result.stopReason === 'error') {
    // Under --json the result above is stdout's one document, and its `error` says why.
    if (opts.json) return EXIT_ERROR;
    throw new HuskError('E_TOOL_ERROR', result.error?.message ?? 'the run failed', {
      hint: 'run with --debug for the trace, or --approve readonly to see what it wanted to do',
    });
  }

  if (result.stopReason === 'step_limit') {
    ui.warn(`stopped at the ${result.steps}-step ceiling — raise it with --max-steps if the task really needs more`);
    return EXIT_ERROR;
  }

  if (result.stopReason === 'budget' || result.stopReason === 'timeout') {
    ui.warn(`stopped: ${result.stopReason}`);
    ui.hint(
      result.stopReason === 'budget'
        ? 'raise limits.maxCostUsd in husk.yaml, or pass --max-cost'
        : 'raise limits.timeoutSec in husk.yaml',
    );
    return EXIT_ERROR;
  }

  return EXIT_OK;
}

/** A file path, or a husk registered under ~/.husk/husks/<name>/husk.yaml. */
async function locateSpec(ref: string): Promise<HuskSpec> {
  const asFile = resolvePath(ref);
  if (existsSync(asFile)) return loadSpec(asFile);

  const registered = join(paths().husks, ref, 'husk.yaml');
  if (existsSync(registered)) return loadSpec(registered);

  throw new HuskError('E_SPEC_INVALID', `no husk named "${ref}", and no file at ${asFile}`, {
    hint: 'run `husk init` to create one, or `husk distill <transcript>` to generate one from a chat',
  });
}

function parseVars(pairs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs ?? []) {
    const i = p.indexOf('=');
    const name = i > 0 ? p.slice(0, i) : '';
    // A placeholder is `{{word}}`: a name with any other character could never fill one.
    if (!/^\w+$/.test(name)) throw new UsageError(`--var takes name=value, the name letters, digits and _ only: ${p}`, 'run');
    out[name] = p.slice(i + 1);
  }
  return out;
}

/**
 * The human in `--approve ask`.
 *
 * `Agent` denies when no approver is wired, which is the right default -- so
 * this is the only thing standing between a model and a dangerous call, and it
 * defaults to no.
 */
async function askOperator(req: ApprovalRequest): Promise<boolean> {
  ui.note('');
  ui.note(`${ui.yellow('⚠')} ${req.tool ? `the agent wants to run ${ui.bold(req.tool)}` : 'the agent is asking'}`);
  ui.note(`  ${ui.cyan(ui.truncate(req.prompt.replace(/\s+/g, ' '), 160))}`);
  if (req.args && Object.keys(req.args).length) {
    for (const [k, v] of Object.entries(req.args).slice(0, 4)) {
      ui.note(`  ${ui.dim(k + ':')} ${ui.truncate(String(v).replace(/\s+/g, ' '), 140)}`);
    }
  }
  return confirm('allow it?', { defaultYes: false });
}

/**
 * Turn run events into something readable.
 *
 * On a terminal the model's text streams to stdout; everything else -- steps,
 * tool calls, warnings -- goes to stderr. Piped, the text streams to stderr too,
 * and `finish` writes the answer alone to stdout, so `husk run ... > answer.txt`
 * captures the answer and nothing else, not the narration before a tool call.
 */
function renderer(): (event: AgentRunEvent) => void {
  let streaming = false;
  let toolStreaming = false;
  const text = ui.options().stdoutTty ? process.stdout : process.stderr;

  const endText = () => {
    if (streaming) {
      text.write('\n');
      streaming = false;
    }
  };
  const endToolStream = () => {
    if (toolStreaming) {
      process.stderr.write('\n');
      toolStreaming = false;
    }
  };

  return (event: AgentRunEvent) => {
    switch (event.type) {
      case 'step_start':
        endText();
        endToolStream();
        ui.note(ui.dim(`── step ${event.step}`));
        break;

      case 'text_delta':
        endToolStream();
        streaming = true;
        text.write(event.text);
        break;

      case 'thinking_delta':
        break;

      case 'tool_start':
        endText();
        ui.note(`${ui.cyan('→')} ${ui.bold(event.call.name)} ${ui.dim(preview(event.call.args))}`);
        break;

      // Live shell output. Indented and on stderr so it is obviously the
      // machine talking, not the model.
      case 'tool_delta':
        endText();
        toolStreaming = true;
        ui.relay(ui.dim(event.text.replace(/\n(?!$)/g, '\n  ')));
        break;

      case 'tool_end': {
        endToolStream();
        const glyph = event.isError ? ui.red('✗') : ui.green('✓');
        const first = event.output.split('\n').find((l) => l.trim()) ?? '';
        ui.note(`${glyph} ${ui.dim(`${formatDuration(event.durationMs)}  ${ui.truncate(first, 100)}`)}`);
        break;
      }

      case 'tool_denied':
        endText();
        endToolStream();
        ui.note(`${ui.yellow('⊘')} ${event.call.name} ${ui.dim(event.reason)}`);
        break;

      case 'computer_ready':
        ui.note(ui.dim(`computer ready: ${event.computerId} (${event.provider})`));
        break;

      case 'warning':
        endText();
        endToolStream();
        ui.warn(event.message);
        break;

      case 'error':
        endText();
        endToolStream();
        ui.fail(event.error.message);
        break;

      case 'run_end':
        endText();
        endToolStream();
        break;

      default:
        break;
    }
  };
}

function preview(args: Record<string, unknown>): string {
  const value = args.command ?? args.path ?? args.url ?? JSON.stringify(args);
  return ui.truncate(String(value).replace(/\s+/g, ' '), 90);
}
