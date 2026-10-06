export type WorkspaceErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'SOURCE_BLOCKED' | 'SOURCE_FAILED' | 'SOURCE_TIMEOUT' | 'STORE_BUSY' | 'STORE_CORRUPT' | 'LIMIT_EXCEEDED';

export class WorkspaceError extends Error {
  override readonly name = 'WorkspaceError';
  constructor(public readonly code: WorkspaceErrorCode, message: string, public readonly statusCode = 400) {
    super(message);
  }
}
