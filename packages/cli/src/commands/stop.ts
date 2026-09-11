import { required, parse } from '../args.js';
import { resolve } from '../lib/computers.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {}, 'stop');
  ui.configure(values);

  const computer = await resolve(required(positionals, 0, 'name|id', 'stop'));
  await computer.stop();
  const info = await computer.refresh();

  if (values.json) ui.json(info);
  else ui.print(`${ui.green('✓')} stopped ${ui.bold(info.name)} ${ui.dim('— the filesystem is kept; `husk start` brings it back')}`);

  return EXIT_OK;
}
