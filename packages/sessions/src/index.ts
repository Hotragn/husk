/**
 * @husk-ai/sessions -- a chat becomes a bot.
 *
 * Import a transcript (Claude Code, ChatGPT, Cursor, Gemini, markdown),
 * reconstruct the thread that actually happened, distil it into a
 * `DistilledAgent`, and write it out as a husk.yaml.
 */

export type { ChatLike } from './chat.js';
export * from './importers/index.js';
export * from './distill.js';
export * from './prompts.js';
export * from './serialize.js';
export * from './redactor.js';
export * from './scaffold.js';
export * from './distiller.js';
export * from './formatter.js';
