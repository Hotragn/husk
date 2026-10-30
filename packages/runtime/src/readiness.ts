import { HuskError } from '@husk-ai/core';
import type { Computer } from '@husk-ai/core';

/** Resume the same computer so a reconnect keeps its workspace and provider. */
export async function ensureRunning(computer: Computer): Promise<Computer> {
  let info = await computer.refresh();
  if (info.state === 'stopped') {
    await computer.start();
    info = await computer.refresh();
  }
  if (info.state !== 'running') {
    throw new HuskError('E_COMPUTER_FAILED', `computer ${computer.id} is ${info.state}`, {
      hint: 'run `husk doctor` and check the computer before retrying; its workspace has not been replaced',
    });
  }
  return computer;
}
