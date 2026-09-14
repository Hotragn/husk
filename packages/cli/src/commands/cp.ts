import { stat } from 'node:fs/promises';
import { basename, resolve as resolvePath } from 'node:path';
import { HuskError, formatBytes } from '@husk-ai/core';
import { UsageError, parse, required, splitRemote } from '../args.js';
import { resolve } from '../lib/computers.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

/**
 * Copy files in or out.
 *
 * `name:/path` on either side, `scp`-style, because that is the notation anyone
 * who has used a remote machine already knows. The only subtlety is Windows:
 * `C:\data\x.csv` is indistinguishable from a remote reference by shape alone,
 * so a one-character prefix is always a drive letter. No computer is named `C`.
 */
export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {}, 'cp');
  ui.configure(values);

  const rawSrc = required(positionals, 0, 'src', 'cp');
  const rawDst = required(positionals, 1, 'dst', 'cp');

  const src = splitRemote(rawSrc);
  const dst = splitRemote(rawDst);

  if (src && dst) {
    throw new UsageError(
      'both sides name a computer — copy out to the host first, then back in:\n' +
        `  husk cp ${rawSrc} ./tmpfile && husk cp ./tmpfile ${rawDst}`,
      'cp',
    );
  }

  if (!src && !dst) {
    throw new UsageError(
      `neither side names a computer — use \`cp\` from your shell, or write one side as name:/path\n` +
        `  husk cp ${rawSrc} <computer>:/work/${basename(rawDst)}`,
      'cp',
    );
  }

  if (src) {
    const computer = await resolve(src.name);
    const target = resolvePath(rawDst);
    const spin = ui.spinner(`copying ${src.name}:${src.path} → ${target}`);
    try {
      await computer.download(src.path, target);
    } finally {
      spin.stop();
    }
    const size = await stat(target).then((s) => s.size).catch(() => undefined);
    return report(values.json === true, {
      direction: 'download',
      from: `${src.name}:${src.path}`,
      to: target,
      bytes: size,
    });
  }

  const remote = dst as { name: string; path: string };
  const source = resolvePath(rawSrc);
  const info = await stat(source).catch(() => null);
  if (!info) {
    throw new HuskError('E_FS_DENIED', `no such file or directory: ${source}`, {
      hint: 'check the path — the local side of a `husk cp` is resolved against your current directory',
    });
  }

  const computer = await resolve(remote.name);
  // `cp ./x.txt box:/work/` should land at /work/x.txt, the way scp behaves.
  const target = remote.path.endsWith('/') ? `${remote.path}${basename(source)}` : remote.path;

  const spin = ui.spinner(`copying ${source} → ${remote.name}:${target}`);
  try {
    await computer.upload(source, target);
  } finally {
    spin.stop();
  }

  return report(values.json === true, {
    direction: 'upload',
    from: source,
    to: `${remote.name}:${target}`,
    bytes: info.isDirectory() ? undefined : info.size,
  });
}

function report(json: boolean, result: { direction: string; from: string; to: string; bytes?: number }): number {
  if (json) {
    ui.json(result);
    return EXIT_OK;
  }
  const size = result.bytes === undefined ? '' : ui.dim(`  ${formatBytes(result.bytes)}`);
  ui.print(`${ui.green('✓')} ${result.from} ${ui.dim('→')} ${result.to}${size}`);
  return EXIT_OK;
}
