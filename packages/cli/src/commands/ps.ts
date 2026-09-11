import { parse } from '../args.js';
import { age, manager, stateColor } from '../lib/computers.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, { all: { type: 'boolean', short: 'a', default: false } }, 'ps');
  ui.configure(values);

  const all = await manager().list();
  const rows = values.all ? all : all.filter((c) => c.state !== 'stopped' && c.state !== 'destroyed');

  if (values.json) {
    ui.json(rows);
    return EXIT_OK;
  }

  if (!rows.length) {
    // An empty list is an answer, not an error. Exit 0 and point at the next step.
    ui.print(ui.dim(all.length ? 'no running computers (try --all)' : 'no computers yet'));
    ui.note(`${ui.dim('create one:')} husk up`);
    return EXIT_OK;
  }

  ui.print(
    ui.table(
      [
        { header: 'name', max: 24 },
        { header: 'id', max: 18 },
        { header: 'provider', max: 10 },
        { header: 'state', max: 10 },
        { header: 'workdir', max: 28 },
        { header: 'age', max: 6 },
      ],
      rows.map((c) => [c.name, c.id, String(c.provider), stateColor(c.state), c.workdir, age(c.createdAt)]),
    ),
  );

  return EXIT_OK;
}
