import type { ChatRequest, ChatResponse } from '@husk/core';

/**
 * The only thing this package needs from a model.
 *
 * `ModelRouter` from @husk/models satisfies it, and so does a three-line stub in
 * a test, which is the point: nothing here opens a socket on its own.
 */
export interface ChatLike {
  chat(req: ChatRequest): Promise<ChatResponse>;
}
