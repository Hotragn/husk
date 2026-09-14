import { huskHome } from '@husk/core';
import { parse } from '../args.js';
import { VERSION } from '../version.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, {}, 'version');
  ui.configure(values);

  const info = {
    version: VERSION,
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    huskHome: huskHome(),
  };

  if (values.json) {
    ui.json(info);
    return EXIT_OK;
  }

  // Bare `husk version` prints one parseable line, because that is what a
  // release script greps for. Detail goes to stderr where it cannot break it.
  ui.print(info.version);
  ui.note(ui.dim(`node ${info.node} · ${info.platform} · state in ${info.huskHome}`));
  return EXIT_OK;
}
