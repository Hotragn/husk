/**
 * @husk/sdk -- the typed client for the Husk control plane.
 *
 * Dependency-free: global `fetch`, and `@husk/core` for the shared contracts.
 * The endpoints it speaks are documented in `docs/API.md` and implemented in
 * `packages/server/src/routes/`. Where the two ever disagree, the routes win --
 * and `src/contract.test.ts` drives this client against the real server to keep
 * that from being a matter of opinion.
 */

export { HuskClient } from './client.js';
export type { CallOptions } from './client.js';
export { Http } from './http.js';
export type { FetchLike, HuskClientOptions, RequestOptions, WebSocketCtor, WebSocketLike } from './http.js';
export { openEventStream } from './events.js';
export type { EventStreamOptions, HuskEventStream } from './events.js';
export {
  errorFromEventFrame,
  errorFromResponse,
  isKnownErrorCode,
  transportError,
  KNOWN_CODES,
  SERVER_ERROR_CODES,
} from './errors.js';
export type { HuskWireErrorCode, ServerErrorCode, WireErrorBody } from './errors.js';
export { decodeEvents, parseFrame, readFrames } from './sse.js';
export type { SseFrame } from './sse.js';
export * from './types.js';

export { HuskError, isHuskError } from '@husk/core';
