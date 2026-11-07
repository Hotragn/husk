import { HuskError, readDaemonRecord } from '@husk-ai/core';
import { parse } from '../args.js';
import { EXIT_OK } from '../exit.js';
import { consoleLink } from '../lib/console-link.js';
import * as ui from '../ui.js';

/**
 * `husk console` -- a link that opens the console signed in, from the Husk
 * running on this machine. Its code works once, within ten minutes, so the link
 * is worthless to anyone who finds it later in scrollback, a log or history.
 */
export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, { json: { type: 'boolean' } }, 'console');
  ui.configure(values);
  const rec = readDaemonRecord();
  if (!rec) {
    throw new HuskError('E_CONFIG', 'no Husk is running on this machine', {
      hint: 'start it with `husk serve`, open the Husk app, or use Husk from a chat',
    });
  }
  const url = await consoleLink(rec);
  if (!url) {
    throw new HuskError('E_CONFIG', `the Husk at ${rec.url} gave no sign-in link`, {
      hint: 'it may be an older Husk, or not answering: restart it, or open the console from the Husk app',
    });
  }
  if (values.json) {
    ui.json({ url });
    return EXIT_OK;
  }
  ui.print(url);
  ui.note(ui.dim(rec.token ? '  works once, within 10 minutes; run `husk console` again for another' : '  this Husk needs no sign-in'));
  return EXIT_OK;
}
