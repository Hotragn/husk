/**
 * What a person pastes into their chat so the chat sets Husk up itself: one
 * `husk setup` line (the same flags the Connect page uses), a restart, and the
 * first thing to try. A chat that cannot run commands is told to hand the line
 * to the person instead. `app` undefined means every chat app on the machine.
 */
export function setupPrompt(app?: { id: string; name: string }): string {
  const apps = app ? app.id : 'all';
  const name = app ? app.name : 'my chat apps';
  return [
    'Set up Husk for me, so you get a computer of your own for tasks: a terminal and a real browser, kept apart from my files.',
    '',
    '1. Run this in a terminal:',
    `   npx -y @husk-ai/cli@latest setup --computer auto --apps ${apps} --yes`,
    `   It picks the safest computer this machine can run (a Docker container if Docker is installed) and adds Husk to ${name}. If you can't run terminal commands, show me that line and I'll run it.`,
    `2. Tell me to restart ${name} so the Husk tools load.`,
    '3. Suggest I install the Husk app from https://github.com/Hotragn/husk/releases/latest. It shows your computer in a small window, and I can take over any time.',
    '',
    'After the restart: call computer_info, open https://example.com in the browser, and tell me what you see.',
  ].join('\n');
}
