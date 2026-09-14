/**
 * @husk-ai/cli -- the `husk` binary.
 *
 * The executable is `dist/bin.js`. This module exists so the CLI's testable
 * parts can be imported without running it.
 */

export { main, findSubcommand } from './bin.js';
export { VERSION } from './version.js';
export { UsageError, parse, splitRemote, splitRest, parseMemory } from './args.js';
export { COMMANDS, commandHelp, findCommand, suggest, topLevelHelp } from './help.js';
export { renderError } from './render-error.js';
export * as ui from './ui.js';
export { EXIT_ERROR, EXIT_OK, EXIT_SIGINT, EXIT_USAGE } from './exit.js';
