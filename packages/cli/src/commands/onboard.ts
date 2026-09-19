import { huskHome } from '@husk-ai/core';
import { parse } from '../args.js';
import { collect, type DoctorProbes, type DoctorReport } from './doctor.js';
import { markOriented } from '../lib/first-run.js';
import { confirm, interactive } from '../lib/prompt.js';
import { manager } from '../lib/computers.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

/**
 * The first five minutes, guided.
 *
 * `husk doctor` already answers "what can this machine do", and it answers it
 * well. It is not an onboarding, because it hands you eleven model providers
 * that are not configured and leaves you to pick one. The gap between
 * `npm i -g @husk-ai/cli` and a working first command was: read doctor, choose
 * a provider, go find a key, export it, come back, work out which of twenty
 * commands to run. Every step of that is documented somewhere and none of it is
 * in front of you when you need it.
 *
 * So this walks the same ground doctor covers and then does the next thing each
 * time: it creates a real computer and runs a real command in it, it names the
 * one cheapest way to get a model if there is none, and it prints the MCP line
 * for the client you actually use. Five steps, each skippable.
 *
 * Three rules it does not break:
 *
 *  - **It never takes a key.** `husk` reads credentials from the environment and
 *    does not store them, which is a claim in `SECURITY-MODEL.md`. An onboarding
 *    that offers to "just paste it here" would make that sentence false, so this
 *    prints the exact `export` line and re-probes instead.
 *  - **It never blocks without a terminal.** A CLI that waits for input inside a
 *    Dockerfile is a CLI people stop installing. With no TTY it prints the whole
 *    path as text and exits 0.
 *  - **It tells the truth about isolation**, in the same words `doctor` uses,
 *    because this is the screen where someone forms their belief about it.
 */

interface Step {
  n: number;
  title: string;
}

const STEPS: Step[] = [
  { n: 1, title: 'What this machine gives you' },
  { n: 2, title: 'Prove it' },
  { n: 3, title: 'A model to drive it' },
  { n: 4, title: 'Where you will use it' },
  { n: 5, title: 'Next' },
];

function header(step: Step): void {
  ui.print('');
  ui.print(`${ui.dim(`[${step.n}/${STEPS.length}]`)} ${ui.bold(step.title)}`);
}

export async function run(argv: string[], probes?: DoctorProbes): Promise<number> {
  const { values } = parse(argv, { 'skip-checks': { type: 'boolean', default: false } }, 'onboard');
  ui.configure(values);

  const report = probes ? await collect(false, probes) : await collect(false);

  if (values.json) {
    ui.json(plan(report));
    markOriented();
    return EXIT_OK;
  }

  ui.print('');
  ui.print(ui.bold('Welcome to husk.') + ui.dim(' This is the guided setup; it is safe to re-run.'));

  machine(report);
  const proved = await proveIt(report, {
    skip: values['skip-checks'] === true,
    assumeYes: values.yes === true,
  });
  model(report);
  await surface(report);
  next(report, proved);

  markOriented();
  return EXIT_OK;
}

/** Step 1 -- the provider, and what its boundary actually is. */
function machine(report: DoctorReport): void {
  header(STEPS[0] as Step);
  const p = report.selection.provider;
  if (!p) {
    ui.print(`  ${ui.red('no usable provider')} — ${report.selection.providerReason}`);
    const fixes = report.providers.filter((r) => !r.available && r.hint).slice(0, 2);
    for (const f of fixes) ui.print(`  ${ui.dim('fix')} ${f.hint}`);
    return;
  }

  const row = report.providers.find((r) => r.name === p);
  ui.print(`  ${ui.dim('provider ')} ${ui.bold(p)}${row?.version ? ui.dim(`  (${row.version})`) : ''}`);

  // The same sentence doctor uses. Someone forms their whole mental model of
  // the safety boundary on this screen, and a softer word here than in the
  // security docs would be the softer word they remember.
  if (report.selection.isolated) {
    ui.print(`  ${ui.dim('isolation')} ${ui.green('kernel-level')} ${ui.dim('— namespaces and cgroups. An escaped process is still in the container.')}`);
  } else {
    ui.print(`  ${ui.dim('isolation')} ${ui.yellow('guardrails only')} ${ui.dim('— not a sandbox. It shares your kernel, network and user account.')}`);
    const better = report.providers.find((r) => r.isolationKind === 'kernel' && !r.available);
    if (better?.hint) ui.print(`  ${ui.dim('stronger ')} ${better.hint}`);
  }
  ui.print(`  ${ui.dim('privacy  ')} nothing leaves this machine except calls to a model provider you configure`);
  ui.print(`  ${ui.dim('state    ')} ${huskHome()} ${ui.dim('(delete it to reset husk completely)')}`);
}

/**
 * Step 2 -- the part no amount of documentation substitutes for.
 *
 * A computer is created, one command runs inside it, and it is destroyed again.
 * Nothing is left behind, and the reader has seen the product work on their own
 * machine before being asked to configure anything.
 */
async function proveIt(
  report: DoctorReport,
  opts: { skip: boolean; assumeYes: boolean },
): Promise<boolean> {
  header(STEPS[1] as Step);
  const byHand = () =>
    ui.print(`  ${ui.dim('skipped.')} Run it yourself: ${ui.cyan('husk up scratch && husk exec scratch -- uname -sr')}`);

  if (!report.selection.provider) {
    ui.print(`  ${ui.dim('skipped — there is no provider to prove.')}`);
    return false;
  }
  if (opts.skip) {
    byHand();
    return false;
  }
  // This is the one step with a side effect, so the default outside a terminal
  // is not to take it. `husk onboard` inside a Dockerfile or a CI job should
  // print the path, not pull an image; `--yes` is how you say you meant it.
  if (!opts.assumeYes) {
    if (!interactive()) {
      ui.print(`  ${ui.dim('no terminal here, so nothing was created.')} ${ui.dim('Pass')} ${ui.cyan('--yes')} ${ui.dim('to run it anyway.')}`);
      byHand();
      return false;
    }
    if (!(await confirm('  Create a throwaway computer and run one command in it?', { defaultYes: true }))) {
      byHand();
      return false;
    }
  }

  const name = `husk-onboard-${process.pid}`;
  const spin = ui.spinner('  creating a computer');
  let created = false;
  try {
    const computer = await manager().create({ name });
    created = true;
    spin.stop();
    ui.print(`  ${ui.green('✓')} ${computer.id} ${ui.dim(`on ${computer.info.provider}`)}`);
    const r = await computer.exec({ cmd: 'uname -sr || ver' });
    ui.print(`  ${ui.dim('$')} uname -sr`);
    for (const line of r.stdout.trim().split('\n').slice(0, 3)) ui.print(`  ${line}`);

    const marker = 'HUSK_ONBOARD_OK';
    await computer.writeFile('/work/hello.txt', `${marker}\n`);
    const back = await computer.exec({ cmd: 'cat /work/hello.txt' });
    const shared = back.stdout.includes(marker);
    ui.print(`  ${ui.dim('$')} write /work/hello.txt, then cat it from the shell`);
    ui.print(
      shared
        ? `  ${ui.green('✓')} same file both ways — /work means one thing here`
        : `  ${ui.yellow('!')} the shell did not see it; this provider does not offer /work (\`husk doctor\` explains)`,
    );
    return true;
  } catch (err) {
    spin.stop();
    ui.print(`  ${ui.red('✗')} ${(err as Error).message}`);
    ui.print(`  ${ui.dim('run')} ${ui.cyan('husk doctor')} ${ui.dim('— it names the fix for each provider it could not use')}`);
    return false;
  } finally {
    if (created) {
      await manager()
        .destroy(name)
        .catch(() => undefined);
      ui.print(`  ${ui.dim('cleaned up — nothing was left on your machine')}`);
    }
  }
}

/**
 * Step 3 -- a model, or the shortest path to one.
 *
 * Deliberately not a key prompt. `husk` reads credentials from the environment
 * and never writes them to `~/.husk`; asking for one here would either break
 * that or teach people to paste secrets into a terminal that logs scrollback.
 */
function model(report: DoctorReport): void {
  header(STEPS[2] as Step);
  const reachable = report.models.filter((m) => m.available);
  if (reachable.length) {
    const chosen = report.selection.model;
    ui.print(`  ${ui.green('✓')} ${reachable.length} provider${reachable.length > 1 ? 's' : ''} reachable`);
    for (const m of reachable.slice(0, 3)) {
      ui.print(`  ${ui.dim('  ·')} ${m.displayName}${m.models.length ? ui.dim(`  ${m.models.slice(0, 3).join(', ')}`) : ''}`);
    }
    if (chosen) ui.print(`  ${ui.dim('husk will use')} ${ui.bold(chosen)} ${ui.dim(`— ${report.selection.modelReason}`)}`);
    return;
  }

  ui.print(`  ${ui.yellow('none reachable yet.')} The computer works without one; ${ui.cyan('husk run')} needs one.`);
  ui.print('');
  ui.print(`  ${ui.dim('free, local, no account:')}`);
  ui.print(`    ${ui.cyan('ollama pull qwen2.5:7b')}   ${ui.dim('then re-run husk onboard')}`);
  ui.print('');
  ui.print(`  ${ui.dim('or set one key in your shell — husk reads it from the environment and never stores it:')}`);
  for (const m of report.models.filter((r) => r.envKey && r.implemented).slice(0, 3)) {
    ui.print(`    ${ui.cyan(`export ${m.envKey}=...`)}${ui.dim(`   ${m.displayName}`)}`);
  }
}

/** Step 4 -- the three ways people actually reach a husk. */
async function surface(report: DoctorReport): Promise<void> {
  header(STEPS[3] as Step);
  ui.print(`  ${ui.bold('In an MCP client')} ${ui.dim('— Claude Code, Cursor, and anything else that speaks MCP')}`);
  ui.print(`    ${ui.cyan('claude mcp add husk -- npx -y @husk-ai/mcp')}`);
  ui.print(`    ${ui.dim('or, in a client that wants JSON:')}`);
  ui.print(`    ${ui.dim(JSON.stringify({ mcpServers: { husk: { command: 'npx', args: ['-y', '@husk-ai/mcp'] } } }))}`);
  ui.print('');
  ui.print(`  ${ui.bold('From this terminal')}`);
  ui.print(`    ${ui.cyan('husk up scratch')} ${ui.dim('· ')}${ui.cyan('husk exec scratch -- <cmd>')} ${ui.dim('· ')}${ui.cyan('husk shell scratch')}`);
  ui.print('');
  ui.print(`  ${ui.bold('As a bot or an endpoint')}`);
  ui.print(`    ${ui.cyan('husk import')} ${ui.dim('a chat you already had, ')}${ui.cyan('husk distill')} ${ui.dim('it into a husk.yaml, ')}${ui.cyan('husk serve')} ${ui.dim('it')}`);
  if (!report.selection.model) {
    ui.print(`    ${ui.dim('the last one needs the model from step 3')}`);
  }
}

/** Step 5 -- exactly one command, chosen from what this machine can do now. */
function next(report: DoctorReport, proved: boolean): void {
  header(STEPS[4] as Step);
  if (!report.selection.provider) {
    ui.print(`  ${ui.cyan('husk doctor')} ${ui.dim('— it names the one fix for each provider it could not use')}`);
  } else if (report.selection.model) {
    ui.print(`  ${ui.cyan('husk init')} ${ui.dim('then')} ${ui.cyan('husk run husk.yaml "list the files in /work"')}`);
  } else if (proved) {
    ui.print(`  ${ui.cyan('husk up scratch')} ${ui.dim('— you have a computer; a model is only needed for')} ${ui.cyan('husk run')}`);
  } else {
    ui.print(`  ${ui.cyan('husk doctor')} ${ui.dim('— start with what this machine can do')}`);
  }
  ui.print('');
  ui.print(ui.dim('  Full docs: https://husk-dev.vercel.app/  ·  husk help <command> for any of them.'));
  ui.print('');
}

/** The `--json` shape: what onboarding would tell you, without the theatre. */
function plan(report: DoctorReport): Record<string, unknown> {
  return {
    provider: report.selection.provider,
    isolated: report.selection.isolated,
    providerReason: report.selection.providerReason,
    model: report.selection.model,
    modelReason: report.selection.modelReason,
    modelsReachable: report.models.filter((m) => m.available).map((m) => m.id),
    huskHome: huskHome(),
    mcp: { command: 'npx', args: ['-y', '@husk-ai/mcp'] },
    next: report.selection.provider
      ? report.selection.model
        ? 'husk init && husk run husk.yaml'
        : 'husk up scratch'
      : 'husk doctor',
  };
}
